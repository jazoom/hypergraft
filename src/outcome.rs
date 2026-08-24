//! Common negotiated Hypergraft outcomes.

use askama::Template;
use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{Stream, StreamExt, pin_mut};

use crate::{
    GRAFT_TRANSFER, GraftRequest, InvalidNavigation, MAX_STREAM_BYTES, MAX_STREAM_FRAMES,
    MEDIA_TYPE, Navigation, PatchBuildError, PatchSet, PatchStatus, StreamFrame, merge_vary,
};

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

/// Build a bounded 200 stream response from validated frames.
pub fn stream_response<S>(frames: S) -> Response
where
    S: Stream<Item = StreamFrame> + Send + 'static,
{
    let body = async_stream::try_stream! {
        pin_mut!(frames);
        let mut frame_count = 0usize;
        let mut byte_count = 0usize;
        let mut final_frame = None;

        while let Some(frame) = frames.next().await {
            if final_frame.is_some() {
                Err::<(), std::io::Error>(invalid_stream("frame after final frame"))?;
            }
            frame_count += 1;
            if frame_count > MAX_STREAM_FRAMES {
                Err::<(), std::io::Error>(invalid_stream("stream frame limit exceeded"))?;
            }
            byte_count = byte_count
                .checked_add(frame.byte_len())
                .ok_or_else(|| invalid_stream("stream byte limit exceeded"))?;
            if byte_count > MAX_STREAM_BYTES {
                Err::<(), std::io::Error>(invalid_stream("stream byte limit exceeded"))?;
            }
            if frame.is_final() {
                final_frame = Some(frame);
            } else {
                yield Bytes::from(frame.into_bytes());
            }
        }

        let final_frame = final_frame.ok_or_else(|| invalid_stream("final frame missing"))?;
        yield Bytes::from(final_frame.into_bytes());
    };
    let body = body.map(|result: Result<Bytes, std::io::Error>| result);
    let mut response = Response::new(Body::from_stream(body));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(MEDIA_TYPE));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(GRAFT_TRANSFER, HeaderValue::from_static("stream"));
    merge_vary(headers);
    response
}

fn invalid_stream(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}
