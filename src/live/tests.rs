use std::collections::HashMap;

use askama::Template;
use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Notify, broadcast, mpsc};
use tower::ServiceExt;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

use crate::{
    DomId, MAX_RESPONSE_BYTES, PatchSet, VERSION,
    live::{
        CLOSE_LEASE_EXPIRY, CLOSE_PROTOCOL, CLOSE_RESYNCHRONISATION, CLOSE_RETRYABLE,
        CLOSE_TERMINAL, CloseClass, DEFAULT_PATH, GuardFailure, HEARTBEAT_SECONDS, LEASE_SECONDS,
        LiveEndpoint, LiveGuard, LiveHarness, LiveProjection, LiveReject, LiveRouter,
        LiveSocketConfig, MAX_CONTROL_MESSAGE_BYTES, MAX_INBOUND_CONTROLS, MAX_OUTBOUND_BYTES,
        MAX_OUTBOUND_MESSAGES, MAX_PROJECTION_URL_BYTES, MAX_SUBSCRIPTIONS, RETRY_MAX_SECONDS,
        RETRY_MIN_SECONDS, SUBPROTOCOL, SUBSCRIPTION_HEADER_BYTES, SocketAdmission,
        broadcast_invalidations, decode_live_envelope, encode_patch_frame, service,
    },
};

#[derive(Template)]
#[template(source = "<p>{{ value }}</p>", ext = "html")]
struct Content<'a> {
    value: &'a str,
}

#[derive(Clone)]
struct UnitGuard;

impl LiveGuard for UnitGuard {
    type Connection = ();
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        Ok(())
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}

fn children_patch(target: &str, value: &str) -> PatchSet {
    PatchSet::new()
        .with_children(DomId::new(target).unwrap(), &Content { value })
        .unwrap()
}

#[test]
fn matches_the_shared_live_fixture() {
    let fixture: Value = serde_json::from_str(include_str!("../../protocol-v1.json")).unwrap();
    assert_eq!(fixture["version"], VERSION);
    assert_eq!(
        fixture["request"]["kinds"],
        serde_json::json!(["navigation", "patch"])
    );
    assert_eq!(
        fixture["transfer"]["kinds"],
        serde_json::json!(["complete", "stream"])
    );
    assert_eq!(fixture["live"]["subprotocol"], SUBPROTOCOL);
    assert_eq!(fixture["live"]["defaultPath"], DEFAULT_PATH);
    assert_eq!(fixture["live"]["negotiateExtensions"], false);
    assert_eq!(
        fixture["live"]["control"]["types"],
        serde_json::json!(["subscribe", "unsubscribe", "terminal"])
    );
    assert_eq!(
        fixture["live"]["patch"]["headerBytes"],
        SUBSCRIPTION_HEADER_BYTES
    );
    assert_eq!(
        fixture["live"]["patch"]["maxEnvelopeBytes"],
        MAX_RESPONSE_BYTES
    );
    assert_eq!(fixture["live"]["heartbeat"]["pongRequired"], true);
    assert_eq!(
        fixture["live"]["limits"]["maxSubscriptions"],
        MAX_SUBSCRIPTIONS
    );
    assert_eq!(
        fixture["live"]["limits"]["maxProjectionUrlBytes"],
        MAX_PROJECTION_URL_BYTES
    );
    assert_eq!(
        fixture["live"]["limits"]["maxControlMessageBytes"],
        MAX_CONTROL_MESSAGE_BYTES
    );
    assert_eq!(
        fixture["live"]["limits"]["maxInboundControls"],
        MAX_INBOUND_CONTROLS
    );
    assert_eq!(
        fixture["live"]["limits"]["maxOutboundMessages"],
        MAX_OUTBOUND_MESSAGES
    );
    assert_eq!(
        fixture["live"]["limits"]["outboundMessagesIncludePings"],
        true
    );
    assert_eq!(
        fixture["live"]["limits"]["maxOutboundBytes"],
        MAX_OUTBOUND_BYTES
    );
    assert_eq!(fixture["live"]["limits"]["leaseSeconds"], LEASE_SECONDS);
    assert_eq!(
        fixture["live"]["limits"]["heartbeatSeconds"],
        HEARTBEAT_SECONDS
    );
    assert_eq!(
        fixture["live"]["retry"]["minDelaySeconds"],
        RETRY_MIN_SECONDS
    );
    assert_eq!(
        fixture["live"]["retry"]["maxDelaySeconds"],
        RETRY_MAX_SECONDS
    );
    assert_eq!(fixture["live"]["close"]["retryable"], CLOSE_RETRYABLE);
    assert_eq!(fixture["live"]["close"]["terminal"], CLOSE_TERMINAL);
    assert_eq!(fixture["live"]["close"]["protocol"], CLOSE_PROTOCOL);
    assert_eq!(fixture["live"]["close"]["leaseExpiry"], CLOSE_LEASE_EXPIRY);
    assert_eq!(
        fixture["live"]["close"]["resynchronisation"],
        CLOSE_RESYNCHRONISATION
    );
    assert!(CloseClass::Retryable.reconnects());
    assert!(CloseClass::LeaseExpiry.reconnects());
    assert!(CloseClass::Resynchronisation.reconnects());
    assert!(!CloseClass::Terminal.reconnects());
    assert!(!CloseClass::Protocol.reconnects());

    let html = children_patch("fixture-target", "Ready")
        .encode_live()
        .unwrap();
    assert_eq!(html, fixture["representativeLivePatch"]);
    assert_eq!(
        super::codec::parse_control(fixture["representativeSubscribe"].as_str().unwrap()).unwrap(),
        super::codec::ControlMessage::Subscribe {
            id: 1,
            url: "/items?fixture=one".to_owned(),
        }
    );
}

#[test]
fn encode_live_rejects_titles_and_locations() {
    let titled = children_patch("fixture-target", "Ready").title("Nope");
    assert_eq!(
        titled.encode_live().unwrap_err().kind(),
        crate::PatchBuildErrorKind::InvalidLiveEnvelope
    );
    let mut located = children_patch("fixture-target", "Ready");
    located.replace_location("/items").unwrap();
    assert_eq!(
        located.encode_live().unwrap_err().kind(),
        crate::PatchBuildErrorKind::InvalidLiveEnvelope
    );
}

