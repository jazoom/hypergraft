use std::sync::OnceLock;

use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use hypergraft::live::LiveEndpoint;

pub const PUBLIC_ORIGIN: &str = "http://127.0.0.1:3000";
pub const BIND_ADDR: &str = "127.0.0.1:3000";

pub fn live_endpoint() -> LiveEndpoint {
    LiveEndpoint::with_default_path(PUBLIC_ORIGIN)
        .expect("loopback origin is a valid live endpoint")
}

fn content_security_policy() -> HeaderValue {
    static CSP: OnceLock<HeaderValue> = OnceLock::new();
    CSP.get_or_init(|| {
        let endpoint = live_endpoint();
        let connect = endpoint.csp_connect_src();
        HeaderValue::from_str(&format!(
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' {connect}; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hypergraft"
        ))
        .expect("csp is a valid header")
    })
    .clone()
}

pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers.insert(header::CONTENT_SECURITY_POLICY, content_security_policy());
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

pub async fn enforce_origin(request: Request, next: Next) -> Response {
    if request.method().is_safe() {
        return next.run(request).await;
    }
    if origin_matches(request.headers()) {
        return next.run(request).await;
    }
    no_store_response(StatusCode::FORBIDDEN, "Forbidden")
}

pub async fn not_found() -> Response {
    no_store_response(StatusCode::NOT_FOUND, "Not found")
}

pub fn no_store_response(status: StatusCode, body: &'static str) -> Response {
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn origin_matches(headers: &axum::http::HeaderMap) -> bool {
    let mut values = headers.get_all(header::ORIGIN).iter();
    let Some(first) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    first.as_bytes() == PUBLIC_ORIGIN.as_bytes()
}
