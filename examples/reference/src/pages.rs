use askama::Template;
use axum::{
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderValue, header},
    response::{Html, IntoResponse, Response},
};
use hypergraft::{PageGraft, PatchBuildError, outcome};

use crate::{AppState, security::no_store_response, state::Task};

#[derive(Template)]
#[template(path = "document.html")]
struct Document<'a> {
    title: &'a str,
    body: &'a str,
}

#[derive(Template)]
#[template(path = "tasks.html")]
struct TasksPage<'a> {
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

pub async fn tasks(State(state): State<AppState>, graft: PageGraft) -> Result<Response, AppError> {
    let tasks = state.store.list();
    let page = TasksPage { tasks: &tasks };
    match graft {
        PageGraft::Document => document("Tasks", &page),
        PageGraft::Navigation => Ok(outcome::page_patch("Tasks", "main", &page)?),
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