#[test]
fn live_router_rejects_duplicate_and_ambiguous_paths() {
    async fn one() -> Result<LiveProjection<()>, LiveReject> {
        Err(LiveReject::Invalid)
    }
    async fn two() -> Result<LiveProjection<()>, LiveReject> {
        Err(LiveReject::Invalid)
    }
    let first = LiveRouter::<()>::new().route("/items", one).unwrap();
    let second = LiveRouter::<()>::new().route("/items", two).unwrap();
    assert!(first.merge(second).is_err());

    let first = LiveRouter::<()>::new()
        .route("/items/{first}", one)
        .unwrap();
    let second = LiveRouter::<()>::new()
        .route("/items/{second}", two)
        .unwrap();
    assert!(first.merge(second).is_err());
}

#[derive(Clone)]
struct AppState {
    label: &'static str,
}

#[derive(Deserialize)]
struct ItemQuery {
    q: String,
}

async fn items(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ItemQuery>,
) -> Result<LiveProjection<()>, LiveReject> {
    let (tx, rx) = mpsc::channel::<()>(4);
    drop(tx);
    let label = state.label;
    Ok(LiveProjection::new(mpsc_receiver(rx), move |_ctx| {
        let id = id.clone();
        let q = query.q.clone();
        async move { Ok(children_patch("item-results", &format!("{label}:{id}:{q}"))) }
    }))
}

#[derive(Clone)]
struct Marker(&'static str);

#[derive(Clone)]
struct MarkerGuard;

impl LiveGuard for MarkerGuard {
    type Connection = Marker;
    type Context = &'static str;

    async fn bind(
        &self,
        extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        extensions
            .get::<Marker>()
            .cloned()
            .ok_or(GuardFailure::Terminal)
    }

    async fn revalidate(
        &self,
        connection: &Self::Connection,
    ) -> Result<Self::Context, GuardFailure> {
        Ok(connection.0)
    }
}

async fn extended(
    Extension(marker): Extension<Marker>,
    Extension(_context): Extension<&'static str>,
) -> Result<LiveProjection<&'static str>, LiveReject> {
    Ok(LiveProjection::new(
        futures_util::stream::pending(),
        move |context| {
            let value = format!("{}:{context}", marker.0);
            async move { Ok(children_patch("item-results", &value)) }
        },
    ))
}

fn mpsc_receiver(mut rx: mpsc::Receiver<()>) -> impl futures_util::Stream<Item = ()> {
    async_stream::stream! {
        while let Some(()) = rx.recv().await {
            yield ();
        }
    }
}

#[tokio::test]
async fn harness_dispatches_state_path_and_query() {
    let router = LiveRouter::new().route("/items/{id}", items).unwrap();
    let harness = LiveHarness::new(router, AppState { label: "ready" });
    let session = harness
        .subscribe("/items/abc?q=one", UnitGuard)
        .await
        .unwrap();
    assert_eq!(session.first_patch().targets[0].target, "item-results");
    assert_eq!(
        session.first_patch().targets[0].html,
        "<p>ready:abc:one</p>"
    );
}

#[tokio::test]
async fn harness_dispatches_request_extensions_and_guard_context() {
    let router = LiveRouter::new().route("/items", extended).unwrap();
    let harness = LiveHarness::new(router, ());
    let mut extensions = axum::http::Extensions::new();
    extensions.insert(Marker("extension"));
    let session = harness
        .subscribe_with("/items", MarkerGuard, extensions)
        .await
        .unwrap();
    assert_eq!(
        session.first_patch().targets[0].html,
        "<p>extension:extension</p>"
    );
}

#[tokio::test]
async fn harness_ignores_unregistered_and_invalid_queries() {
    let router = LiveRouter::new().route("/items/{id}", items).unwrap();
    let harness = LiveHarness::new(router, AppState { label: "ready" });
    assert!(matches!(
        harness.subscribe("/other", UnitGuard).await,
        Err(crate::live::HarnessError::Unregistered)
    ));
    assert!(matches!(
        harness.subscribe("/items/abc", UnitGuard).await,
        Err(crate::live::HarnessError::Invalid)
    ));
}

#[tokio::test]
async fn broadcast_lag_becomes_one_invalidation() {
    let (tx, rx) = broadcast::channel::<()>(1);
    let mut stream = std::pin::pin!(broadcast_invalidations(rx));
    tx.send(()).unwrap();
    tx.send(()).unwrap();
    tx.send(()).unwrap();
    assert!(stream.next().await.is_some());
}

#[derive(Clone)]
struct EventHub(broadcast::Sender<u8>);

#[derive(Clone)]
struct LifetimeState(std::sync::Arc<std::sync::atomic::AtomicUsize>);

