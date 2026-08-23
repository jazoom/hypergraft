//! Hypergraft request classification and typed extractors.

use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};

use crate::{MEDIA_TYPE, merge_vary, no_store_status_response};

pub const GRAFT_REQUEST: &str = "Graft-Request";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GraftRequest {
    #[default]
    Document,
    Navigation,
    Patch,
}

impl GraftRequest {
    pub fn classify(headers: &HeaderMap) -> Result<Self, GraftMetadataError> {
        let request = singleton(headers, GRAFT_REQUEST)?;
        let accepts = headers.get_all(header::ACCEPT);
        let mut accept_values = accepts.iter();
        let accept = accept_values.next();
        if accept_values.next().is_some() {
            return Err(GraftMetadataError);
        }
        let exact_accept = accept == Some(&HeaderValue::from_static(MEDIA_TYPE));
        match request {
            None if exact_accept => Err(GraftMetadataError),
            None => Ok(Self::Document),
            Some(_) if !exact_accept => Err(GraftMetadataError),
            Some(value) if value == "navigation" => Ok(Self::Navigation),
            Some(value) if value == "patch" => Ok(Self::Patch),
            Some(_) => Err(GraftMetadataError),
        }
    }

    pub fn is_enhanced(self) -> bool {
        !matches!(self, Self::Document)
    }
}

fn singleton<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> Result<Option<&'a HeaderValue>, GraftMetadataError> {
    let mut values = headers.get_all(name).iter();
    let first = values.next();
    if values.next().is_some() {
        Err(GraftMetadataError)
    } else {
        Ok(first)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GraftMetadataError;

impl IntoResponse for GraftMetadataError {
    fn into_response(self) -> Response {
        let mut response = no_store_status_response(StatusCode::BAD_REQUEST, "Bad request");
        merge_vary(response.headers_mut());
        response
    }
}

impl<S: Send + Sync> FromRequestParts<S> for GraftRequest {
    type Rejection = GraftMetadataError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Self>()
            .copied()
            .ok_or(GraftMetadataError)
    }
}

/// Representation accepted by an ordinary page route.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PageGraft {
    Document,
    Navigation,
}

/// Representation accepted by a command route.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandGraft {
    Document,
    Patch,
}

impl PageGraft {
    pub const fn is_navigation(self) -> bool {
        matches!(self, Self::Navigation)
    }
}

impl CommandGraft {
    pub const fn is_patch(self) -> bool {
        matches!(self, Self::Patch)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for PageGraft {
    type Rejection = GraftMetadataError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<GraftRequest>().copied() {
            Some(GraftRequest::Document) => Ok(Self::Document),
            Some(GraftRequest::Navigation) => Ok(Self::Navigation),
            _ => Err(GraftMetadataError),
        }
    }
}

impl From<PageGraft> for GraftRequest {
    fn from(value: PageGraft) -> Self {
        match value {
            PageGraft::Document => Self::Document,
            PageGraft::Navigation => Self::Navigation,
        }
    }
}

impl TryFrom<GraftRequest> for PageGraft {
    type Error = GraftMetadataError;

    fn try_from(value: GraftRequest) -> Result<Self, Self::Error> {
        match value {
            GraftRequest::Document => Ok(Self::Document),
            GraftRequest::Navigation => Ok(Self::Navigation),
            GraftRequest::Patch => Err(GraftMetadataError),
        }
    }
}

impl From<CommandGraft> for GraftRequest {
    fn from(value: CommandGraft) -> Self {
        match value {
            CommandGraft::Document => Self::Document,
            CommandGraft::Patch => Self::Patch,
        }
    }
}

impl TryFrom<GraftRequest> for CommandGraft {
    type Error = GraftMetadataError;

    fn try_from(value: GraftRequest) -> Result<Self, Self::Error> {
        match value {
            GraftRequest::Document => Ok(Self::Document),
            GraftRequest::Patch => Ok(Self::Patch),
            GraftRequest::Navigation => Err(GraftMetadataError),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for CommandGraft {
    type Rejection = GraftMetadataError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<GraftRequest>().copied() {
            Some(GraftRequest::Document) => Ok(Self::Document),
            Some(GraftRequest::Patch) => Ok(Self::Patch),
            _ => Err(GraftMetadataError),
        }
    }
}

#[cfg(test)]
mod tests;
