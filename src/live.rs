//! Bounded WebSocket live projections for Hypergraft version 1.

mod admission;
mod codec;
mod endpoint;
mod harness;
mod router;
mod socket;

use std::{future::Future, pin::Pin, sync::Arc};

use futures_util::Stream;
use tokio::sync::broadcast;

pub use admission::{AdmissionDenied, AdmissionPermit, SocketAdmission};
pub use codec::{
    CloseClass, ControlMessage, DecodedLivePatch, DecodedPatch, LiveFrameError,
    decode_live_envelope, decode_patch_frame, encode_patch_frame,
};
pub use endpoint::{LiveEndpoint, LiveEndpointError};
pub use harness::{HarnessError, HarnessSession, LiveHarness};
pub use router::{InstantiateError, LiveReject, LiveRouter, LiveRouterError};
pub use socket::service;

pub const SUBPROTOCOL: &str = "hypergraft.v1";
pub const DEFAULT_PATH: &str = "/_hypergraft/live";
pub const MAX_SUBSCRIPTIONS: usize = 64;
pub const MAX_PROJECTION_URL_BYTES: usize = 8 * 1024;
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_INBOUND_CONTROLS: usize = 4096;
pub const MAX_OUTBOUND_MESSAGES: usize = 4096;
pub const MAX_OUTBOUND_BYTES: usize = 128 * 1024 * 1024;
pub const LEASE_SECONDS: u64 = 300;
pub const HEARTBEAT_SECONDS: u64 = 15;
pub const RETRY_MIN_SECONDS: u64 = 1;
pub const RETRY_MAX_SECONDS: u64 = 30;
pub const SUBSCRIPTION_HEADER_BYTES: usize = 4;
pub const CLOSE_RETRYABLE: u16 = 4000;
pub const CLOSE_TERMINAL: u16 = 4001;
pub const CLOSE_PROTOCOL: u16 = 4002;
pub const CLOSE_LEASE_EXPIRY: u16 = 4003;
pub const CLOSE_RESYNCHRONISATION: u16 = 4004;

pub(crate) type RefreshFuture =
    Pin<Box<dyn Future<Output = Result<PatchSet, ProjectionError>> + Send>>;
pub(crate) type RefreshFn<C> = Arc<dyn Fn(C) -> RefreshFuture + Send + Sync>;

use crate::PatchSet;

/// A guard binds one opaque value from the upgrade request.
/// Hypergraft passes that value back for each fresh context.
pub trait LiveGuard: Clone + Send + Sync + 'static {
    type Connection: Send + Sync + 'static;
    type Context: Clone + Send + Sync + 'static;

    fn bind(
        &self,
        extensions: &axum::http::Extensions,
    ) -> impl Future<Output = Result<Self::Connection, GuardFailure>> + Send;

    fn revalidate(
        &self,
        connection: &Self::Connection,
    ) -> impl Future<Output = Result<Self::Context, GuardFailure>> + Send;
}

/// Terminal or retryable failure of the connection guard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardFailure {
    Retryable,
    Terminal,
}

impl GuardFailure {
    pub const fn close_class(self) -> CloseClass {
        match self {
            Self::Retryable => CloseClass::Retryable,
            Self::Terminal => CloseClass::Terminal,
        }
    }
}

/// A projection factory retires only its own subscription.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionError {
    Retire,
}

/// Invalidation source, refresh function and optional lifetime guard.
pub struct LiveProjection<C> {
    pub(crate) invalidation: Pin<Box<dyn Stream<Item = ()> + Send>>,
    pub(crate) refresh: RefreshFn<C>,
    pub(crate) lifetime: Option<Box<dyn Send>>,
}

impl<C> LiveProjection<C>
where
    C: Send + 'static,
{
    pub fn new<I, F, Fut>(invalidation: I, refresh: F) -> Self
    where
        I: Stream<Item = ()> + Send + 'static,
        F: Fn(C) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<PatchSet, ProjectionError>> + Send + 'static,
    {
        Self {
            invalidation: Box::pin(invalidation),
            refresh: Arc::new(move |context| Box::pin(refresh(context))),
            lifetime: None,
        }
    }

    pub fn with_lifetime<T>(mut self, lifetime: T) -> Self
    where
        T: Send + 'static,
    {
        self.lifetime = Some(Box::new(lifetime));
        self
    }
}

/// Convert a broadcast receiver into current-truth invalidations.
///
/// Lag yields one refresh of current truth. A closed sender ends the stream.
pub fn broadcast_invalidations<T>(receiver: broadcast::Receiver<T>) -> impl Stream<Item = ()> + Send
where
    T: Clone + Send + 'static,
{
    futures_util::stream::unfold(receiver, |mut receiver| async move {
        match receiver.recv().await {
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => Some(((), receiver)),
            Err(broadcast::error::RecvError::Closed) => None,
        }
    })
}

/// Host-configurable socket admission limits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveSocketConfig {
    pub(crate) max_subscriptions: usize,
    pub(crate) max_concurrent_refreshes: usize,
}

impl Default for LiveSocketConfig {
    fn default() -> Self {
        Self {
            max_subscriptions: MAX_SUBSCRIPTIONS,
            max_concurrent_refreshes: 4,
        }
    }
}

impl LiveSocketConfig {
    pub fn max_subscriptions(self, limit: usize) -> Result<Self, LiveConfigError> {
        if (1..=MAX_SUBSCRIPTIONS).contains(&limit) {
            Ok(Self {
                max_subscriptions: limit,
                ..self
            })
        } else {
            Err(LiveConfigError::SubscriptionLimit)
        }
    }

    pub fn max_concurrent_refreshes(self, limit: usize) -> Result<Self, LiveConfigError> {
        if (1..=tokio::sync::Semaphore::MAX_PERMITS).contains(&limit) {
            Ok(Self {
                max_concurrent_refreshes: limit,
                ..self
            })
        } else {
            Err(LiveConfigError::RefreshLimit)
        }
    }

    pub const fn subscription_limit(&self) -> usize {
        self.max_subscriptions
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveConfigError {
    SubscriptionLimit,
    RefreshLimit,
}

impl std::fmt::Display for LiveConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::SubscriptionLimit => "subscription limit must be from 1 to 64",
            Self::RefreshLimit => "concurrent refresh limit is outside the supported range",
        })
    }
}

impl std::error::Error for LiveConfigError {}

#[cfg(test)]
mod tests;