struct LifetimeLease(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for LifetimeLease {
    fn drop(&mut self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn held_projection(
    State(state): State<LifetimeState>,
) -> Result<LiveProjection<()>, LiveReject> {
    Ok(
        LiveProjection::new(futures_util::stream::pending(), |_ctx| async {
            Ok(children_patch("item-results", "ready"))
        })
        .with_lifetime(LifetimeLease(state.0)),
    )
}

async fn ticking(State(hub): State<EventHub>) -> Result<LiveProjection<()>, LiveReject> {
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Ok(LiveProjection::new(
        broadcast_invalidations(hub.0.subscribe()),
        move |_ctx| {
            let count = count.clone();
            async move {
                let n = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(children_patch("item-results", &n.to_string()))
            }
        },
    ))
}

#[tokio::test]
async fn harness_sends_a_later_patch_after_an_event() {
    let (tx, _rx) = broadcast::channel(16);
    let router = LiveRouter::new().route("/items", ticking).unwrap();
    let harness = LiveHarness::new(router, EventHub(tx.clone()));
    let mut session = harness.subscribe("/items", UnitGuard).await.unwrap();
    assert_eq!(session.first_patch().targets[0].html, "<p>0</p>");
    tx.send(1).unwrap();
    let update = session.next_patch().await.unwrap();
    assert_eq!(update.targets[0].html, "<p>1</p>");
}

#[tokio::test]
async fn harness_coalesces_queued_invalidations() {
    let (tx, _rx) = broadcast::channel(16);
    let router = LiveRouter::new().route("/items", ticking).unwrap();
    let harness = LiveHarness::new(router, EventHub(tx.clone()));
    let mut session = harness.subscribe("/items", UnitGuard).await.unwrap();
    tx.send(1).unwrap();
    tx.send(2).unwrap();
    tx.send(3).unwrap();
    let update = session.next_patch().await.unwrap();
    assert_eq!(update.targets.len(), 1);
}

#[test]
fn socket_admission_releases_on_drop() {
    let admission = SocketAdmission::new();
    let first = admission.try_acquire("user", 1).unwrap();
    assert!(admission.try_acquire("user", 1).is_err());
    drop(first);
    assert!(admission.try_acquire("user", 1).is_ok());
}

#[test]
fn live_socket_config_rejects_invalid_limits() {
    assert!(LiveSocketConfig::default().max_subscriptions(64).is_ok());
    assert!(LiveSocketConfig::default().max_subscriptions(65).is_err());
    assert!(LiveSocketConfig::default().max_subscriptions(0).is_err());
    assert!(
        LiveSocketConfig::default()
            .max_concurrent_refreshes(usize::MAX)
            .is_err()
    );
}

#[test]
fn endpoint_derives_browser_path_and_csp_source() {
    let endpoint = LiveEndpoint::with_default_path("http://localhost:3000").unwrap();
    assert_eq!(endpoint.path(), DEFAULT_PATH);
    assert_eq!(endpoint.browser_path(), DEFAULT_PATH);
    assert_eq!(
        endpoint.csp_connect_src(),
        "ws://localhost:3000/_hypergraft/live"
    );
    let secure = LiveEndpoint::with_default_path("https://easyprac.example.com:443").unwrap();
    assert_eq!(
        secure.csp_connect_src(),
        "wss://easyprac.example.com/_hypergraft/live"
    );
    let ipv6 = LiveEndpoint::with_default_path("http://[::1]:3000").unwrap();
    assert_eq!(ipv6.csp_connect_src(), "ws://[::1]:3000/_hypergraft/live");
    assert!(LiveEndpoint::new("http://localhost:3000", "/live/{id}").is_err());
}

#[test]
fn patch_frame_header_is_big_endian_subscription_id() {
    let envelope = children_patch("fixture-target", "Ready")
        .encode_live()
        .unwrap();
    let bytes = encode_patch_frame(7, &envelope).unwrap();
    assert_eq!(&bytes[..4], 7u32.to_be_bytes());
    assert_eq!(&bytes[4..], envelope.as_bytes());
    let decoded = decode_live_envelope(&envelope).unwrap();
    assert_eq!(decoded.targets[0].target, "fixture-target");
    assert!(encode_patch_frame(0, &envelope).is_err());
    assert!(super::codec::decode_patch_frame(&[0, 0, 0, 0]).is_err());
}

fn upgrade_headers(origin: &str, protocol: Option<&str>, extensions: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
    headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(
        header::SEC_WEBSOCKET_VERSION,
        HeaderValue::from_static("13"),
    );
    headers.insert(
        header::SEC_WEBSOCKET_KEY,
        HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
    );
    if let Some(protocol) = protocol {
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(protocol).unwrap(),
        );
    }
    if let Some(extensions) = extensions {
        headers.insert(
            header::SEC_WEBSOCKET_EXTENSIONS,
            HeaderValue::from_str(extensions).unwrap(),
        );
    }
    headers
}

async fn live_app() -> axum::Router {
    async fn unused() -> Result<LiveProjection<()>, LiveReject> {
        Err(LiveReject::Invalid)
    }
    let router = LiveRouter::new().route("/items", unused).unwrap();
    service(
        LiveEndpoint::with_default_path("http://localhost:3000").unwrap(),
        LiveSocketConfig::default(),
        router,
        UnitGuard,
    )
    .with_state(())
}

#[tokio::test]
async fn upgrade_rejects_missing_or_foreign_origin() {
    let app = live_app().await;
    let missing = app
        .clone()
        .oneshot(
            Request::get(DEFAULT_PATH)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);

    let headers = upgrade_headers("https://evil.example", Some(SUBPROTOCOL), None);
    let mut builder = Request::get(DEFAULT_PATH);
    *builder.headers_mut().unwrap() = headers;
    let foreign = app
        .oneshot(builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn upgrade_requires_the_subprotocol_and_does_not_negotiate_extensions() {
    let app = live_app().await;
    let mut builder = Request::get(DEFAULT_PATH);
    *builder.headers_mut().unwrap() = upgrade_headers("http://localhost:3000", None, None);
    let missing = app
        .clone()
        .oneshot(builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

    let mut builder = Request::get(DEFAULT_PATH);
    *builder.headers_mut().unwrap() =
        upgrade_headers("http://localhost:3000", Some(SUBPROTOCOL), None);
    let plain = app
        .clone()
        .oneshot(builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();

    let mut builder = Request::get(DEFAULT_PATH);
    *builder.headers_mut().unwrap() = upgrade_headers(
        "http://localhost:3000",
        Some(SUBPROTOCOL),
        Some("permessage-deflate"),
    );
    let extended = app
        .oneshot(builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(extended.status(), plain.status());
    assert!(
        !extended
            .headers()
            .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    );
}

#[tokio::test]
async fn real_upgrade_selects_only_the_live_subprotocol() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    async fn unused() -> Result<LiveProjection<()>, LiveReject> {
        Err(LiveReject::Invalid)
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    let router = LiveRouter::new().route("/items", unused).unwrap();
    let app = service(
        LiveEndpoint::with_default_path(&origin).unwrap(),
        LiveSocketConfig::default(),
        router,
        UnitGuard,
    )
    .with_state(());
    let server = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .unwrap();
    });

    let mut request = format!("ws://{address}{DEFAULT_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_str(&origin).unwrap());
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(SUBPROTOCOL),
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_EXTENSIONS,
        HeaderValue::from_static("permessage-deflate"),
    );
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.headers()[header::SEC_WEBSOCKET_PROTOCOL],
        SUBPROTOCOL
    );
    assert!(
        !response
            .headers()
            .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    );
    socket.close(None).await.unwrap();
    server.abort();
}

#[test]
fn control_parser_enforces_bounds_and_local_urls() {
    use super::codec::parse_control;
    assert!(parse_control(r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#).is_ok());
    assert!(parse_control(r#"{"v":"1","type":"subscribe","id":0,"url":"/items"}"#).is_err());
    assert!(
        parse_control(r#"{"v":"1","type":"subscribe","id":1,"url":"https://example.test/items"}"#)
            .is_err()
    );
    assert!(parse_control(r#"{"v":"1","type":"subscribe","id":1,"url":"/items#x"}"#).is_err());
    let huge_url = format!(
        "{{\"v\":\"1\",\"type\":\"subscribe\",\"id\":1,\"url\":\"/{}\"}}",
        "a".repeat(MAX_PROJECTION_URL_BYTES),
    );
    assert!(parse_control(&huge_url).is_err());
    let huge = "x".repeat(MAX_CONTROL_MESSAGE_BYTES + 1);
    assert!(parse_control(&huge).is_err());
    assert!(parse_control(r#"{"v":"1","type":"terminal","id":1}"#).is_err());
}

struct FakeSocket {
    incoming: mpsc::UnboundedReceiver<super::socket::Incoming>,
    outgoing: mpsc::UnboundedSender<FakeOut>,
}

enum FakeOut {
    Binary(Vec<u8>),
    Ping,
    Close(CloseClass),
}

impl super::socket::FrameSocket for FakeSocket {
    async fn send_binary(&mut self, bytes: Vec<u8>) -> Result<(), ()> {
        self.outgoing.send(FakeOut::Binary(bytes)).map_err(|_| ())
    }

    async fn send_ping(&mut self) -> Result<(), ()> {
        self.outgoing.send(FakeOut::Ping).map_err(|_| ())
    }

    async fn close(&mut self, class: CloseClass) -> Result<(), ()> {
        self.outgoing.send(FakeOut::Close(class)).map_err(|_| ())
    }

    async fn recv(&mut self) -> Option<super::socket::Incoming> {
        self.incoming.recv().await
    }
}

struct LeaseSocket {
    pong_pending: bool,
    closed: mpsc::UnboundedSender<CloseClass>,
}

impl super::socket::FrameSocket for LeaseSocket {
    async fn send_binary(&mut self, _bytes: Vec<u8>) -> Result<(), ()> {
        Ok(())
    }

    async fn send_ping(&mut self) -> Result<(), ()> {
        self.pong_pending = true;
        Ok(())
    }

    async fn close(&mut self, class: CloseClass) -> Result<(), ()> {
        self.closed.send(class).map_err(|_| ())
    }

    async fn recv(&mut self) -> Option<super::socket::Incoming> {
        if self.pong_pending {
            self.pong_pending = false;
            Some(super::socket::Incoming::Pong)
        } else {
            std::future::pending().await
        }
    }
}

fn session_pair() -> (
    FakeSocket,
    mpsc::UnboundedSender<super::socket::Incoming>,
    mpsc::UnboundedReceiver<FakeOut>,
) {
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    (
        FakeSocket {
            incoming: in_rx,
            outgoing: out_tx,
        },
        in_tx,
        out_rx,
    )
}

#[tokio::test(start_paused = true)]
async fn socket_closes_at_the_lease_bound() {
    let (closed_tx, mut closed_rx) = mpsc::unbounded_channel();
    let socket = LeaseSocket {
        pong_pending: false,
        closed: closed_tx,
    };
    let router = std::sync::Arc::new(LiveRouter::new());
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        router,
        UnitGuard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    tokio::time::advance(std::time::Duration::from_secs(LEASE_SECONDS)).await;
    assert_eq!(closed_rx.recv().await, Some(CloseClass::LeaseExpiry));
    session.await.unwrap();
}

#[tokio::test]
async fn socket_releases_projection_lifetimes_after_the_peer_closes() {
    let drops = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", held_projection).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        LifetimeState(drops.clone()),
        router,
        UnitGuard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    assert!(matches!(outgoing.recv().await, Some(FakeOut::Binary(_))));
    incoming.send(super::socket::Incoming::Close).unwrap();
    session.await.unwrap();
    assert_eq!(drops.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn socket_sends_an_authoritative_first_patch_then_closes_on_duplicate_id() {
    let (tx, _rx) = broadcast::channel(16);
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", ticking).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let config = LiveSocketConfig::default().max_subscriptions(2).unwrap();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        EventHub(tx.clone()),
        router,
        UnitGuard,
        config,
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    let FakeOut::Binary(bytes) = outgoing.recv().await.unwrap() else {
        panic!("expected first patch");
    };
    let (id, envelope) = super::codec::decode_patch_frame(&bytes).unwrap();
    assert_eq!(id, 1);
    assert_eq!(
        decode_live_envelope(envelope).unwrap().targets[0].html,
        "<p>0</p>"
    );
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    let FakeOut::Close(class) = outgoing.recv().await.unwrap() else {
        panic!("expected protocol close");
    };
    assert_eq!(class, CloseClass::Protocol);
    session.await.unwrap();
}

#[tokio::test]
async fn socket_closes_at_the_inbound_control_budget() {
    let router = std::sync::Arc::new(LiveRouter::new());
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        router,
        UnitGuard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    for id in 1..=MAX_INBOUND_CONTROLS + 1 {
        incoming
            .send(super::socket::Incoming::Text(format!(
                r#"{{"v":"1","type":"unsubscribe","id":{id}}}"#
            )))
            .unwrap();
    }
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::LeaseExpiry))
    ));
    session.await.unwrap();
}

#[tokio::test]
async fn socket_closes_before_exceeding_the_subscription_limit() {
    let (tx, _rx) = broadcast::channel(16);
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", ticking).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let config = LiveSocketConfig::default().max_subscriptions(1).unwrap();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        EventHub(tx.clone()),
        router,
        UnitGuard,
        config,
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    assert!(matches!(outgoing.recv().await, Some(FakeOut::Binary(_))));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":2,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::Protocol))
    ));
    session.await.unwrap();
}

#[derive(Clone)]
struct PendingBindGuard {
    admission: SocketAdmission<&'static str>,
    acquired: std::sync::Arc<Notify>,
}

impl LiveGuard for PendingBindGuard {
    type Connection = ();
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        let _permit = self.admission.try_acquire("anon", 1).unwrap();
        self.acquired.notify_one();
        std::future::pending().await
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}

struct PermitConn {
    _permit: crate::live::AdmissionPermit<&'static str>,
}

#[derive(Clone)]
struct PermitGuard {
    admission: SocketAdmission<&'static str>,
}

impl LiveGuard for PermitGuard {
    type Connection = PermitConn;
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        Ok(PermitConn {
            _permit: self.admission.try_acquire("anon", 1).unwrap(),
        })
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}

#[derive(Clone)]
struct PendingRevalidateGuard;

impl LiveGuard for PendingRevalidateGuard {
    type Connection = ();
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        Ok(())
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        std::future::pending().await
    }
}

#[derive(Clone)]
struct FactoryGate {
    started: std::sync::Arc<Notify>,
    release: std::sync::Arc<Notify>,
}

async fn gated_projection(
    State(gate): State<FactoryGate>,
) -> Result<LiveProjection<()>, LiveReject> {
    gate.started.notify_one();
    gate.release.notified().await;
    Ok(LiveProjection::new(
        futures_util::stream::pending(),
        |_ctx| async { Ok(children_patch("item-results", "late")) },
    ))
}

#[tokio::test(start_paused = true)]
async fn socket_cancels_a_pending_bind_at_the_lease_bound() {
    let admission = SocketAdmission::new();
    let acquired = std::sync::Arc::new(Notify::new());
    let waiting = acquired.notified();
    let guard = PendingBindGuard {
        admission: admission.clone(),
        acquired: acquired.clone(),
    };
    let (closed_tx, mut closed_rx) = mpsc::unbounded_channel();
    let socket = LeaseSocket {
        pong_pending: false,
        closed: closed_tx,
    };
    let router = std::sync::Arc::new(LiveRouter::new());
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        router,
        guard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    waiting.await;
    assert!(admission.try_acquire("anon", 1).is_err());
    tokio::time::advance(std::time::Duration::from_secs(LEASE_SECONDS)).await;
    assert_eq!(closed_rx.recv().await, Some(CloseClass::LeaseExpiry));
    session.await.unwrap();
    assert!(admission.try_acquire("anon", 1).is_ok());
}

#[tokio::test(start_paused = true)]
async fn socket_cancels_a_pending_factory_at_the_lease_bound() {
    let admission = SocketAdmission::new();
    let gate = FactoryGate {
        started: std::sync::Arc::new(Notify::new()),
        release: std::sync::Arc::new(Notify::new()),
    };
    let started = gate.started.notified();
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", gated_projection).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        gate.clone(),
        router,
        PermitGuard {
            admission: admission.clone(),
        },
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    started.await;
    assert!(admission.try_acquire("anon", 1).is_err());
    tokio::time::advance(std::time::Duration::from_secs(HEARTBEAT_SECONDS)).await;
    assert!(matches!(outgoing.recv().await, Some(FakeOut::Ping)));
    incoming.send(super::socket::Incoming::Pong).unwrap();
    tokio::time::advance(std::time::Duration::from_secs(
        LEASE_SECONDS - HEARTBEAT_SECONDS,
    ))
    .await;
    loop {
        match outgoing.recv().await {
            Some(FakeOut::Close(class)) => {
                assert_eq!(class, CloseClass::LeaseExpiry);
                break;
            }
            Some(FakeOut::Ping) => {}
            Some(FakeOut::Binary(_)) => panic!("late outbound patch"),
            None => panic!("socket ended without lease close"),
        }
    }
    gate.release.notify_one();
    session.await.unwrap();
    assert!(outgoing.try_recv().is_err());
    assert!(admission.try_acquire("anon", 1).is_ok());
}

#[tokio::test(start_paused = true)]
async fn socket_reaches_the_lease_bound_during_pending_revalidation() {
    let router = std::sync::Arc::new(LiveRouter::new());
    let (socket, _incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        router,
        PendingRevalidateGuard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    tokio::time::advance(std::time::Duration::from_secs(HEARTBEAT_SECONDS)).await;
    assert!(matches!(outgoing.recv().await, Some(FakeOut::Ping)));
    tokio::time::advance(std::time::Duration::from_secs(
        LEASE_SECONDS - HEARTBEAT_SECONDS,
    ))
    .await;
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::LeaseExpiry))
    ));
    session.await.unwrap();
}

#[tokio::test]
async fn socket_unsubscribe_cancels_the_factory_and_releases_its_slot() {
    let gate = FactoryGate {
        started: std::sync::Arc::new(Notify::new()),
        release: std::sync::Arc::new(Notify::new()),
    };
    let started = gate.started.notified();
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", gated_projection).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        gate.clone(),
        router,
        UnitGuard,
        LiveSocketConfig::default().max_subscriptions(1).unwrap(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    started.await;
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"unsubscribe","id":1}"#.to_owned(),
        ))
        .unwrap();
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":2,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    gate.started.notified().await;
    gate.release.notify_one();
    let Some(FakeOut::Binary(bytes)) = outgoing.recv().await else {
        panic!("replacement subscription did not produce a patch");
    };
    assert_eq!(&bytes[..SUBSCRIPTION_HEADER_BYTES], &2u32.to_be_bytes());
    incoming.send(super::socket::Incoming::Close).unwrap();
    session.await.unwrap();
    assert!(outgoing.try_recv().is_err());
}

#[tokio::test]
async fn socket_counts_a_pending_factory_against_subscription_admission() {
    let gate = FactoryGate {
        started: std::sync::Arc::new(Notify::new()),
        release: std::sync::Arc::new(Notify::new()),
    };
    let started = gate.started.notified();
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", gated_projection).unwrap());
    let (socket, incoming, mut outgoing) = session_pair();
    let config = LiveSocketConfig::default().max_subscriptions(1).unwrap();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        gate.clone(),
        router,
        UnitGuard,
        config,
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    started.await;
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":2,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::Protocol))
    ));
    session.await.unwrap();
}

fn dropping_pending(
    drops: std::sync::Arc<std::sync::atomic::AtomicUsize>,
) -> impl futures_util::Stream<Item = ()> + Send {
    struct Flag(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Flag {
        fn drop(&mut self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    futures_util::stream::unfold(Flag(drops), |flag| async move {
        std::future::pending::<()>().await;
        Some(((), flag))
    })
}

#[derive(Clone)]
struct TrackedLive {
    projections: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    listeners: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

async fn tracked_projection(
    State(state): State<TrackedLive>,
) -> Result<LiveProjection<()>, LiveReject> {
    Ok(
        LiveProjection::new(dropping_pending(state.listeners), |_ctx| async {
            Ok(children_patch("item-results", "ready"))
        })
        .with_lifetime(LifetimeLease(state.projections)),
    )
}

#[derive(Clone)]
struct RefreshHold {
    started: std::sync::Arc<Notify>,
    projections: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    listeners: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

async fn held_refresh(State(state): State<RefreshHold>) -> Result<LiveProjection<()>, LiveReject> {
    let started = state.started.clone();
    Ok(
        LiveProjection::new(dropping_pending(state.listeners), move |_ctx| {
            let started = started.clone();
            async move {
                started.notify_one();
                std::future::pending().await
            }
        })
        .with_lifetime(LifetimeLease(state.projections)),
    )
}

struct StallingBinarySocket {
    incoming: mpsc::UnboundedReceiver<super::socket::Incoming>,
    outgoing: mpsc::UnboundedSender<FakeOut>,
    send_started: std::sync::Arc<Notify>,
    fail_after: Option<std::time::Duration>,
}

impl super::socket::FrameSocket for StallingBinarySocket {
    async fn send_binary(&mut self, _bytes: Vec<u8>) -> Result<(), ()> {
        self.send_started.notify_one();
        if let Some(delay) = self.fail_after {
            tokio::time::sleep(delay).await;
            return Err(());
        }
        std::future::pending().await
    }

    async fn send_ping(&mut self) -> Result<(), ()> {
        self.outgoing.send(FakeOut::Ping).map_err(|_| ())
    }

    async fn close(&mut self, class: CloseClass) -> Result<(), ()> {
        self.outgoing.send(FakeOut::Close(class)).map_err(|_| ())
    }

    async fn recv(&mut self) -> Option<super::socket::Incoming> {
        self.incoming.recv().await
    }
}

struct StallingCloseSocket {
    close_started: std::sync::Arc<Notify>,
}

impl super::socket::FrameSocket for StallingCloseSocket {
    async fn send_binary(&mut self, _bytes: Vec<u8>) -> Result<(), ()> {
        Ok(())
    }

    async fn send_ping(&mut self) -> Result<(), ()> {
        Ok(())
    }

    async fn close(&mut self, _class: CloseClass) -> Result<(), ()> {
        self.close_started.notify_one();
        std::future::pending().await
    }

    async fn recv(&mut self) -> Option<super::socket::Incoming> {
        std::future::pending().await
    }
}

#[derive(Clone)]
struct BarrierFailGuard {
    admission: SocketAdmission<&'static str>,
    started: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    barrier: std::sync::Arc<tokio::sync::Barrier>,
}

impl LiveGuard for BarrierFailGuard {
    type Connection = PermitConn;
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        Ok(PermitConn {
            _permit: self.admission.try_acquire("anon", 1).unwrap(),
        })
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        let n = self
            .started
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.barrier.wait().await;
        // All factories pass before refresh revalidation fails in the next barrier round.
        if n < 3 {
            Ok(())
        } else {
            Err(GuardFailure::Retryable)
        }
    }
}

fn assert_released(
    projections: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    listeners: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    admission: &SocketAdmission<&'static str>,
) {
    assert_eq!(projections.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(listeners.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(admission.try_acquire("anon", 1).is_ok());
}

#[tokio::test(start_paused = true)]
async fn socket_bounds_binary_writes_and_prioritises_lease_expiry() {
    for (elapsed, fail_after, expected) in [
        (HEARTBEAT_SECONDS, None, CloseClass::Retryable),
        (LEASE_SECONDS, None, CloseClass::LeaseExpiry),
        (
            LEASE_SECONDS,
            Some(std::time::Duration::from_secs(LEASE_SECONDS)),
            CloseClass::LeaseExpiry,
        ),
    ] {
        let admission = SocketAdmission::new();
        let projections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let listeners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let send_started = std::sync::Arc::new(Notify::new());
        let waiting = send_started.notified();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        let socket = StallingBinarySocket {
            incoming: in_rx,
            outgoing: out_tx,
            send_started: send_started.clone(),
            fail_after,
        };
        let router = std::sync::Arc::new(
            LiveRouter::new()
                .route("/items", tracked_projection)
                .unwrap(),
        );
        let session = tokio::spawn(super::socket::run_session(
            socket,
            TrackedLive {
                projections: projections.clone(),
                listeners: listeners.clone(),
            },
            router,
            PermitGuard {
                admission: admission.clone(),
            },
            LiveSocketConfig::default(),
            axum::http::Extensions::new(),
        ));
        in_tx
            .send(super::socket::Incoming::Text(
                r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
            ))
            .unwrap();
        waiting.await;
        tokio::time::advance(std::time::Duration::from_secs(elapsed)).await;
        assert!(matches!(
            out_rx.recv().await,
            Some(FakeOut::Close(class)) if class == expected
        ));
        session.await.unwrap();
        assert_released(&projections, &listeners, &admission);
    }
}

#[tokio::test(start_paused = true)]
async fn socket_releases_resources_after_a_stalled_close_handshake() {
    let admission = SocketAdmission::new();
    let close_started = std::sync::Arc::new(Notify::new());
    let waiting = close_started.notified();
    let socket = StallingCloseSocket {
        close_started: close_started.clone(),
    };
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        std::sync::Arc::new(LiveRouter::new()),
        PermitGuard {
            admission: admission.clone(),
        },
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    tokio::time::advance(std::time::Duration::from_secs(LEASE_SECONDS)).await;
    waiting.await;
    assert!(!session.is_finished());
    assert!(admission.try_acquire("anon", 1).is_ok());
    tokio::time::advance(std::time::Duration::from_secs(HEARTBEAT_SECONDS)).await;
    session.await.unwrap();
}

#[tokio::test]
async fn socket_closes_when_three_projections_fail_together() {
    let admission = SocketAdmission::new();
    let guard = BarrierFailGuard {
        admission: admission.clone(),
        started: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        barrier: std::sync::Arc::new(tokio::sync::Barrier::new(3)),
    };
    let started = guard.started.clone();
    let projections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listeners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        TrackedLive {
            projections: projections.clone(),
            listeners: listeners.clone(),
        },
        std::sync::Arc::new(
            LiveRouter::new()
                .route("/items", tracked_projection)
                .unwrap(),
        ),
        guard,
        LiveSocketConfig::default().max_subscriptions(3).unwrap(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":2,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":3,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    let ended = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        assert!(matches!(
            outgoing.recv().await,
            Some(FakeOut::Close(CloseClass::Retryable))
        ));
        session.await.unwrap();
    })
    .await;
    assert!(ended.is_ok(), "session deadlocked during shutdown");
    assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 6);
    assert_eq!(projections.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(listeners.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert!(admission.try_acquire("anon", 1).is_ok());
}

#[tokio::test(start_paused = true)]
async fn socket_releases_projection_resources_at_the_lease_bound() {
    let admission = SocketAdmission::new();
    let projections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listeners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = std::sync::Arc::new(
        LiveRouter::new()
            .route("/items", tracked_projection)
            .unwrap(),
    );
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        TrackedLive {
            projections: projections.clone(),
            listeners: listeners.clone(),
        },
        router,
        PermitGuard {
            admission: admission.clone(),
        },
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    assert!(matches!(outgoing.recv().await, Some(FakeOut::Binary(_))));
    tokio::time::advance(std::time::Duration::from_secs(LEASE_SECONDS)).await;
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::LeaseExpiry))
    ));
    session.await.unwrap();
    assert_released(&projections, &listeners, &admission);
}

#[tokio::test]
async fn socket_releases_resources_after_peer_closure_during_an_active_refresh() {
    let admission = SocketAdmission::new();
    let started = std::sync::Arc::new(Notify::new());
    let waiting = started.notified();
    let projections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listeners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", held_refresh).unwrap());
    let (socket, incoming, _outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        RefreshHold {
            started: started.clone(),
            projections: projections.clone(),
            listeners: listeners.clone(),
        },
        router,
        PermitGuard {
            admission: admission.clone(),
        },
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    waiting.await;
    incoming.send(super::socket::Incoming::Close).unwrap();
    session.await.unwrap();
    assert_released(&projections, &listeners, &admission);
}

#[tokio::test]
async fn socket_releases_resources_when_cancelled_during_an_active_refresh() {
    let admission = SocketAdmission::new();
    let started = std::sync::Arc::new(Notify::new());
    let waiting = started.notified();
    let projections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listeners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = std::sync::Arc::new(LiveRouter::new().route("/items", held_refresh).unwrap());
    let (socket, incoming, _outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        RefreshHold {
            started: started.clone(),
            projections: projections.clone(),
            listeners: listeners.clone(),
        },
        router,
        PermitGuard {
            admission: admission.clone(),
        },
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    waiting.await;
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"unsubscribe","id":1}"#.to_owned(),
        ))
        .unwrap();
    incoming.send(super::socket::Incoming::Close).unwrap();
    session.await.unwrap();
    assert_released(&projections, &listeners, &admission);
}

const LIVE_SECRET: &str = "s3cret-live-token-value";
const DIAGNOSTIC_FIELDS: &[&str] = &["close_class", "reason", "kind"];

#[derive(Clone, Debug)]
struct CapturedEvent {
    level: tracing::Level,
    message: String,
    fields: HashMap<String, String>,
}

#[derive(Clone, Default)]
struct Capture(std::sync::Arc<std::sync::Mutex<Vec<CapturedEvent>>>);

struct FieldRecorder {
    message: String,
    fields: HashMap<String, String>,
}

impl FieldRecorder {
    fn record(&mut self, name: &str, value: String) {
        let value = value.trim_matches('"').to_owned();
        if name == "message" {
            self.message = value;
        } else {
            self.fields.insert(name.to_owned(), value);
        }
    }
}

impl Visit for FieldRecorder {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record(field.name(), format!("{value:?}"));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field.name(), value.to_owned());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record(field.name(), value.to_string());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record(field.name(), value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record(field.name(), value.to_string());
    }
}

impl<S> Layer<S> for Capture
where
    S: tracing::Subscriber,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        if !event.metadata().target().starts_with("hypergraft::live") {
            return;
        }
        let mut recorder = FieldRecorder {
            message: String::new(),
            fields: HashMap::new(),
        };
        event.record(&mut recorder);
        self.0.lock().unwrap().push(CapturedEvent {
            level: *event.metadata().level(),
            message: recorder.message,
            fields: recorder.fields,
        });
    }
}

