use std::{
    collections::{HashMap, HashSet},
    future::Future,
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
    time::{MissedTickBehavior, interval_at},
};

use crate::{
    live::{
        CloseClass, GuardFailure, InstantiateError, LiveEndpoint, LiveGuard, LiveProjection,
        LiveRouter, LiveSocketConfig, MAX_CONTROL_MESSAGE_BYTES, MAX_INBOUND_CONTROLS,
        MAX_OUTBOUND_BYTES, MAX_OUTBOUND_MESSAGES, ProjectionError, SUBPROTOCOL,
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
    cancel: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

enum SessionEnd {
    Silent,
    Close(CloseClass),
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
    let connection = match guard.bind(&upgrade_extensions).await {
        Ok(connection) => Arc::new(connection),
        Err(failure) => {
            let _ = socket.close(failure.close_class()).await;
            return;
        }
    };
    let heartbeat_period = Duration::from_secs(crate::live::HEARTBEAT_SECONDS);
    let mut heartbeat = interval_at(
        tokio::time::Instant::now() + heartbeat_period,
        heartbeat_period,
    );
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let lease = tokio::time::sleep(Duration::from_secs(crate::live::LEASE_SECONDS));
    tokio::pin!(lease);

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<OutboundPatch>(config.max_subscriptions);
    let (close_tx, mut close_rx) = mpsc::channel::<CloseClass>(1);
    let (retired_tx, mut retired_rx) = mpsc::unbounded_channel::<u32>();
    let refreshes = Arc::new(Semaphore::new(config.max_concurrent_refreshes));
    let mut subscriptions: HashMap<u32, SubscriptionTask> = HashMap::new();
    let mut used_ids = HashSet::new();
    let mut inbound_controls = 0usize;
    let mut outbound_messages = 0usize;
    let mut outbound_bytes = 0usize;
    let mut pong_outstanding = false;

    let end = loop {
        tokio::select! {
            _ = &mut lease => break SessionEnd::Close(CloseClass::LeaseExpiry),
            class = close_rx.recv() => {
                break SessionEnd::Close(class.unwrap_or(CloseClass::Retryable));
            }
            retired = retired_rx.recv() => {
                if let Some(id) = retired
                    && let Some(task) = subscriptions.remove(&id)
                {
                    let _ = task.join.await;
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
                if socket.send_ping().await.is_err() {
                    break SessionEnd::Close(CloseClass::Retryable);
                }
                pong_outstanding = true;
                match guard.revalidate(connection.as_ref()).await {
                    Ok(_) => {}
                    Err(failure) => break SessionEnd::Close(failure.close_class()),
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
                if socket.send_binary(patch.bytes).await.is_err() {
                    break SessionEnd::Close(CloseClass::Retryable);
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
                                if let Some(task) = subscriptions.remove(&id) {
                                    let _ = task.cancel.send(());
                                    let _ = task.join.await;
                                }
                            }
                            Ok(ControlMessage::Subscribe { id, url }) => {
                                if !used_ids.insert(id) {
                                    break SessionEnd::Close(CloseClass::Protocol);
                                }
                                if subscriptions.len() >= config.max_subscriptions {
                                    break SessionEnd::Close(CloseClass::Protocol);
                                }
                                match spawn_subscription(SpawnRequest {
                                    id,
                                    url,
                                    host: host.clone(),
                                    router: router.clone(),
                                    guard: guard.clone(),
                                    extensions: upgrade_extensions.clone(),
                                    connection: connection.clone(),
                                    refreshes: refreshes.clone(),
                                    outbound: outbound_tx.clone(),
                                    close: close_tx.clone(),
                                    retired: retired_tx.clone(),
                                })
                                .await
                                {
                                    Ok(task) => {
                                        subscriptions.insert(id, task);
                                    }
                                    Err(SubscribeStart::Ignore) => {}
                                    Err(SubscribeStart::Close(class)) => {
                                        break SessionEnd::Close(class);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    let mut joins = Vec::with_capacity(subscriptions.len());
    for (_, task) in subscriptions {
        let _ = task.cancel.send(());
        joins.push(task.join);
    }
    for join in joins {
        let _ = join.await;
    }
    if let SessionEnd::Close(class) = end {
        let _ = socket.close(class).await;
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
    close: mpsc::Sender<CloseClass>,
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
    close: mpsc::Sender<CloseClass>,
    retired: mpsc::UnboundedSender<u32>,
}

async fn spawn_subscription<S, G>(
    request: SpawnRequest<S, G>,
) -> Result<SubscriptionTask, SubscribeStart>
where
    S: Clone + Send + Sync + 'static,
    G: LiveGuard,
{
    let SpawnRequest {
        id,
        url,
        host,
        router,
        guard,
        extensions,
        connection,
        refreshes,
        outbound,
        close,
        retired,
    } = request;
    let context = match guard.revalidate(connection.as_ref()).await {
        Ok(context) => context,
        Err(GuardFailure::Terminal) => return Err(SubscribeStart::Close(CloseClass::Terminal)),
        Err(GuardFailure::Retryable) => return Err(SubscribeStart::Close(CloseClass::Retryable)),
    };
    let projection = match router.dispatch(&host, &url, extensions, context).await {
        Ok(projection) => projection,
        Err(
            InstantiateError::Unregistered | InstantiateError::Invalid | InstantiateError::Retire,
        ) => {
            return Err(SubscribeStart::Ignore);
        }
    };
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let runtime = ProjectionRuntime {
        connection,
        refreshes,
        outbound,
        close,
        retired,
    };
    let join = tokio::spawn(run_projection(id, projection, guard, runtime, cancel_rx));
    Ok(SubscriptionTask {
        cancel: cancel_tx,
        join,
    })
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
    let listener = tokio::spawn(async move {
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
    let _ = ready_rx.await;

    let refresh = projection.refresh.clone();
    let result = async {
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

    listener.abort();
    drop(projection.lifetime);
    if let Err(class) = result {
        let _ = runtime.close.send(class).await;
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
