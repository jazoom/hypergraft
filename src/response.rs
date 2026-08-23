//! Bounded Hypergraft response construction.

use askama::Template;
use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{MAX_PATCHES, MAX_RESPONSE_BYTES, MEDIA_TYPE, VERSION, merge_vary};

/// Stable classification of a failed patch build.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PatchBuildErrorKind {
    Rendering,
    DuplicateTarget,
    PatchLimit,
    EmptyBatch,
    InvalidTarget,
    ResponseLimit,
}

/// A failure to construct a valid bounded patch response.
#[derive(Debug)]
pub enum PatchBuildError {
    Rendering(askama::Error),
    DuplicateTarget,
    PatchLimit,
    EmptyBatch,
    InvalidTarget,
    ResponseLimit,
}

impl PatchBuildError {
    pub fn kind(&self) -> PatchBuildErrorKind {
        match self {
            Self::Rendering(_) => PatchBuildErrorKind::Rendering,
            Self::DuplicateTarget => PatchBuildErrorKind::DuplicateTarget,
            Self::PatchLimit => PatchBuildErrorKind::PatchLimit,
            Self::EmptyBatch => PatchBuildErrorKind::EmptyBatch,
            Self::InvalidTarget => PatchBuildErrorKind::InvalidTarget,
            Self::ResponseLimit => PatchBuildErrorKind::ResponseLimit,
        }
    }
}

impl std::fmt::Display for PatchBuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self.kind() {
            PatchBuildErrorKind::Rendering => "patch rendering failed",
            PatchBuildErrorKind::DuplicateTarget => "duplicate patch target",
            PatchBuildErrorKind::PatchLimit => "patch limit exceeded",
            PatchBuildErrorKind::EmptyBatch => "empty patch batch",
            PatchBuildErrorKind::InvalidTarget => "invalid patch target",
            PatchBuildErrorKind::ResponseLimit => "response byte limit exceeded",
        })
    }
}

impl std::error::Error for PatchBuildError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Rendering(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomId(String);

impl AsRef<str> for DomId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl DomId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidDomId> {
        let value = value.into();
        let mut bytes = value.bytes();
        let valid = value.len() <= 128
            && bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
            && bytes.all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b':' | b'.')
            });
        if valid {
            Ok(Self(value))
        } else {
            Err(InvalidDomId)
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct InvalidDomId;

impl std::fmt::Display for InvalidDomId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid DOM ID")
    }
}
impl std::error::Error for InvalidDomId {}

/// The closed set of statuses accepted for a version 1 patch batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PatchStatus {
    Ok,
    Unauthorized,
    Conflict,
    UnprocessableEntity,
    TooManyRequests(RetryAfter),
}

impl PatchStatus {
    fn status_code(self) -> StatusCode {
        match self {
            Self::Ok => StatusCode::OK,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Conflict => StatusCode::CONFLICT,
            Self::UnprocessableEntity => StatusCode::UNPROCESSABLE_ENTITY,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
        }
    }
}

/// Positive whole delta-seconds for a throttled response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryAfter(u64);

impl RetryAfter {
    pub fn seconds(seconds: u64) -> Option<Self> {
        (seconds > 0).then_some(Self(seconds))
    }
    pub fn from_duration(duration: std::time::Duration) -> Self {
        Self(
            duration
                .as_secs()
                .saturating_add(u64::from(duration.subsec_nanos() > 0))
                .max(1),
        )
    }
    pub fn apply(self, headers: &mut axum::http::HeaderMap) {
        headers.insert(
            header::RETRY_AFTER,
            HeaderValue::from_str(&self.0.to_string()).expect("delta-seconds is a valid header"),
        );
    }
    pub const fn as_seconds(self) -> u64 {
        self.0
    }
}

/// A version 1 patch batch. It cannot contain navigation metadata.
#[derive(Default)]
pub struct PatchSet {
    title: Option<String>,
    patches: Vec<(DomId, String)>,
}

impl PatchSet {
    pub fn new() -> Self {
        Self {
            title: None,
            patches: Vec::new(),
        }
    }

    pub fn title(mut self, value: impl Into<String>) -> Self {
        self.title = Some(value.into());
        self
    }