impl Capture {
    fn subscriber(&self) -> impl tracing::Subscriber + Send + Sync + 'static {
        tracing_subscriber::registry().with(self.clone())
    }

    fn events(&self) -> Vec<CapturedEvent> {
        self.0.lock().unwrap().clone()
    }
}

fn assert_secret_safe(events: &[CapturedEvent], secrets: &[&str]) {
    for event in events {
        for key in event.fields.keys() {
            assert!(
                DIAGNOSTIC_FIELDS.contains(&key.as_str()),
                "unexpected diagnostic field {key}"
            );
        }
        let blob = format!("{event:?}");
        for secret in secrets {
            assert!(!blob.contains(secret), "diagnostic leaked {secret}: {blob}");
        }
    }
}

fn field_value<'a>(event: &'a CapturedEvent, name: &str) -> Option<&'a str> {
    event.fields.get(name).map(String::as_str)
}

#[derive(Clone)]
struct FailingBindGuard(GuardFailure);

impl LiveGuard for FailingBindGuard {
    type Connection = ();
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        Err(self.0)
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}

#[derive(Clone)]
struct EncodeFailState(std::sync::Arc<Notify>);

async fn secret_encode_projection(
    State(state): State<EncodeFailState>,
) -> Result<LiveProjection<()>, LiveReject> {
    let done = state.0.clone();
    Ok(LiveProjection::new(
        futures_util::stream::pending(),
        move |_ctx| {
            let done = done.clone();
            async move {
                done.notify_one();
                Ok(children_patch("item-results", LIVE_SECRET).title(LIVE_SECRET))
            }
        },
    ))
}

