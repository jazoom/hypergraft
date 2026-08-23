//! Bounded Hypergraft protocol version 1 integration for Axum and Askama.

pub mod middleware;
pub mod outcome;
mod request;
mod response;

pub use request::{CommandGraft, GRAFT_REQUEST, GraftMetadataError, GraftRequest, PageGraft};
pub use response::{
    DomId, InvalidDomId, InvalidNavigation, Navigation, PatchBuildError, PatchBuildErrorKind,
    PatchSet, PatchStatus, RetryAfter,
};

use axum::{
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

pub const MEDIA_TYPE: &str = "text/vnd.hypergraft.patches+html";
pub const VERSION: &str = "1";
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_PATCHES: usize = 16;
pub const MAX_INSERTED_NODES: usize = 10_000;
pub const MAX_NESTING_DEPTH: usize = 64;
pub const MAX_DOM_ID_BYTES: usize = 128;
pub const VARY_VALUE: &str = "Graft-Request, Accept";

/// Merge protocol variance into `Vary` without duplicates.
pub fn merge_vary(headers: &mut HeaderMap) {
    let values: Vec<String> = headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    if values.iter().any(|token| token == "*") {
        headers.insert(header::VARY, HeaderValue::from_static("*"));
        return;
    }
    let mut merged = Vec::new();
    for token in values
        .into_iter()
        .chain([GRAFT_REQUEST.to_owned(), "Accept".to_owned()])
    {
        if !merged
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&token))
        {
            merged.push(token);
        }
    }
    if let Ok(value) = HeaderValue::from_str(&merged.join(", ")) {
        headers.insert(header::VARY, value);
    }
}

fn no_store_status_response(status: StatusCode, body: &'static str) -> Response {
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