    pub fn children<T: Template>(
        &mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<(), PatchBuildError> {
        let target = DomId::new(target.as_ref()).map_err(|_| PatchBuildError::InvalidTarget)?;
        self.validate_new_target(&target)?;
        let html = template.render().map_err(PatchBuildError::Rendering)?;
        self.patches.push((target, html));
        Ok(())
    }

    pub fn with_children<T: Template>(
        mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<Self, PatchBuildError> {
        self.children(target, template)?;
        Ok(self)
    }

    fn validate_new_target(&self, target: &DomId) -> Result<(), PatchBuildError> {
        if self.patches.len() >= MAX_PATCHES {
            return Err(PatchBuildError::PatchLimit);
        }
        if self.patches.iter().any(|(existing, _)| existing == target) {
            return Err(PatchBuildError::DuplicateTarget);
        }
        Ok(())
    }

    pub fn respond(self, status: PatchStatus) -> Result<Response, PatchBuildError> {
        if self.patches.is_empty() {
            return Err(PatchBuildError::EmptyBatch);
        }
        let mut html = format!("<graft-patch-set version=\"{VERSION}\"");
        if let Some(title) = self.title {
            html.push_str(" title=\"");
            escape_attribute(&title, &mut html);
            html.push('"');
        }
        html.push('>');
        for (target, content) in self.patches {
            html.push_str("<graft-patch operation=\"children\" target=\"");
            escape_attribute(&target.0, &mut html);
            html.push_str("\"><template>");
            html.push_str(&content);
            html.push_str("</template></graft-patch>");
        }
        html.push_str("</graft-patch-set>");
        if html.len() > MAX_RESPONSE_BYTES {
            return Err(PatchBuildError::ResponseLimit);
        }
        let retry_after = match status {
            PatchStatus::TooManyRequests(value) => Some(value),
            _ => None,
        };
        let mut response = protocol_response(status.status_code(), html);
        if let Some(value) = retry_after {
            value.apply(response.headers_mut());
        }
        Ok(response)
    }
}

/// A validated local version 1 navigation, which can only respond with 200 OK.
pub struct Navigation {
    destination: String,
}

impl Navigation {
    pub fn new(destination: impl Into<String>) -> Result<Self, InvalidNavigation> {
        let destination = destination.into();
        validate_navigation(&destination)?;
        if navigation_envelope_len(&destination).ok_or(InvalidNavigation)? > MAX_RESPONSE_BYTES {
            return Err(InvalidNavigation);
        }
        Ok(Self { destination })
    }

    pub fn respond(self) -> Response {
        protocol_response(StatusCode::OK, navigation_envelope(&self.destination))
    }
}

fn navigation_envelope_len(destination: &str) -> Option<usize> {
    const PREFIX: &str = "<graft-patch-set version=\"";
    const MIDDLE: &str = "\" navigate=\"";
    const SUFFIX: &str = "\"></graft-patch-set>";

    let mut length = PREFIX
        .len()
        .checked_add(VERSION.len())?
        .checked_add(MIDDLE.len())?
        .checked_add(SUFFIX.len())?;
    if length.checked_add(destination.len())? > MAX_RESPONSE_BYTES {
        return Some(MAX_RESPONSE_BYTES + 1);
    }
    for byte in destination.bytes() {
        length = length.checked_add(match byte {
            b'&' => 5,
            b'"' | b'<' | b'>' => 6,
            _ => 1,
        })?;
        if length > MAX_RESPONSE_BYTES {
            return Some(length);
        }
    }
    Some(length)
}

fn navigation_envelope(destination: &str) -> String {
    let mut html = String::with_capacity(
        navigation_envelope_len(destination).expect("validated navigation length cannot overflow"),
    );
    html.push_str("<graft-patch-set version=\"");
    html.push_str(VERSION);
    html.push_str("\" navigate=\"");
    escape_attribute(destination, &mut html);
    html.push_str("\"></graft-patch-set>");
    html
}

fn protocol_response(status: StatusCode, html: String) -> Response {
    let mut response = (status, html).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(MEDIA_TYPE));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    merge_vary(response.headers_mut());
    response
}

#[derive(Clone, Copy, Debug)]
pub struct InvalidNavigation;

impl std::fmt::Display for InvalidNavigation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid local navigation destination")
    }
}
impl std::error::Error for InvalidNavigation {}

fn validate_navigation(destination: &str) -> Result<(), InvalidNavigation> {
    let bytes = destination.as_bytes();
    if bytes.first() != Some(&b'/')
        || bytes.get(1) == Some(&b'/')
        || !destination.is_ascii()
        || bytes.iter().any(|byte| byte.is_ascii_control())
        || destination.contains(['\\', '#'])
    {
        return Err(InvalidNavigation);
    }
    Ok(())
}

fn escape_attribute(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}

#[cfg(test)]
mod tests;
