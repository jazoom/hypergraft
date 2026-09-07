use askama::Template;
use axum::{
    extract::{Path, RawQuery, State, rejection::PathRejection},
    http::{HeaderValue, header},
    response::{Html, IntoResponse, Response},
};
use hypergraft::{GraftRequest, PageGraft, PatchBuildError, PatchSet, PatchStatus, outcome};

use crate::{AppState, security::no_store_response, state::Task};

const MAX_SEARCH_SCALARS: usize = 120;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StatusFilter {
    All,
    Open,
    Done,
}

impl StatusFilter {
    fn parse(value: &str) -> Self {
        match value {
            "open" => Self::Open,
            "done" => Self::Done,
            _ => Self::All,
        }
    }

    fn matches(self, task: &Task) -> bool {
        match self {
            Self::All => true,
            Self::Open => !task.done,
            Self::Done => task.done,
        }
    }

    fn is_all(self) -> bool {
        matches!(self, Self::All)
    }

    fn is_open(self) -> bool {
        matches!(self, Self::Open)
    }

    fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskQuery {
    pub search: String,
    pub status: StatusFilter,
}

impl TaskQuery {
    pub(crate) fn parse(query: &str) -> Self {
        let mut search = String::new();
        let mut status = StatusFilter::All;
        for (key, value) in form_urlencoded::parse(query.as_bytes()) {
            match key.as_ref() {
                "q" => search = normalise_search(&value),
                "status" => status = StatusFilter::parse(&value),
                _ => {}
            }
        }
        Self { search, status }
    }

    fn matches(&self, task: &Task) -> bool {
        if !self.status.matches(task) {
            return false;
        }
        if self.search.is_empty() {
            return true;
        }
        task.title
            .to_lowercase()
            .contains(&self.search.to_lowercase())
    }
}

fn normalise_search(value: &str) -> String {
    // Search inputs remove line breaks, and HTML cannot retain a null character.
    // Normalise before rendering so the controls and results use the same query.
    let value: String = value.chars().filter(|ch| !ch.is_control()).collect();
    let bounded: String = value.trim().chars().take(MAX_SEARCH_SCALARS).collect();
    bounded.trim_end().to_owned()
}

#[derive(Template)]
#[template(path = "document.html")]
struct Document<'a> {
    title: &'a str,
    body: &'a str,
}

#[derive(Template)]
#[template(path = "tasks.html")]
struct TasksPage<'a> {
    search: &'a str,
    status: StatusFilter,
    tasks: &'a [Task],
}

#[derive(Template)]
#[template(path = "task-filter.html")]
struct TaskFilter<'a> {
    search: &'a str,
    status: StatusFilter,
}

#[derive(Template)]
#[template(path = "task-results.html")]
struct TaskResults<'a> {
    tasks: &'a [Task],
}

#[derive(Template)]
#[template(path = "task.html")]
struct TaskPage<'a> {
    task: &'a Task,
}

pub enum AppError {
    NotFound,
    Internal,
}

impl From<PatchBuildError> for AppError {
    fn from(_: PatchBuildError) -> Self {
        Self::Internal
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => no_store_response(axum::http::StatusCode::NOT_FOUND, "Not found"),
            Self::Internal => no_store_response(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Server error",
            ),
        }
    }
}

pub async fn tasks(
    State(state): State<AppState>,
    graft: GraftRequest,
    RawQuery(raw): RawQuery,
) -> Result<Response, AppError> {
    let query = TaskQuery::parse(raw.as_deref().unwrap_or(""));
    let tasks: Vec<Task> = state
        .store
        .list()
        .into_iter()
        .filter(|task| query.matches(task))
        .collect();
    let page = TasksPage {
        search: &query.search,
        status: query.status,
        tasks: &tasks,
    };
    match graft {
        GraftRequest::Document => document("Tasks", &page),
        GraftRequest::Navigation => Ok(outcome::page_patch("Tasks", "main", &page)?),
        GraftRequest::Patch => Ok(PatchSet::new()
            .with_children(
                "task-filter",
                &TaskFilter {
                    search: &query.search,
                    status: query.status,
                },
            )?
            .with_children("task-results", &TaskResults { tasks: &tasks })?
            .respond(PatchStatus::Ok)?),
    }
}

pub async fn task(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    graft: PageGraft,
) -> Result<Response, AppError> {
    let Path(raw_id) = path.map_err(|_| AppError::NotFound)?;
    let id = raw_id.parse::<u64>().map_err(|_| AppError::NotFound)?;
    let task = state.store.get(id).ok_or(AppError::NotFound)?;
    let title = task.title.clone();
    let page = TaskPage { task: &task };
    match graft {
        PageGraft::Document => document(&title, &page),
        PageGraft::Navigation => Ok(outcome::page_patch(title, "main", &page)?),
    }
}

fn document(title: &str, page: &impl Template) -> Result<Response, AppError> {
    let body = page.render().map_err(|_| AppError::Internal)?;
    let markup = Document { title, body: &body }
        .render()
        .map_err(|_| AppError::Internal)?;
    let mut response = Html(markup).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
