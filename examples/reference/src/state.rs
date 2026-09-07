use std::sync::{Arc, Mutex};

pub(crate) const MAX_TASKS: usize = 100;
pub(crate) const MAX_TITLE_SCALARS: usize = 120;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Task {
    pub id: u64,
    pub title: String,
    pub done: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CreateError {
    Blank,
    TooLong,
    Full,
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
                },
                Task {
                    id: 2,
                    title: "Write the weekly notes".to_owned(),
                    done: false,
                },
                Task {
                    id: 3,
                    title: "Prepare the public preview".to_owned(),
                    done: false,
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
        };
        tasks.push(task.clone());
        Ok(task)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Task>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
