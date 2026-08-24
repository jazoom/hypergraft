use crate::*;
use askama::Template;
use axum::{
    body::to_bytes,
    http::{StatusCode, header},
};
use futures_util::stream;
use serde_json::Value;

#[test]
fn validates_bounded_dom_ids() {
    for valid in ["main", "patient-results", "A:b.c_1"] {
        assert!(DomId::new(valid).is_ok());
    }
    for invalid in ["", "1main", "has space", "é"] {
        assert!(DomId::new(invalid).is_err());
    }
    assert!(DomId::new("a".repeat(129)).is_err());
}

#[derive(Template)]
#[template(source = "<p>{{ value }}</p>", ext = "html")]
struct Content<'a> {
    value: &'a str,
}

async fn body(response: Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[test]
fn validates_local_navigation_destinations() {
    for valid in [
        "/dashboard/account/preferences",
        "/dashboard/account/preferences?theme=updated",
    ] {
        assert!(Navigation::new(valid).is_ok(), "{valid}");
    }
    for invalid in [
        "",
        "dashboard/account/preferences",
        "//example.test/path",
        "/bad\\path",
        "/path#fragment",
        "https://example.test/path",
        "/path\u{1}",
        "/path\névil",
    ] {
        assert!(Navigation::new(invalid).is_err(), "{invalid:?}");
    }
}

#[tokio::test]
async fn navigation_is_always_ok_and_escapes_its_destination() {
    let response = Navigation::new("/patients?notice=a&quoted=\"yes\"")
        .unwrap()
        .respond();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], MEDIA_TYPE);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        response
            .headers()
            .get_all(header::VARY)
            .iter()
            .any(|value| value == "Graft-Request, Accept")
    );
    assert_eq!(
        body(response).await,
        "<graft-patch-set version=\"1\" navigate=\"/patients?notice=a&amp;quoted=&quot;yes&quot;\"></graft-patch-set>"
    );
}

#[tokio::test]
async fn patch_statuses_and_attributes_are_closed_and_escaped() {
    for (status, code) in [
        (PatchStatus::Ok, StatusCode::OK),
        (PatchStatus::Unauthorized, StatusCode::UNAUTHORIZED),
        (PatchStatus::Conflict, StatusCode::CONFLICT),
        (
            PatchStatus::UnprocessableEntity,
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            PatchStatus::TooManyRequests(RetryAfter::seconds(1).unwrap()),
            StatusCode::TOO_MANY_REQUESTS,
        ),
    ] {
        let mut patches = PatchSet::new().title("Patients & \"records\"");
        patches
            .children(DomId::new("A:b.c_1").unwrap(), &Content { value: "<safe>" })
            .unwrap();
        let response = patches.respond(status).unwrap();
        assert_eq!(response.status(), code);
        let html = body(response).await;
        assert!(html.contains("title=\"Patients &amp; &quot;records&quot;\""));
        assert!(html.contains("target=\"A:b.c_1\""));
        assert!(html.contains("<p>&#60;safe&#62;</p>"));
    }
}

#[test]
fn rejects_duplicate_and_seventeenth_targets_before_rendering() {
    let mut duplicate = PatchSet::new();
    duplicate
        .children(DomId::new("main").unwrap(), &Content { value: "one" })
        .unwrap();
    assert!(
        duplicate
            .children(DomId::new("main").unwrap(), &Content { value: "two" })
            .is_err()
    );

    let mut patches = PatchSet::new();
    for index in 0..MAX_PATCHES {
        patches
            .children(
                DomId::new(format!("target-{index}")).unwrap(),
                &Content { value: "safe" },
            )
            .unwrap();
    }
    assert!(
        patches
            .children(
                DomId::new("target-extra").unwrap(),
                &Content {
                    value: "never rendered"
                }
            )
            .is_err()
    );
    assert!(PatchSet::new().respond(PatchStatus::Ok).is_err());
}

#[tokio::test]
async fn matches_the_shared_version_one_fixture() {
    let fixture: Value = serde_json::from_str(include_str!("../../protocol-v1.json")).unwrap();
    assert_eq!(fixture["version"], VERSION);
    assert_eq!(fixture["mediaType"], MEDIA_TYPE);
    assert_eq!(
        fixture["patchStatuses"],
        serde_json::json!([200, 401, 409, 422, 429])
    );
    assert_eq!(fixture["navigationStatus"], 200);
    assert_eq!(
        fixture["operations"],
        serde_json::json!(["children", "append"])
    );
    assert_eq!(fixture["transfer"]["header"], GRAFT_TRANSFER);
    assert_eq!(
        fixture["transfer"]["kinds"],
        serde_json::json!(["complete", "stream"])
    );
    assert_eq!(fixture["phases"], serde_json::json!(["progress", "final"]));
    assert_eq!(
        fixture["streamStatuses"],
        serde_json::json!([200, 401, 409, 422])
    );
    assert_eq!(fixture["limits"]["responseBytes"], 1024 * 1024);
    assert_eq!(fixture["limits"]["patchCount"], MAX_PATCHES);
    assert_eq!(fixture["limits"]["insertedNodes"], 10_000);
    assert_eq!(fixture["limits"]["nestingDepth"], 64);
    assert_eq!(fixture["limits"]["streamFrames"], MAX_STREAM_FRAMES);
    assert_eq!(fixture["limits"]["streamBytes"], MAX_STREAM_BYTES);
    assert_eq!(fixture["id"]["pattern"], "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$");
    assert_eq!(fixture["id"]["maximumBytes"], 128);

    let mut patches = PatchSet::new().title("Fixture & title");
    patches
        .children(
            DomId::new("fixture-target").unwrap(),
            &Content { value: "Ready" },
        )
        .unwrap();
    assert_eq!(
        body(patches.respond(PatchStatus::Ok).unwrap()).await,
        fixture["representativePatch"]
    );
    assert_eq!(
        body(
            Navigation::new("/items?fixture=one&other=two")
                .unwrap()
                .respond()
        )
        .await,
        fixture["representativeNavigation"]
    );

    let progress = PatchSet::new()
        .with_append(
            DomId::new("fixture-target").unwrap(),
            &Content { value: "Ready" },
        )
        .unwrap()
        .encode_progress()
        .unwrap();
    assert_eq!(
        String::from_utf8(progress.into_bytes()).unwrap(),
        fixture["representativeStreamFrame"]
    );
}

