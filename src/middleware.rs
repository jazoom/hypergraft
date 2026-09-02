//! Axum request classification middleware.

use axum::{
    extract::Request,
    http::Method,
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{GraftMetadataError, GraftRequest};

/// Classify metadata, reject non-patch POST requests before guards and merge representation variance afterwards.
pub async fn classify(mut request: Request, next: Next) -> Response {
    let graft = match GraftRequest::classify(request.headers()) {
        Ok(graft) => graft,
        Err(error) => return error.into_response(),
    };
    if request.method() == Method::POST && graft != GraftRequest::Patch {
        return GraftMetadataError.into_response();
    }
    request.extensions_mut().insert(graft);
    let mut response = next.run(request).await;
    crate::merge_vary(response.headers_mut());
    response
}

#[cfg(test)]
mod tests;
