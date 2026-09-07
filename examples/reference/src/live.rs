use axum::{
    Router,
    extract::{RawQuery, State},
};
use hypergraft::{
    PatchSet,
    live::{
        self, AdmissionPermit, GuardFailure, LiveGuard, LiveProjection, LiveReject, LiveRouter,
        LiveSocketConfig, ProjectionError, SocketAdmission,
    },
};

use crate::{
    AppState,
    pages::{TaskQuery, TaskResults},
    security,
};

// One process-local key bounds anonymous sockets. The example has no user identity.
const ANONYMOUS_ADMISSION_KEY: &str = "anon";
const ANONYMOUS_SOCKET_LIMIT: usize = 8;

struct AnonymousConnection {
    _permit: AdmissionPermit<&'static str>,
}

#[derive(Clone)]
struct AnonymousGuard {
    admission: SocketAdmission<&'static str>,
}

impl AnonymousGuard {
    fn new() -> Self {
        Self {
            admission: SocketAdmission::new(),
        }
    }
}

impl LiveGuard for AnonymousGuard {
    type Connection = AnonymousConnection;
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        self.admission
            .try_acquire(ANONYMOUS_ADMISSION_KEY, ANONYMOUS_SOCKET_LIMIT)
            .map(|permit| AnonymousConnection { _permit: permit })
            .map_err(|_| GuardFailure::Retryable)
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}

pub(crate) fn service() -> Router<AppState> {
    let router = LiveRouter::new()
        .route("/tasks", tasks_live)
        .expect("the list projection path is unique");
    live::service(
        security::live_endpoint(),
        LiveSocketConfig::default(),
        router,
        AnonymousGuard::new(),
    )
}

async fn tasks_live(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<LiveProjection<()>, LiveReject> {
    let query = TaskQuery::parse(raw.as_deref().unwrap_or(""));
    // Subscribe before the first refresh so a mutation cannot miss this projection.
    let invalidations = state.store.subscribe();
    let store = state.store.clone();
    Ok(LiveProjection::new(
        live::broadcast_invalidations(invalidations),
        move |_ctx| {
            let query = query.clone();
            let store = store.clone();
            async move {
                let tasks: Vec<_> = store
                    .list()
                    .into_iter()
                    .filter(|task| query.matches(task))
                    .collect();
                PatchSet::new()
                    .with_children("task-results", &TaskResults { tasks: &tasks })
                    .map_err(|_| ProjectionError::Retire)
            }
        },
    ))
}
