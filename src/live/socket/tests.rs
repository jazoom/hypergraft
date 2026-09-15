use super::*;
use crate::{PatchSet, live::GuardFailure};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
struct UnitGuard;

impl LiveGuard for UnitGuard {
    type Connection = ();
    type Context = ();

    async fn bind(&self, _: &Extensions) -> Result<(), GuardFailure> {
        Ok(())
    }

    async fn revalidate(&self, _: &()) -> Result<(), GuardFailure> {
        Ok(())
    }
}

#[derive(askama::Template)]
#[template(source = "row", ext = "html")]
struct Content;

impl crate::GraftTemplate for Content {
    fn render_into(&self, output: &mut String) -> Result<(), crate::TemplateError> {
        askama::Template::render_into(self, output).map_err(|_| crate::TemplateError::Rendering)
    }
}

#[tokio::test]
async fn outbound_admission_precedes_refresh_and_releases_bytes_on_cancel_and_drop() {
    let (tx, mut rx) = mpsc::channel(1);
    let outbound = OutboundQueue {
        tx,
        bytes: Arc::new(Semaphore::new(MAX_OUTBOUND_BYTES)),
    };
    // Simulate other frames that leave room for exactly one maximum-size reservation.
    let occupied = outbound
        .bytes
        .clone()
        .acquire_many_owned((MAX_OUTBOUND_BYTES - MAX_FRAME_BYTES) as u32)
        .await
        .unwrap();
    let refreshes = Semaphore::new(1);
    let calls = AtomicUsize::new(0);
    let refresh = |()| -> crate::live::RefreshFuture {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(PatchSet::new().with_children("results", &Content).unwrap()) })
    };
    let (_cancel_tx, mut cancel_rx) = oneshot::channel();
    assert!(matches!(
        refresh_once(
            1,
            &refresh,
            &UnitGuard,
            &(),
            &refreshes,
            &outbound,
            &mut cancel_rx
        )
        .await,
        Ok(false)
    ));
    let patch = rx.recv().await.unwrap();
    assert_eq!(
        outbound.bytes.available_permits(),
        MAX_FRAME_BYTES - patch.bytes.len()
    );

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let waiting = refresh_once(
        2,
        &refresh,
        &UnitGuard,
        &(),
        &refreshes,
        &outbound,
        &mut cancel_rx,
    );
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    cancel_tx.send(()).unwrap();
    assert!(matches!(waiting.await, Ok(true)));

    // Dequeue alone does not release bytes. The frame retains them through the socket write.
    drop(patch.bytes);
    assert!(outbound.bytes.available_permits() < MAX_FRAME_BYTES);
    drop(patch._permit);
    assert_eq!(outbound.bytes.available_permits(), MAX_FRAME_BYTES);

    let (_cancel_tx, mut cancel_rx) = oneshot::channel();
    assert!(matches!(
        refresh_once(
            3,
            &refresh,
            &UnitGuard,
            &(),
            &refreshes,
            &outbound,
            &mut cancel_rx
        )
        .await,
        Ok(false)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    drop(rx);
    drop(occupied);
    assert_eq!(outbound.bytes.available_permits(), MAX_OUTBOUND_BYTES);

    let pending_refresh = |()| -> crate::live::RefreshFuture { Box::pin(std::future::pending()) };
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let active = refresh_once(
        4,
        &pending_refresh,
        &UnitGuard,
        &(),
        &refreshes,
        &outbound,
        &mut cancel_rx,
    );
    tokio::pin!(active);
    assert!(futures_util::poll!(&mut active).is_pending());
    assert_eq!(
        outbound.bytes.available_permits(),
        MAX_OUTBOUND_BYTES - MAX_FRAME_BYTES
    );
    cancel_tx.send(()).unwrap();
    assert!(matches!(active.await, Ok(true)));
    assert_eq!(outbound.bytes.available_permits(), MAX_OUTBOUND_BYTES);
}
