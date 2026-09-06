use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use axum::{
    Extension, Router,
    extract::{
        FromRequestParts, Request, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{Extensions, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use tokio::{
    sync::{Semaphore, mpsc, oneshot},
    time::{MissedTickBehavior, Sleep, interval_at},
};

use crate::{
    live::{
        CloseClass, InstantiateError, LiveEndpoint, LiveGuard, LiveProjection, LiveRouter,
        LiveSocketConfig, MAX_CONTROL_MESSAGE_BYTES, MAX_INBOUND_CONTROLS, MAX_OUTBOUND_BYTES,
        MAX_OUTBOUND_MESSAGES, ProjectionError, SUBPROTOCOL,
        codec::{ControlError, ControlMessage, parse_control},
        endpoint::offered_subprotocol,
    },
    no_store_status_response,
};

#[derive(Clone)]
struct LiveDeps<S, G> {
    endpoint: LiveEndpoint,
    config: LiveSocketConfig,
    router: Arc<LiveRouter<S>>,
    guard: G,
}

/// Mount the live WebSocket upgrade at the configured endpoint path.
pub fn service<S, G>(
    endpoint: LiveEndpoint,
    config: LiveSocketConfig,
    router: LiveRouter<S>,
    guard: G,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard + Clone,
{
    let path = endpoint.path().to_owned();
    let deps = LiveDeps {
        endpoint,
        config,
        router: Arc::new(router),
        guard,
    };
    Router::new()
        .route(&path, get(upgrade_handler::<S, G>))
        .layer(Extension(deps))
}

async fn upgrade_handler<S, G>(
    State(host): State<S>,
    Extension(deps): Extension<LiveDeps<S, G>>,
    request: Request,
) -> Response
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard + Clone,
{
    if !deps.endpoint.origin_matches(request.headers()) {
        return no_store_status_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !offered_subprotocol(request.headers(), SUBPROTOCOL) {
        return no_store_status_response(StatusCode::BAD_REQUEST, "Bad request");
    }
    let (mut parts, _body) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &host).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => {
            return no_store_status_response(rejection.into_response().status(), "Bad request");
        }
    };
    let extensions = parts.extensions;
    let LiveDeps {
        endpoint: _,
        config,
        router,
        guard,
    } = deps;
    upgrade
        .protocols([SUBPROTOCOL])
        .max_message_size(MAX_CONTROL_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            run_session(socket, host, router, guard, config, extensions).await;
        })
}

pub(crate) enum Incoming {
    Text(String),
    Binary,
    Pong,
    Close,
}

pub(crate) trait FrameSocket: Send {
    fn send_binary(&mut self, bytes: Vec<u8>) -> impl Future<Output = Result<(), ()>> + Send;
    fn send_ping(&mut self) -> impl Future<Output = Result<(), ()>> + Send;
    fn close(&mut self, class: CloseClass) -> impl Future<Output = Result<(), ()>> + Send;
    fn recv(&mut self) -> impl Future<Output = Option<Incoming>> + Send;
}

impl FrameSocket for WebSocket {
    async fn send_binary(&mut self, bytes: Vec<u8>) -> Result<(), ()> {
        self.send(Message::Binary(bytes.into()))
            .await
            .map_err(|_| ())
    }

    async fn send_ping(&mut self) -> Result<(), ()> {
        self.send(Message::Ping(axum::body::Bytes::new()))
            .await
            .map_err(|_| ())
    }

    async fn close(&mut self, class: CloseClass) -> Result<(), ()> {
        self.send(Message::Close(Some(CloseFrame {
            code: class.code(),
            reason: "".into(),
        })))
        .await
        .map_err(|_| ())
    }

    async fn recv(&mut self) -> Option<Incoming> {
        loop {
            match WebSocket::recv(self).await? {
                Ok(Message::Text(text)) => return Some(Incoming::Text(text.to_string())),
                Ok(Message::Binary(_)) => return Some(Incoming::Binary),
                Ok(Message::Pong(_)) => return Some(Incoming::Pong),
                Ok(Message::Ping(_)) => continue,
                Ok(Message::Close(_)) => return Some(Incoming::Close),
                Err(_) => return None,
            }
        }
    }
}

struct OutboundPatch {
    bytes: Vec<u8>,
}

struct SubscriptionTask {
    cancel: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl SubscriptionTask {
    fn request_cancel(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
    }

    async fn join(&mut self) {
        self.request_cancel();
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

// Each admitted subscription sends at most one failure. Notification must not wait for session cleanup.
#[derive(Clone)]
struct Termination {
    tx: mpsc::UnboundedSender<CloseClass>,
}

impl Termination {
    fn pair() -> (Self, mpsc::UnboundedReceiver<CloseClass>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }

    fn request(&self, class: CloseClass) {
        let _ = self.tx.send(class);
    }
}

struct ListenerGuard {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl ListenerGuard {
    fn spawn<F>(future: F) -> Self
    where
        F: Future<Output = ()> + Send + 'static,
    {
        Self {
            handle: Some(tokio::spawn(future)),
        }
    }

    async fn abort_and_wait(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        // Nested invalidation polling must stop if the projection task is dropped.
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

enum SessionEnd {
    Silent,
    Close(CloseClass),
}

enum Outgoing {
    Binary(Vec<u8>),
    Ping,
}

async fn send_bounded<Sock: FrameSocket>(
    socket: &mut Sock,
    lease: &mut Pin<&mut Sleep>,
    heartbeat_period: Duration,
    outgoing: Outgoing,
) -> Result<(), SessionEnd> {
    let write = async {
        match outgoing {
            Outgoing::Binary(bytes) => socket.send_binary(bytes).await,
            Outgoing::Ping => socket.send_ping().await,
        }
    };
    tokio::select! {
        biased;
        _ = lease.as_mut() => Err(SessionEnd::Close(CloseClass::LeaseExpiry)),
        result = write => match result {
            Ok(()) => Ok(()),
            Err(()) => Err(SessionEnd::Close(CloseClass::Retryable)),
        },
        _ = tokio::time::sleep(heartbeat_period) => Err(SessionEnd::Close(CloseClass::Retryable)),
    }
}

async fn close_best_effort<Sock: FrameSocket>(socket: &mut Sock, class: CloseClass) {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(crate::live::HEARTBEAT_SECONDS)) => {}
        _ = socket.close(class) => {}
    }
}

pub(crate) async fn run_session<S, G, Sock>(
    mut socket: Sock,
    host: S,
    router: Arc<LiveRouter<S>>,
    guard: G,
    config: LiveSocketConfig,
    upgrade_extensions: Extensions,
) where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard,
    Sock: FrameSocket,
{
    // The advertised lease covers bind. A ready deadline must win over later work.
    let lease = tokio::time::sleep(Duration::from_secs(crate::live::LEASE_SECONDS));
    tokio::pin!(lease);

    let connection = tokio::select! {
        biased;
        _ = &mut lease => {
            close_best_effort(&mut socket, CloseClass::LeaseExpiry).await;
            return;
        }
        result = guard.bind(&upgrade_extensions) => match result {
            Ok(connection) => Arc::new(connection),
            Err(failure) => {
                close_best_effort(&mut socket, failure.close_class()).await;
                return;
            }
        }
    };
    let heartbeat_period = Duration::from_secs(crate::live::HEARTBEAT_SECONDS);
    let mut heartbeat = interval_at(
        tokio::time::Instant::now() + heartbeat_period,
        heartbeat_period,
    );
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<OutboundPatch>(config.max_subscriptions);
    let (termination, mut close_rx) = Termination::pair();
    let (retired_tx, mut retired_rx) = mpsc::unbounded_channel::<u32>();
    let (revalidate_tx, mut revalidate_rx) = mpsc::unbounded_channel::<Result<(), CloseClass>>();
    let refreshes = Arc::new(Semaphore::new(config.max_concurrent_refreshes));
    let mut subscriptions: HashMap<u32, SubscriptionTask> = HashMap::new();
    let mut heartbeat_revalidate: Option<SubscriptionTask> = None;
    let mut used_ids = HashSet::new();
    let mut inbound_controls = 0usize;
    let mut outbound_messages = 0usize;
    let mut outbound_bytes = 0usize;
    let mut pong_outstanding = false;

    let end = loop {
        tokio::select! {
            biased;
            _ = &mut lease => break SessionEnd::Close(CloseClass::LeaseExpiry),
            class = close_rx.recv() => {
                break SessionEnd::Close(class.unwrap_or(CloseClass::Retryable));
            }
            result = revalidate_rx.recv() => {
                if let Some(mut task) = heartbeat_revalidate.take() {
                    task.join().await;
                }
                match result {
                    Some(Err(class)) => break SessionEnd::Close(class),
                    Some(Ok(())) => {}
                    None => break SessionEnd::Close(CloseClass::Retryable),
                }
            }
            retired = retired_rx.recv() => {
                if let Some(id) = retired
                    && let Some(mut task) = subscriptions.remove(&id)
                {
                    task.join().await;
                }
            }
            _ = heartbeat.tick() => {
                if pong_outstanding {
                    break SessionEnd::Close(CloseClass::Retryable);
                }
                if outbound_messages >= MAX_OUTBOUND_MESSAGES {
                    break SessionEnd::Close(CloseClass::LeaseExpiry);
                }
                outbound_messages += 1;
                if let Err(end) = send_bounded(
                    &mut socket,
                    &mut lease,
                    heartbeat_period,
                    Outgoing::Ping,
                )
                .await
                {
                    break end;
                }
                pong_outstanding = true;
                if heartbeat_revalidate.is_none() {
                    heartbeat_revalidate = Some(spawn_revalidate(
                        guard.clone(),
                        connection.clone(),
                        revalidate_tx.clone(),
                    ));
                }
            }
            outbound = outbound_rx.recv() => {
                let Some(patch) = outbound else {
                    break SessionEnd::Close(CloseClass::Retryable);
                };
                if outbound_messages >= MAX_OUTBOUND_MESSAGES
                    || outbound_bytes.saturating_add(patch.bytes.len()) > MAX_OUTBOUND_BYTES
                {
                    break SessionEnd::Close(CloseClass::LeaseExpiry);
                }
                outbound_messages += 1;
                outbound_bytes += patch.bytes.len();
                if let Err(end) = send_bounded(
                    &mut socket,
                    &mut lease,
                    heartbeat_period,
                    Outgoing::Binary(patch.bytes),
                )
                .await
                {
                    break end;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    None | Some(Incoming::Close) => break SessionEnd::Silent,
                    Some(Incoming::Pong) => pong_outstanding = false,
                    Some(Incoming::Binary) => {
                        break SessionEnd::Close(CloseClass::Protocol);
                    }
                    Some(Incoming::Text(text)) => {
                        if inbound_controls >= MAX_INBOUND_CONTROLS {
                            break SessionEnd::Close(CloseClass::LeaseExpiry);
                        }
                        if text.len() > MAX_CONTROL_MESSAGE_BYTES {
                            break SessionEnd::Close(CloseClass::Protocol);
                        }
                        inbound_controls += 1;
                        match parse_control(&text) {
                            Err(ControlError::Protocol) => {
                                break SessionEnd::Close(CloseClass::Protocol);
                            }
                            Ok(ControlMessage::Terminal) => break SessionEnd::Silent,
                            Ok(ControlMessage::Unsubscribe { id }) => {
                                if let Some(mut task) = subscriptions.remove(&id) {
                                    task.join().await;
                                }
                            }
                            Ok(ControlMessage::Subscribe { id, url }) => {
                                if !used_ids.insert(id) {
                                    break SessionEnd::Close(CloseClass::Protocol);
                                }
                                if subscriptions.len() >= config.max_subscriptions {
                                    break SessionEnd::Close(CloseClass::Protocol);
                                }
                                let task = spawn_subscription(SpawnRequest {
                                    id,
                                    url,
                                    host: host.clone(),
                                    router: router.clone(),
                                    guard: guard.clone(),
                                    extensions: upgrade_extensions.clone(),
                                    connection: connection.clone(),
                                    refreshes: refreshes.clone(),
                                    outbound: outbound_tx.clone(),
                                    termination: termination.clone(),
                                    retired: retired_tx.clone(),
                                });
                                subscriptions.insert(id, task);
                            }
                        }
                    }
                }
            }
        }
    };

    let mut tasks = Vec::with_capacity(subscriptions.len() + 1);
    if let Some(task) = heartbeat_revalidate.take() {
        tasks.push(task);
    }
    for (_, task) in subscriptions {
        tasks.push(task);
    }
    for task in &mut tasks {
        task.request_cancel();
    }
    for task in &mut tasks {
        task.join().await;
    }
    drop(connection);
    if let SessionEnd::Close(class) = end {
        close_best_effort(&mut socket, class).await;
    }
}

enum SubscribeStart {
    Ignore,
    Close(CloseClass),
}

struct ProjectionRuntime<C> {
    connection: Arc<C>,
    refreshes: Arc<Semaphore>,
    outbound: mpsc::Sender<OutboundPatch>,
    termination: Termination,
    retired: mpsc::UnboundedSender<u32>,
}

struct SpawnRequest<S, G: LiveGuard> {
    id: u32,
    url: String,
    host: S,
    router: Arc<LiveRouter<S>>,
    guard: G,
    extensions: Extensions,
    connection: Arc<G::Connection>,
    refreshes: Arc<Semaphore>,
    outbound: mpsc::Sender<OutboundPatch>,
    termination: Termination,
    retired: mpsc::UnboundedSender<u32>,
}

fn spawn_subscription<S, G>(request: SpawnRequest<S, G>) -> SubscriptionTask
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard,
{
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let join = tokio::spawn(run_subscription(request, cancel_rx));
    SubscriptionTask {
        cancel: Some(cancel_tx),
        join: Some(join),
    }
}

fn spawn_revalidate<G>(
    guard: G,
    connection: Arc<G::Connection>,
    results: mpsc::UnboundedSender<Result<(), CloseClass>>,
) -> SubscriptionTask
where
    G: LiveGuard,
{
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = cancel_rx => {}
            result = guard.revalidate(connection.as_ref()) => {
                let _ = results.send(match result {
                    Ok(_) => Ok(()),
                    Err(failure) => Err(failure.close_class()),
                });
            }
        }
    });
    SubscriptionTask {
        cancel: Some(cancel_tx),
        join: Some(join),
    }
}

async fn run_subscription<S, G>(request: SpawnRequest<S, G>, mut cancel: oneshot::Receiver<()>)
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard,
{
    let projection = tokio::select! {
        biased;
        _ = &mut cancel => return,
        result = instantiate(&request) => match result {
            Ok(projection) => projection,
            Err(SubscribeStart::Ignore) => {
                let _ = request.retired.send(request.id);
                return;
            }
            Err(SubscribeStart::Close(class)) => {
                request.termination.request(class);
                let _ = request.retired.send(request.id);
                return;
            }
        }
    };
    let SpawnRequest {
        id,
        guard,
        connection,
        refreshes,
        outbound,
        termination,
        retired,
        ..
    } = request;
    let runtime = ProjectionRuntime {
        connection,
        refreshes,
        outbound,
        termination,
        retired,
    };
    run_projection(id, projection, guard, runtime, cancel).await;
}

async fn instantiate<S, G>(
    request: &SpawnRequest<S, G>,
) -> Result<LiveProjection<G::Context>, SubscribeStart>
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard,
{
    let context = match request.guard.revalidate(request.connection.as_ref()).await {
        Ok(context) => context,
        Err(failure) => return Err(SubscribeStart::Close(failure.close_class())),
    };
    match request
        .router
        .dispatch(
            &request.host,
            &request.url,
            request.extensions.clone(),
            context,
        )
        .await
    {
        Ok(projection) => Ok(projection),
        Err(
            InstantiateError::Unregistered | InstantiateError::Invalid | InstantiateError::Retire,
        ) => Err(SubscribeStart::Ignore),
    }
}

async fn run_projection<C, G>(
    id: u32,
    mut projection: LiveProjection<C>,
    guard: G,
    runtime: ProjectionRuntime<G::Connection>,
    mut cancel: oneshot::Receiver<()>,
) where
    C: Clone + Send + Sync + 'static,
    G: LiveGuard<Context = C>,
{
    let mut invalidation = std::mem::replace(
        &mut projection.invalidation,
        Box::pin(futures_util::stream::pending()),
    );
    let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);
    let (ready_tx, ready_rx) = oneshot::channel();
    let mut listener = ListenerGuard::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        while let Some(()) = futures_util::future::poll_fn(|context| {
            let event = invalidation.as_mut().poll_next(context);
            if let Some(ready_tx) = ready_tx.take() {
                let _ = ready_tx.send(());
            }
            event
        })
        .await
        {
            let _ = notify_tx.try_send(());
        }
    });

    let refresh = projection.refresh.clone();
    let result = async {
        tokio::select! {
            biased;
            _ = &mut cancel => return Ok(()),
            _ = ready_rx => {}
        }
        if refresh_once(
            id,
            refresh.as_ref(),
            &guard,
            runtime.connection.as_ref(),
            &runtime.refreshes,
            &runtime.outbound,
            &mut cancel,
        )
        .await?
        {
            return Ok(());
        }
        loop {
            tokio::select! {
                _ = &mut cancel => return Ok(()),
                notified = notify_rx.recv() => {
                    if notified.is_none() {
                        return Ok(());
                    }
                    while notify_rx.try_recv().is_ok() {}
                    if refresh_once(
                        id,
                        refresh.as_ref(),
                        &guard,
                        runtime.connection.as_ref(),
                        &runtime.refreshes,
                        &runtime.outbound,
                        &mut cancel,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                }
            }
        }
    }
    .await;

    listener.abort_and_wait().await;
    drop(projection.lifetime);
    if let Err(class) = result {
        runtime.termination.request(class);
    }
    let _ = runtime.retired.send(id);
}

async fn refresh_once<C, G>(
    id: u32,
    refresh: &(dyn Fn(C) -> crate::live::RefreshFuture + Send + Sync),
    guard: &G,
    connection: &G::Connection,
    refreshes: &Semaphore,
    outbound: &mpsc::Sender<OutboundPatch>,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<bool, CloseClass>
where
    C: Clone + Send + Sync + 'static,
    G: LiveGuard<Context = C>,
{
    let permit = tokio::select! {
        _ = &mut *cancel => return Ok(true),
        permit = refreshes.acquire() => permit.map_err(|_| CloseClass::Retryable)?,
    };
    let context = tokio::select! {
        _ = &mut *cancel => return Ok(true),
        result = guard.revalidate(connection) => match result {
            Ok(context) => context,
            Err(failure) => return Err(failure.close_class()),
        },
    };
    let patch = tokio::select! {
        _ = &mut *cancel => return Ok(true),
        patch = refresh(context) => patch,
    };
    drop(permit);
    let html = match patch {
        Ok(set) => match set.encode_live() {
            Ok(html) => html,
            Err(_) => return Ok(true),
        },
        Err(ProjectionError::Retire) => return Ok(true),
    };
    let bytes =
        crate::live::encode_patch_frame(id, &html).map_err(|_| CloseClass::Resynchronisation)?;
    tokio::select! {
        _ = &mut *cancel => Ok(true),
        sent = outbound.send(OutboundPatch { bytes }) => {
            sent.map_err(|_| CloseClass::Retryable)?;
            Ok(false)
        }
    }
}
