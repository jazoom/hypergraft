use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    middleware,
    response::IntoResponse,
    routing::get,
};
use tower::ServiceExt;

#[tokio::test]
async fn malformed_metadata_is_rejected_before_the_downstream_service() {
    let calls = Arc::new(AtomicUsize::new(0));
    let downstream_calls = calls.clone();
    let app = Router::new()
        .route(
            "/",
            get(move || {
                let calls = downstream_calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    "reachable"
                }
            }),
        )
        .layer(middleware::from_fn(super::classify));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header("Graft-Request", "patch")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn classifier_merges_existing_vary_tokens_once() {
    let app = Router::new()
        .route(
            "/",
            get(|| async { [(header::VARY, "Origin, accept")].into_response() }),
        )
        .layer(middleware::from_fn(super::classify));

    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(
        response.headers()[header::VARY],
        "Origin, accept, Graft-Request"
    );
}
