use axum::{
    extract::{
        DefaultBodyLimit, Path, RawForm, State,
        rejection::{PathRejection, RawFormRejection},
    },
    response::Response,
};
use hypergraft::{PatchBuildError, PatchGraft, PatchSet, PatchStatus, outcome};

use crate::{
    AppState,
    pages::{
        AppError, TaskCreate, TaskCreateFeedback, TaskCreateFilters, TaskDetail, TaskFilter,
        TaskQuery, TaskResults,
    },
    state::{CreateError, StatusAction, StatusError, Task},
};

// Two 120-scalar fields need at most 2880 percent-encoded bytes.
// The remaining space covers field names, status and separators.
pub(crate) const MAX_COMMAND_BODY_BYTES: usize = 4096;

const TITLE_BLANK: &str = "Enter a title.";
const TITLE_TOO_LONG: &str = "Title must be 120 characters or fewer.";
const LIST_FULL: &str = "The list is full.";
const BODY_REJECTED: &str = "The request is invalid. The filter was reset to all tasks.";
const STATUS_INVALID: &str = "The request is invalid.";
const STATUS_CONFLICT: &str = "This task changed. The form shows the current state.";

pub(crate) fn command_body_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_COMMAND_BODY_BYTES)
}

pub async fn create(
    State(state): State<AppState>,
    // Patch metadata is required before the body is read or the store is touched.
    _graft: PatchGraft,
    form: Result<RawForm, RawFormRejection>,
) -> Result<Response, AppError> {
    let parsed = form.ok().and_then(|RawForm(body)| parse_create_form(&body));
    let (title, query) = match parsed {
        Some(parsed) => parsed,
        None => {
            let query = TaskQuery::unfiltered();
            let tasks = matching_tasks(&state, &query);
            return reject(
                PatchStatus::UnprocessableEntity,
                &query,
                &tasks,
                Some(BODY_REJECTED),
            );
        }
    };
    let created = state.store.create(&title);
    let tasks = matching_tasks(&state, &query);
    match created {
        Ok(task) => accept(&query, &tasks, &task),
        Err(CreateError::Blank) => reject(
            PatchStatus::UnprocessableEntity,
            &query,
            &tasks,
            Some(TITLE_BLANK),
        ),
        Err(CreateError::TooLong) => reject(
            PatchStatus::UnprocessableEntity,
            &query,
            &tasks,
            Some(TITLE_TOO_LONG),
        ),
        Err(CreateError::Full) => reject(PatchStatus::Conflict, &query, &tasks, Some(LIST_FULL)),
    }
}

pub async fn status(
    State(state): State<AppState>,
    _graft: PatchGraft,
    path: Result<Path<String>, PathRejection>,
    form: Result<RawForm, RawFormRejection>,
) -> Result<Response, AppError> {
    let Path(raw_id) = path.map_err(|_| AppError::NotFound)?;
    let id = raw_id.parse::<u64>().map_err(|_| AppError::NotFound)?;
    let parsed = form.ok().and_then(|RawForm(body)| parse_status_form(&body));
    let Some((action, revision)) = parsed else {
        let task = state.store.get(id).ok_or(AppError::NotFound)?;
        return status_patch(
            PatchStatus::UnprocessableEntity,
            &task,
            Some(STATUS_INVALID),
        );
    };
    match state.store.set_status(id, revision, action) {
        Ok(task) => status_patch(PatchStatus::Ok, &task, None),
        Err(StatusError::NotFound) => Err(AppError::NotFound),
        Err(StatusError::Conflict(task)) => {
            status_patch(PatchStatus::Conflict, &task, Some(STATUS_CONFLICT))
        }
    }
}