#[tokio::test]
async fn live_diagnostics_exclude_secrets_from_encode_failure() {
    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let done = std::sync::Arc::new(Notify::new());
    let waiting = done.notified();
    let mut extensions = axum::http::Extensions::new();
    let mut headers = HeaderMap::new();
    headers.insert(header::AUTHORIZATION, HeaderValue::from_static(LIVE_SECRET));
    extensions.insert(headers);
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        EncodeFailState(done.clone()),
        std::sync::Arc::new(
            LiveRouter::new()
                .route("/items", secret_encode_projection)
                .unwrap(),
        ),
        UnitGuard,
        LiveSocketConfig::default(),
        extensions,
    ));
    incoming
        .send(super::socket::Incoming::Text(format!(
            r#"{{"v":"1","type":"subscribe","id":1,"url":"/items?token={LIVE_SECRET}"}}"#
        )))
        .unwrap();
    waiting.await;
    let mut encoded = false;
    for _ in 0..32 {
        tokio::task::yield_now().await;
        if capture
            .events()
            .iter()
            .any(|event| event.message == "live projection encode failed")
        {
            encoded = true;
            break;
        }
    }
    assert!(encoded, "encode failure was not diagnosed");
    incoming.send(super::socket::Incoming::Close).unwrap();
    session.await.unwrap();
    assert!(outgoing.try_recv().is_err());
    let events = capture.events();
    let encode = events
        .iter()
        .find(|event| event.message == "live projection encode failed")
        .expect("encode diagnostic");
    assert_eq!(encode.level, tracing::Level::WARN);
    assert_eq!(field_value(encode, "kind"), Some("invalid_live_envelope"));
    assert_secret_safe(&events, &[LIVE_SECRET, "<p>", "item-results"]);
}

