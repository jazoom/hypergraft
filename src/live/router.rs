use std::{any::Any, marker::PhantomData, sync::Arc, sync::Mutex};

use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{Extensions, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use tower::ServiceExt;

use crate::live::{LiveProjection, ProjectionError};

tokio::task_local! {
    static LIVE_OUTPUT: LiveOutputSlot;
}

#[derive(Clone, Default)]
struct LiveOutputSlot(Arc<Mutex<LiveOutput>>);

#[derive(Default)]
enum LiveOutput {
    #[default]
    Empty,
    Projection(Box<dyn Any + Send>),
    Reject(LiveReject),
}

impl LiveOutputSlot {
    fn store_projection<C: Send + 'static>(&self, projection: LiveProjection<C>) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) =
            LiveOutput::Projection(Box::new(projection));
    }

    fn store_reject(&self, reject: LiveReject) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = LiveOutput::Reject(reject);
    }

    fn take<C: Send + 'static>(&self) -> Result<LiveProjection<C>, InstantiateError> {
        match std::mem::replace(
            &mut *self.0.lock().unwrap_or_else(|error| error.into_inner()),
            LiveOutput::Empty,
        ) {
            LiveOutput::Projection(value) => value
                .downcast::<LiveProjection<C>>()
                .map(|value| *value)
                .map_err(|_| InstantiateError::Invalid),
            LiveOutput::Reject(LiveReject::Invalid) => Err(InstantiateError::Invalid),
            LiveOutput::Reject(LiveReject::Retire) => Err(InstantiateError::Retire),
            LiveOutput::Empty => Err(InstantiateError::Invalid),
        }
    }
}

/// Factory rejection that does not close the socket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveReject {
    Invalid,
    Retire,
}

impl IntoResponse for LiveReject {
    fn into_response(self) -> Response {
        let _ = LIVE_OUTPUT.try_with(|slot| slot.store_reject(self));
        axum::http::StatusCode::NO_CONTENT.into_response()
    }
}

impl<C> IntoResponse for LiveProjection<C>
where
    C: Send + 'static,
{
    fn into_response(self) -> Response {
        let _ = LIVE_OUTPUT.try_with(|slot| slot.store_projection(self));
        axum::http::StatusCode::OK.into_response()
    }
}

impl From<ProjectionError> for LiveReject {
    fn from(_: ProjectionError) -> Self {
        Self::Retire
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstantiateError {
    Unregistered,
    Invalid,
    Retire,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveRouterError {
    Conflict(String),
}

impl std::fmt::Display for LiveRouterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(_) => formatter.write_str("duplicate or ambiguous live projection path"),
        }
    }
}

impl std::error::Error for LiveRouterError {}

/// Composable projection router keyed by canonical GET paths.
pub struct LiveRouter<S> {
    inner: Router<S>,
    matcher: matchit::Router<()>,
    paths: Vec<String>,
    _state: PhantomData<fn() -> S>,
}

impl<S> LiveRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        Self {
            inner: Router::new(),
            matcher: matchit::Router::new(),
            paths: Vec::new(),
            _state: PhantomData,
        }
    }

    pub fn route<H, T>(mut self, path: &str, factory: H) -> Result<Self, LiveRouterError>
    where
        H: axum::handler::Handler<T, S>,
        T: 'static,
    {
        self.matcher
            .insert(path, ())
            .map_err(|_| LiveRouterError::Conflict(path.to_owned()))?;
        self.paths.push(path.to_owned());
        self.inner = self.inner.route(path, get(factory));
        Ok(self)
    }

    pub fn merge(mut self, other: Self) -> Result<Self, LiveRouterError> {
        for path in &other.paths {
            self.matcher
                .insert(path, ())
                .map_err(|_| LiveRouterError::Conflict(path.clone()))?;
            self.paths.push(path.clone());
        }
        self.inner = self.inner.merge(other.inner);
        Ok(self)
    }

    pub(crate) fn matches(&self, path: &str) -> bool {
        self.matcher.at(path).is_ok()
    }

    pub(crate) async fn dispatch<C>(
        &self,
        state: &S,
        path_and_query: &str,
        mut extensions: Extensions,
        context: C,
    ) -> Result<LiveProjection<C>, InstantiateError>
    where
        C: Clone + Send + Sync + 'static,
    {
        let uri: Uri = path_and_query
            .parse()
            .map_err(|_| InstantiateError::Invalid)?;
        if !self.matches(uri.path()) {
            return Err(InstantiateError::Unregistered);
        }
        extensions.insert(context);
        let mut request = Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .map_err(|_| InstantiateError::Invalid)?;
        *request.extensions_mut() = extensions;
        let slot = LiveOutputSlot::default();
        let result = LIVE_OUTPUT
            .scope(slot.clone(), async {
                self.inner
                    .clone()
                    .with_state(state.clone())
                    .oneshot(request)
                    .await
            })
            .await;
        match result {
            Ok(_) => slot.take(),
            Err(infallible) => match infallible {},
        }
    }
}

impl<S> Default for LiveRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

impl<S> Clone for LiveRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            matcher: {
                let mut matcher = matchit::Router::new();
                for path in &self.paths {
                    matcher
                        .insert(path, ())
                        .expect("cloned live paths remain unique");
                }
                matcher
            },
            paths: self.paths.clone(),
            _state: PhantomData,
        }
    }
}
