//! Common negotiated Hypergraft outcomes.

use askama::Template;
use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{GraftRequest, InvalidNavigation, Navigation, PatchBuildError, PatchSet, PatchStatus};

/// Build a validated native redirect or complete-browser-navigation envelope.
pub fn redirect<G>(graft: G, destination: impl Into<String>) -> Result<Response, InvalidNavigation>
where
    G: Into<GraftRequest>,
{
    let destination = destination.into();
    // Validate before choosing either representation.
    let navigation = Navigation::new(destination.clone())?;
    if graft.into().is_enhanced() {
        return Ok(navigation.respond());
    }
    let mut response = StatusCode::SEE_OTHER.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&destination).map_err(|_| InvalidNavigation)?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    crate::merge_vary(response.headers_mut());
    Ok(response)
}

/// Build a titled, single-target page-navigation patch.
pub fn page_patch<T: Template>(
    title: impl Into<String>,
    target: impl AsRef<str>,
    template: &T,
) -> Result<Response, PatchBuildError> {
    PatchSet::new()
        .title(title)
        .with_children(target, template)?
        .respond(PatchStatus::Ok)
}

/// Build one retained-target patch at any accepted status.
pub fn children_patch<T: Template>(
    status: PatchStatus,
    target: impl AsRef<str>,
    content: &T,
) -> Result<Response, PatchBuildError> {
    PatchSet::new()
        .with_children(target, content)?
        .respond(status)
}