#[tokio::test]
async fn live_diagnostics_report_closed_guard_and_lease_reasons() {
    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let (socket, _incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        (),
        std::sync::Arc::new(LiveRouter::new()),
        FailingBindGuard(GuardFailure::Terminal),
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    assert!(matches!(
        outgoing.recv().await,
        Some(FakeOut::Close(CloseClass::Terminal))
    ));
    session.await.unwrap();
    let events = capture.events();
    let closes: Vec<_> = events
        .iter()
        .filter(|event| event.message == "live session closed")
        .collect();
    assert_eq!(closes.len(), 1);
    assert_eq!(closes[0].level, tracing::Level::WARN);
    assert_eq!(field_value(closes[0], "reason"), Some("guard"));
    assert_eq!(field_value(closes[0], "close_class"), Some("terminal"));

    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let (closed_tx, mut closed_rx) = mpsc::unbounded_channel();
    tokio::time::pause();
    let session = tokio::spawn(super::socket::run_session(
        LeaseSocket {
            pong_pending: false,
            closed: closed_tx,
        },
        (),
        std::sync::Arc::new(LiveRouter::new()),
        UnitGuard,
        LiveSocketConfig::default(),
        axum::http::Extensions::new(),
    ));
    tokio::time::advance(std::time::Duration::from_secs(LEASE_SECONDS)).await;
    assert_eq!(closed_rx.recv().await, Some(CloseClass::LeaseExpiry));
    session.await.unwrap();
    let events = capture.events();
    let closes: Vec<_> = events
        .iter()
        .filter(|event| event.message == "live session closed")
        .collect();
    assert_eq!(closes.len(), 1);
    assert_eq!(closes[0].level, tracing::Level::INFO);
    assert_eq!(field_value(closes[0], "reason"), Some("lease"));
    assert_eq!(field_value(closes[0], "close_class"), Some("lease_expiry"));
}

#[tokio::test]
async fn live_diagnostics_distinguish_receive_failure_from_peer_closure() {
    for failed in [false, true] {
        let capture = Capture::default();
        let _guard = tracing::subscriber::set_default(capture.subscriber());
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::CloseFrame};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let app = service(
            LiveEndpoint::with_default_path(&origin).unwrap(),
            LiveSocketConfig::default(),
            LiveRouter::new(),
            UnitGuard,
        )
        .with_state(());
        let server = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        let mut request = format!("ws://{address}{DEFAULT_PATH}")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, HeaderValue::from_str(&origin).unwrap());
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(SUBPROTOCOL),
        );
        request
            .headers_mut()
            .insert(header::AUTHORIZATION, HeaderValue::from_static(LIVE_SECRET));
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        if !failed {
            socket
                .close(Some(CloseFrame {
                    code:
                        tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                    reason: LIVE_SECRET.into(),
                }))
                .await
                .unwrap();
        }
        // A dropped TCP connection without a close frame exercises the adapter's receive error.
        drop(socket);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !capture.events().is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        server.abort();
        result.expect("session close diagnostic");
        let events = capture.events();
        assert_secret_safe(&events, &[LIVE_SECRET]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].message, "live session closed");
        if failed {
            assert_eq!(events[0].level, tracing::Level::WARN);
            assert_eq!(field_value(&events[0], "reason"), Some("transport"));
            assert_eq!(field_value(&events[0], "close_class"), Some("retryable"));
        } else {
            assert_eq!(events[0].level, tracing::Level::INFO);
            assert_eq!(field_value(&events[0], "reason"), Some("peer"));
            assert_eq!(field_value(&events[0], "close_class"), None);
        }
    }
}

