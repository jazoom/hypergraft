//! Bounded Hypergraft response construction.

use askama::Template;
use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{
    MAX_PATCHES, MAX_RESPONSE_BYTES, MAX_STREAM_BYTES, MAX_STREAM_FRAMES, MEDIA_TYPE, VERSION,
    merge_vary,
};

pub const GRAFT_TRANSFER: &str = "Graft-Transfer";

/// Stable classification of a failed patch build.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PatchBuildErrorKind {
    Rendering,
    DuplicateTarget,
    PatchLimit,
    EmptyBatch,
    InvalidTarget,
    InvalidStatus,
    InvalidLocation,
    InvalidLiveEnvelope,
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
    InvalidStatus,
    InvalidLocation,
    InvalidLiveEnvelope,
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
            Self::InvalidStatus => PatchBuildErrorKind::InvalidStatus,
            Self::InvalidLocation => PatchBuildErrorKind::InvalidLocation,
            Self::InvalidLiveEnvelope => PatchBuildErrorKind::InvalidLiveEnvelope,
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
            PatchBuildErrorKind::InvalidStatus => "stream cannot carry that status",
            PatchBuildErrorKind::InvalidLocation => "invalid patch location",
            PatchBuildErrorKind::InvalidLiveEnvelope => {
                "live envelope cannot carry titles, locations, phases or statuses"
            }
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
    /// HTTP status for this patch outcome.
    ///
    /// A native document response uses this status.
    /// The document then matches the Hypergraft patch for the same result.
    pub fn status_code(self) -> StatusCode {
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

/// A validated length-prefixed envelope for a bounded stream response.
#[derive(Debug)]
pub struct StreamFrame {
    bytes: Vec<u8>,
    final_frame: bool,
}

impl StreamFrame {
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn is_final(&self) -> bool {
        self.final_frame
    }
}

const fn decimal_digit_count(mut value: usize) -> usize {
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

const RESERVED_FINAL_FRAMES: usize = 1;
// A maximum final envelope on the wire is "{len}\n{envelope}".
const RESERVED_FINAL_FRAME_BYTES: usize =
    decimal_digit_count(MAX_RESPONSE_BYTES) + 1 + MAX_RESPONSE_BYTES;

/// Progress capacity for one version 1 stream.
///
/// Progress never consumes the last frame or the bytes for one maximum
/// final envelope. That reservation lets the host send a settlement frame
/// after progress capacity is exhausted.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamBudget {
    frames_used: usize,
    bytes_used: usize,
}

/// A frame that cannot consume progress capacity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamCapacityError {
    FinalFrame,
    FrameLimit,
    ByteLimit,
}

impl StreamBudget {
    pub const fn new() -> Self {
        Self {
            frames_used: 0,
            bytes_used: 0,
        }
    }

    /// Account for one progress frame if the reserved final frame still fits.
    pub fn try_progress(&mut self, frame: &StreamFrame) -> Result<(), StreamCapacityError> {
        if frame.is_final() {
            return Err(StreamCapacityError::FinalFrame);
        }
        let next_frames = self
            .frames_used
            .checked_add(1)
            .ok_or(StreamCapacityError::FrameLimit)?;
        if next_frames.saturating_add(RESERVED_FINAL_FRAMES) > MAX_STREAM_FRAMES {
            return Err(StreamCapacityError::FrameLimit);
        }

        let next_bytes = self
            .bytes_used
            .checked_add(frame.byte_len())
            .ok_or(StreamCapacityError::ByteLimit)?;
        if next_bytes.saturating_add(RESERVED_FINAL_FRAME_BYTES) > MAX_STREAM_BYTES {
            return Err(StreamCapacityError::ByteLimit);
        }

        self.frames_used = next_frames;
        self.bytes_used = next_bytes;
        Ok(())
    }
}

impl std::fmt::Display for StreamCapacityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::FinalFrame => "final frame cannot consume progress capacity",
            Self::FrameLimit => "stream frame limit exceeded",
            Self::ByteLimit => "stream byte limit exceeded",
        })
    }
}

impl std::error::Error for StreamCapacityError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PatchOperation {
    Children,
    Append,
}

impl PatchOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Children => "children",
            Self::Append => "append",
        }
    }
}

/// A version 1 patch batch with an optional canonical location replacement.
#[derive(Default)]
pub struct PatchSet {
    title: Option<String>,
    location: Option<String>,
    patches: Vec<(DomId, PatchOperation, String)>,
}

impl PatchSet {
    pub fn new() -> Self {
        Self {
            title: None,
            location: None,
            patches: Vec::new(),
        }
    }

    pub fn title(mut self, value: impl Into<String>) -> Self {
        self.title = Some(value.into());
        self
    }

    /// Replace the browser location after this complete patch applies.
    pub fn replace_location(
        &mut self,
        destination: impl Into<String>,
    ) -> Result<(), PatchBuildError> {
        let destination = destination.into();
        validate_navigation(&destination).map_err(|_| PatchBuildError::InvalidLocation)?;
        self.location = Some(destination);
        Ok(())
    }

