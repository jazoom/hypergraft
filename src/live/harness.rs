use std::sync::Arc;

use axum::http::Extensions;
use tokio::sync::mpsc;

use crate::live::{
    GuardFailure, InstantiateError, LiveGuard, LiveProjection, LiveRouter, ProjectionError,
    codec::{DecodedLivePatch, decode_live_envelope},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HarnessError {
    Unregistered,
    Invalid,
    Retire,
    Guard(GuardFailure),
    Envelope,
}

impl From<InstantiateError> for HarnessError {
    fn from(value: InstantiateError) -> Self {
        match value {
            InstantiateError::Unregistered => Self::Unregistered,
            InstantiateError::Invalid => Self::Invalid,
            InstantiateError::Retire => Self::Retire,
        }
    }
}

/// In-process dispatch of projection factories and decoded live patches.
pub struct LiveHarness<S> {
    router: LiveRouter<S>,
    state: S,
}

struct HarnessListener(tokio::task::JoinHandle<()>);

impl Drop for HarnessListener {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub struct HarnessSession<G>
where
    G: LiveGuard,
{
    first: DecodedLivePatch,
    refresh: crate::live::RefreshFn<G::Context>,
    pending: mpsc::Receiver<()>,
    guard: G,
    connection: Arc<G::Connection>,
    _listener: HarnessListener,
    _projection: LiveProjection<G::Context>,
}

impl<S> LiveHarness<S>
where
    S: Clone + Send + Sync + 'static,
{
    pub fn new(router: LiveRouter<S>, state: S) -> Self {
        Self { router, state }
    }

    pub async fn subscribe<G>(&self, url: &str, guard: G) -> Result<HarnessSession<G>, HarnessError>
    where
        G: LiveGuard,
    {
        self.subscribe_with(url, guard, Extensions::new()).await
    }

    pub async fn subscribe_with<G>(
        &self,
        url: &str,
        guard: G,
        extensions: Extensions,
    ) -> Result<HarnessSession<G>, HarnessError>
    where
        G: LiveGuard,
    {
        let connection = Arc::new(guard.bind(&extensions).await.map_err(HarnessError::Guard)?);
        let context = guard
            .revalidate(connection.as_ref())
            .await
            .map_err(HarnessError::Guard)?;
        let mut projection = self
            .router
            .dispatch(&self.state, url, extensions, context)
            .await?;
        let mut invalidation = std::mem::replace(
            &mut projection.invalidation,
            Box::pin(futures_util::stream::pending()),
        );
        let (notify_tx, pending) = mpsc::channel(1);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let listener = HarnessListener(tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            while let Some(()) = futures_util::future::poll_fn(|context| {
                let event = invalidation.as_mut().poll_next(context);
                if let Some(ready_tx) = ready_tx.take() {
                    let _ = ready_tx.send(());
                }
                event
            })
            .await
            {
                let _ = notify_tx.try_send(());
            }
        }));
        let _ = ready_rx.await;
        let html =
            refresh_envelope(projection.refresh.as_ref(), &guard, connection.as_ref()).await?;
        let first = decode_live_envelope(&html).map_err(|_| HarnessError::Envelope)?;
        Ok(HarnessSession {
            first,
            refresh: Arc::clone(&projection.refresh),
            pending,
            guard,
            connection,
            _listener: listener,
            _projection: projection,
        })
    }
}

impl<G> HarnessSession<G>
where
    G: LiveGuard,
{
    pub fn first_patch(&self) -> &DecodedLivePatch {
        &self.first
    }

    pub async fn next_patch(&mut self) -> Result<DecodedLivePatch, HarnessError> {
        self.pending.recv().await.ok_or(HarnessError::Retire)?;
        while self.pending.try_recv().is_ok() {}
        let html =
            refresh_envelope(self.refresh.as_ref(), &self.guard, self.connection.as_ref()).await?;
        decode_live_envelope(&html).map_err(|_| HarnessError::Envelope)
    }
}

async fn refresh_envelope<C, G>(
    refresh: &(dyn Fn(C) -> crate::live::RefreshFuture + Send + Sync),
    guard: &G,
    connection: &G::Connection,
) -> Result<String, HarnessError>
where
    C: Clone + Send + Sync + 'static,
    G: LiveGuard<Context = C>,
{
    let context = guard
        .revalidate(connection)
        .await
        .map_err(HarnessError::Guard)?;
    match refresh(context).await {
        Ok(set) => set.encode_live().map_err(|_| HarnessError::Envelope),
        Err(ProjectionError::Retire) => Err(HarnessError::Retire),
    }
}