#[tokio::test]
async fn live_diagnostics_emit_one_session_close_for_simultaneous_failures() {
    let capture = Capture::default();
    let _guard = tracing::subscriber::set_default(capture.subscriber());
    let admission = SocketAdmission::new();
    let guard = BarrierFailGuard {
        admission: admission.clone(),
        started: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        barrier: std::sync::Arc::new(tokio::sync::Barrier::new(3)),
    };
    let (socket, incoming, mut outgoing) = session_pair();
    let session = tokio::spawn(super::socket::run_session(
        socket,
        TrackedLive {
            projections: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            listeners: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        },
        std::sync::Arc::new(
            LiveRouter::new()
                .route("/items", tracked_projection)
                .unwrap(),
        ),
        guard,
        LiveSocketConfig::default().max_subscriptions(3).unwrap(),
        axum::http::Extensions::new(),
    ));
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":1,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":2,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    incoming
        .send(super::socket::Incoming::Text(
            r#"{"v":"1","type":"subscribe","id":3,"url":"/items"}"#.to_owned(),
        ))
        .unwrap();
    let ended = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        assert!(matches!(
            outgoing.recv().await,
            Some(FakeOut::Close(CloseClass::Retryable))
        ));
        session.await.unwrap();
    })
    .await;
    assert!(ended.is_ok(), "session deadlocked during shutdown");
    let events = capture.events();
    let closes: Vec<_> = events
        .iter()
        .filter(|event| event.message == "live session closed")
        .collect();
    assert_eq!(closes.len(), 1);
    assert_eq!(closes[0].level, tracing::Level::WARN);
    assert_eq!(field_value(closes[0], "reason"), Some("guard"));
    assert_eq!(field_value(closes[0], "close_class"), Some("retryable"));
    assert_secret_safe(&events, &["/items"]);
}
