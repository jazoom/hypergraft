//! Axum request classification middleware.

use axum::{
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::GraftRequest;

/// Classify Hypergraft metadata before guards and merge representation variance afterwards.
pub async fn classify(mut request: Request, next: Next) -> Response {
    let graft = match GraftRequest::classify(request.headers()) {
        Ok(graft) => graft,
        Err(error) => return error.into_response(),
    };
    request.extensions_mut().insert(graft);
    let mut response = next.run(request).await;
    crate::merge_vary(response.headers_mut());
    response
}

#[cfg(test)]
mod tests;
