use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Task {
    pub id: u64,
    pub title: String,
    pub done: bool,
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

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Task>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
