use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
};

use crate::*;

fn headers(graft: &[&str], accept: &[&str]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for value in graft {
        headers.append(GRAFT_REQUEST, HeaderValue::from_str(value).unwrap());
    }
    for value in accept {
        headers.append(header::ACCEPT, HeaderValue::from_str(value).unwrap());
    }
    headers
}

#[test]
fn classifies_exact_metadata() {
    assert_eq!(
        GraftRequest::classify(&HeaderMap::new()).unwrap(),
        GraftRequest::Document
    );
    assert_eq!(
        GraftRequest::classify(&headers(&["navigation"], &[MEDIA_TYPE])).unwrap(),
        GraftRequest::Navigation
    );
    assert_eq!(
        GraftRequest::classify(&headers(&["patch"], &[MEDIA_TYPE])).unwrap(),
        GraftRequest::Patch
    );
}

#[test]
fn rejects_incomplete_duplicate_and_unknown_metadata() {
    for headers in [
        headers(&["patch"], &[]),
        headers(&[], &[MEDIA_TYPE]),
        headers(&["other"], &[MEDIA_TYPE]),
        headers(&["patch", "patch"], &[MEDIA_TYPE]),
        headers(&["patch"], &[MEDIA_TYPE, MEDIA_TYPE]),
    ] {
        assert!(GraftRequest::classify(&headers).is_err());
    }
}

#[tokio::test]
async fn route_shape_extractors_accept_only_their_closed_representations() {
    async fn page(value: GraftRequest) -> Result<PageGraft, GraftMetadataError> {
        let (mut parts, _) = Request::new(()).into_parts();
        parts.extensions.insert(value);
        PageGraft::from_request_parts(&mut parts, &()).await
    }
    async fn patch(value: GraftRequest) -> Result<PatchGraft, GraftMetadataError> {
        let (mut parts, _) = Request::new(()).into_parts();
        parts.extensions.insert(value);
        PatchGraft::from_request_parts(&mut parts, &()).await
    }

    assert_eq!(
        page(GraftRequest::Document).await.unwrap(),
        PageGraft::Document
    );
    assert_eq!(
        page(GraftRequest::Navigation).await.unwrap(),
        PageGraft::Navigation
    );
    assert!(page(GraftRequest::Patch).await.is_err());
    assert!(patch(GraftRequest::Patch).await.is_ok());
    let rejection = patch(GraftRequest::Document)
        .await
        .unwrap_err()
        .into_response();
    assert_eq!(rejection.status(), StatusCode::BAD_REQUEST);
    assert!(patch(GraftRequest::Navigation).await.is_err());
    assert_eq!(rejection.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(rejection.headers()[header::VARY], "Graft-Request, Accept");
}
