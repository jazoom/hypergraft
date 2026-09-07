use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub const PUBLIC_ORIGIN: &str = "http://127.0.0.1:3000";
pub const BIND_ADDR: &str = "127.0.0.1:3000";

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ws://127.0.0.1:3000; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hypergraft";

pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
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
