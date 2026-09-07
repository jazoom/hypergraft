use std::sync::{Arc, Mutex};

pub(crate) const MAX_TASKS: usize = 100;
pub(crate) const MAX_TITLE_SCALARS: usize = 120;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Task {
    pub id: u64,
    pub title: String,
    pub done: bool,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CreateError {
    Blank,
    TooLong,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StatusAction {
    Complete,
    Reopen,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StatusError {
    NotFound,
    Conflict(Task),
}

#[derive(Clone)]
pub struct Store {
    inner: Arc<Mutex<Vec<Task>>>,
}

impl Store {
    pub fn seeded() -> Self {
        Self {
            inner: Arc::new(Mutex::new(vec![
                Task {
                    id: 1,
                    title: "Review the protocol bounds".to_owned(),
                    done: true,
                    revision: 1,
                },
                Task {
                    id: 2,
                    title: "Write the weekly notes".to_owned(),
                    done: false,
                    revision: 1,
                },
                Task {
                    id: 3,
                    title: "Prepare the public preview".to_owned(),
                    done: false,
                    revision: 1,
                },
            ])),
        }
    }

    pub fn list(&self) -> Vec<Task> {
        self.lock().clone()
    }

    pub fn get(&self, id: u64) -> Option<Task> {
        self.lock().iter().find(|task| task.id == id).cloned()
    }

    pub(crate) fn create(&self, title: &str) -> Result<Task, CreateError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(CreateError::Blank);
        }
        if title.chars().count() > MAX_TITLE_SCALARS {
            return Err(CreateError::TooLong);
        }
        let mut tasks = self.lock();
        if tasks.len() >= MAX_TASKS {
            return Err(CreateError::Full);
        }
        let id = tasks.iter().map(|task| task.id).max().unwrap_or(0) + 1;
        let task = Task {
            id,
            title: title.to_owned(),
            done: false,
            revision: 1,
        };
        tasks.push(task.clone());
        Ok(task)
    }

    pub(crate) fn set_status(
        &self,
        id: u64,
        expected_revision: u64,
        action: StatusAction,
    ) -> Result<Task, StatusError> {
        let mut tasks = self.lock();
        let Some(task) = tasks.iter_mut().find(|task| task.id == id) else {
            return Err(StatusError::NotFound);
        };
        // The expected revision and the state transition share this lock.
        // A later check can miss a write from another command.
        if task.revision != expected_revision {
            return Err(StatusError::Conflict(task.clone()));
        }
        let done = matches!(action, StatusAction::Complete);
        if task.done == done {
            return Err(StatusError::Conflict(task.clone()));
        }
        task.done = done;
        task.revision += 1;
        Ok(task.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Task>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