    /// Add a browser location replacement to this complete patch.
    pub fn with_replace_location(
        mut self,
        destination: impl Into<String>,
    ) -> Result<Self, PatchBuildError> {
        self.replace_location(destination)?;
        Ok(self)
    }

    pub fn children<T: Template>(
        &mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<(), PatchBuildError> {
        self.push(target, PatchOperation::Children, template)
    }

    pub fn with_children<T: Template>(
        mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<Self, PatchBuildError> {
        self.children(target, template)?;
        Ok(self)
    }

    pub fn append<T: Template>(
        &mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<(), PatchBuildError> {
        self.push(target, PatchOperation::Append, template)
    }

    pub fn with_append<T: Template>(
        mut self,
        target: impl AsRef<str>,
        template: &T,
    ) -> Result<Self, PatchBuildError> {
        self.append(target, template)?;
        Ok(self)
    }

    fn push<T: Template>(
        &mut self,
        target: impl AsRef<str>,
        operation: PatchOperation,
        template: &T,
    ) -> Result<(), PatchBuildError> {
        let target = DomId::new(target.as_ref()).map_err(|_| PatchBuildError::InvalidTarget)?;
        self.validate_new_target(&target)?;
        let html = template.render().map_err(PatchBuildError::Rendering)?;
        self.patches.push((target, operation, html));
        Ok(())
    }

    fn validate_new_target(&self, target: &DomId) -> Result<(), PatchBuildError> {
        if self.patches.len() >= MAX_PATCHES {
            return Err(PatchBuildError::PatchLimit);
        }
        if self
            .patches
            .iter()
            .any(|(existing, _, _)| existing == target)
        {
            return Err(PatchBuildError::DuplicateTarget);
        }
        Ok(())
    }

    pub fn respond(self, status: PatchStatus) -> Result<Response, PatchBuildError> {
        let html = self.render_envelope(None, None)?;
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

    /// Encode a live projection envelope.
    ///
    /// Live envelopes cannot carry titles, locations, navigation, phases or statuses.
    pub fn encode_live(self) -> Result<String, PatchBuildError> {
        if self.title.is_some() || self.location.is_some() {
            return Err(PatchBuildError::InvalidLiveEnvelope);
        }
        self.render_envelope(None, None)
    }

    /// Length-prefixed progress frame for a `Graft-Transfer: stream` body.
    pub fn encode_progress(self) -> Result<StreamFrame, PatchBuildError> {
        self.encode_frame(Some("progress"), None)
    }

    /// Length-prefixed final frame. Stream settlement cannot carry 429.
    pub fn encode_final(self, status: PatchStatus) -> Result<StreamFrame, PatchBuildError> {
        if matches!(status, PatchStatus::TooManyRequests(_)) {
            return Err(PatchBuildError::InvalidStatus);
        }
        self.encode_frame(Some("final"), Some(status.status_code().as_u16()))
    }

    fn encode_frame(
        self,
        phase: Option<&'static str>,
        status: Option<u16>,
    ) -> Result<StreamFrame, PatchBuildError> {
        if self.location.is_some() {
            return Err(PatchBuildError::InvalidLocation);
        }
        let html = self.render_envelope(phase, status)?;
        let mut bytes = html.len().to_string().into_bytes();
        bytes.push(b'\n');
        bytes.extend_from_slice(html.as_bytes());
        Ok(StreamFrame {
            bytes,
            final_frame: phase == Some("final"),
        })
    }

    fn render_envelope(
        self,
        phase: Option<&str>,
        status: Option<u16>,
    ) -> Result<String, PatchBuildError> {
        if self.patches.is_empty() {
            return Err(PatchBuildError::EmptyBatch);
        }
        let mut html = format!("<graft-patch-set version=\"{VERSION}\"");
        if let Some(title) = self.title {
            html.push_str(" title=\"");
            escape_attribute(&title, &mut html);
            html.push('"');
        }
        if let Some(location) = self.location {
            html.push_str(" location=\"");
            escape_attribute(&location, &mut html);
            html.push('"');
        }
        if let Some(phase) = phase {
            html.push_str(" phase=\"");
            html.push_str(phase);
            html.push('"');
        }
        if let Some(status) = status {
            html.push_str(" status=\"");
            html.push_str(&status.to_string());
            html.push('"');
        }
        html.push('>');
        for (target, operation, content) in self.patches {
            html.push_str("<graft-patch operation=\"");
            html.push_str(operation.as_str());
            html.push_str("\" target=\"");
            escape_attribute(&target.0, &mut html);
            html.push_str("\"><template>");
            html.push_str(&content);
            html.push_str("</template></graft-patch>");
        }
        html.push_str("</graft-patch-set>");
        if html.len() > MAX_RESPONSE_BYTES {
            return Err(PatchBuildError::ResponseLimit);
        }
        Ok(html)
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

pub(crate) fn validate_navigation(destination: &str) -> Result<(), InvalidNavigation> {
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