fn escaped_navigation_len(destination: &str) -> usize {
    const PREFIX: &str = "<graft-patch-set version=\"1\" navigate=\"";
    const SUFFIX: &str = "\"></graft-patch-set>";
    let escaped: usize = destination
        .chars()
        .map(|character| match character {
            '&' => 5,
            '"' | '<' | '>' => 6,
            _ => 1,
        })
        .sum();
    PREFIX.len() + escaped + SUFFIX.len()
}

#[test]
fn navigation_construction_rejects_an_oversized_escaped_envelope() {
    let prefix = "<graft-patch-set version=\"1\" navigate=\"";
    let suffix = "\"></graft-patch-set>";
    let overhead = prefix.len() + suffix.len();
    let max_raw = MAX_RESPONSE_BYTES - overhead;
    let exact = format!("/{}", "a".repeat(max_raw - 1));
    assert_eq!(escaped_navigation_len(&exact), MAX_RESPONSE_BYTES);
    assert!(Navigation::new(exact).is_ok());

    let oversize = format!("/{}", "a".repeat(max_raw));
    assert!(escaped_navigation_len(&oversize) > MAX_RESPONSE_BYTES);
    assert!(Navigation::new(oversize).is_err());

    // Query characters expand when escaped, so a destination under the raw
    // byte budget can still exceed the envelope limit.
    let expanding = format!("/?{}", "&".repeat((max_raw - 2) / 5 + 1));
    assert!(expanding.len() < MAX_RESPONSE_BYTES);
    assert!(escaped_navigation_len(&expanding) > MAX_RESPONSE_BYTES);
    assert!(Navigation::new(expanding).is_err());
}

#[test]
fn stream_final_rejects_throttled_status() {
    let error = PatchSet::new()
        .with_children(DomId::new("main").unwrap(), &Content { value: "x" })
        .unwrap()
        .encode_final(PatchStatus::TooManyRequests(
            RetryAfter::seconds(1).unwrap(),
        ))
        .unwrap_err();
    assert_eq!(error.kind(), PatchBuildErrorKind::InvalidStatus);
}

#[tokio::test]
async fn stream_response_emits_one_final_frame_after_progress() {
    let progress = PatchSet::new()
        .with_append(DomId::new("main").unwrap(), &Content { value: "one" })
        .unwrap()
        .encode_progress()
        .unwrap();
    let final_frame = PatchSet::new()
        .with_append(DomId::new("main").unwrap(), &Content { value: "two" })
        .unwrap()
        .encode_final(PatchStatus::Ok)
        .unwrap();
    let expected = [progress.bytes.as_slice(), final_frame.bytes.as_slice()].concat();
    let response = crate::outcome::stream_response(stream::iter([progress, final_frame]));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[GRAFT_TRANSFER], "stream");
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        expected
    );
}

#[tokio::test]
async fn stream_response_rejects_an_incomplete_or_overlong_frame_sequence() {
    let progress = || {
        PatchSet::new()
            .with_append(DomId::new("main").unwrap(), &Content { value: "x" })
            .unwrap()
            .encode_progress()
            .unwrap()
    };
    let incomplete = crate::outcome::stream_response(stream::iter([progress()]));
    assert!(to_bytes(incomplete.into_body(), usize::MAX).await.is_err());

    let frames = (0..=MAX_STREAM_FRAMES)
        .map(|_| progress())
        .collect::<Vec<_>>();
    let overlong = crate::outcome::stream_response(stream::iter(frames));
    assert!(to_bytes(overlong.into_body(), usize::MAX).await.is_err());

    let final_frame = PatchSet::new()
        .with_append(DomId::new("main").unwrap(), &Content { value: "done" })
        .unwrap()
        .encode_final(PatchStatus::Ok)
        .unwrap();
    let after_final = crate::outcome::stream_response(stream::iter([final_frame, progress()]));
    assert!(to_bytes(after_final.into_body(), usize::MAX).await.is_err());
}