fn parse_create_form(body: &[u8]) -> Option<(String, TaskQuery)> {
    let mut title = String::new();
    let mut query = TaskQuery::unfiltered();
    // The URL parser replaces invalid UTF-8 and accepts broken percent escapes.
    // Commands must reject these bodies rather than store a repaired title.
    for field in body.split(|byte| *byte == b'&') {
        let mut parts = field.splitn(2, |byte| *byte == b'=');
        let key = decode_field(parts.next()?)?;
        let value = decode_field(parts.next().unwrap_or_default())?;
        if key == "title" {
            title = value;
        } else {
            query.apply(&key, &value);
        }
    }
    Some((title, query))
}

fn decode_field(mut bytes: &[u8]) -> Option<String> {
    let mut decoded = Vec::with_capacity(bytes.len());
    while let Some((&byte, rest)) = bytes.split_first() {
        bytes = rest;
        decoded.push(match byte {
            b'+' => b' ',
            b'%' => {
                let high = char::from(*bytes.first()?).to_digit(16)?;
                let low = char::from(*bytes.get(1)?).to_digit(16)?;
                bytes = &bytes[2..];
                (high * 16 + low) as u8
            }
            _ => byte,
        });
    }
    String::from_utf8(decoded).ok()
}

fn parse_status_form(body: &[u8]) -> Option<(StatusAction, u64)> {
    let mut action = None;
    let mut revision = None;
    for field in body.split(|byte| *byte == b'&') {
        let mut parts = field.splitn(2, |byte| *byte == b'=');
        let key = decode_field(parts.next()?)?;
        let value = decode_field(parts.next().unwrap_or_default())?;
        match key.as_str() {
            "action" if action.is_none() => action = Some(parse_status_action(&value)?),
            "revision" if revision.is_none() => revision = Some(value.parse().ok()?),
            _ => return None,
        }
    }
    Some((action?, revision?))
}

fn parse_status_action(value: &str) -> Option<StatusAction> {
    match value {
        "complete" => Some(StatusAction::Complete),
        "reopen" => Some(StatusAction::Reopen),
        _ => None,
    }
}

fn status_patch(
    status: PatchStatus,
    task: &Task,
    error: Option<&str>,
) -> Result<Response, AppError> {
    Ok(outcome::children_patch(
        status,
        "task-detail",
        &TaskDetail { task, error },
    )?)
}

fn matching_tasks(state: &AppState, query: &TaskQuery) -> Vec<Task> {
    state
        .store
        .list()
        .into_iter()
        .filter(|task| query.matches(task))
        .collect()
}

fn accept(query: &TaskQuery, tasks: &[Task], task: &Task) -> Result<Response, AppError> {
    // A success batch replaces the whole create form so the title clears.
    // Nested create targets must not appear in this batch.
    let mut patches = PatchSet::new();
    patches.children(
        "task-create",
        &TaskCreate {
            search: &query.search,
            status: query.status,
            error: None,
            created: Some(task),
            hidden_by_filter: !query.matches(task),
        },
    )?;
    list_patches(&mut patches, query, tasks)?;
    patches.replace_location(query.path())?;
    Ok(patches.respond(PatchStatus::Ok)?)
}

fn reject(
    status: PatchStatus,
    query: &TaskQuery,
    tasks: &[Task],
    error: Option<&str>,
) -> Result<Response, AppError> {
    // Rejections patch nested create regions so the title control stays in place.
    let mut patches = PatchSet::new();
    patches.children(
        "task-create-filters",
        &TaskCreateFilters {
            search: &query.search,
            status: query.status,
        },
    )?;
    patches.children(
        "task-create-feedback",
        &TaskCreateFeedback {
            error,
            created: None,
            hidden_by_filter: false,
        },
    )?;
    list_patches(&mut patches, query, tasks)?;
    patches.replace_location(query.path())?;
    Ok(patches.respond(status)?)
}

fn list_patches(
    patches: &mut PatchSet,
    query: &TaskQuery,
    tasks: &[Task],
) -> Result<(), PatchBuildError> {
    patches.children(
        "task-filter",
        &TaskFilter {
            search: &query.search,
            status: query.status,
        },
    )?;
    patches.children("task-results", &TaskResults { tasks })?;
    Ok(())
}
