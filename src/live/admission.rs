use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex},
};

/// Process-local keyed admission for live sockets.
#[derive(Clone)]
pub struct SocketAdmission<K> {
    inner: Arc<Mutex<HashMap<K, usize>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdmissionDenied;

/// Releases the admitted slot when dropped.
pub struct AdmissionPermit<K>
where
    K: Clone + Eq + Hash + Send + 'static,
{
    key: K,
    inner: Arc<Mutex<HashMap<K, usize>>>,
}

impl<K> SocketAdmission<K>
where
    K: Clone + Eq + Hash + Send + 'static,
{
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn try_acquire(&self, key: K, limit: usize) -> Result<AdmissionPermit<K>, AdmissionDenied> {
        if limit == 0 {
            return Err(AdmissionDenied);
        }
        let mut map = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let occupied = map.entry(key.clone()).or_insert(0);
        if *occupied >= limit {
            return Err(AdmissionDenied);
        }
        *occupied += 1;
        Ok(AdmissionPermit {
            key,
            inner: self.inner.clone(),
        })
    }
}

impl<K> Default for SocketAdmission<K>
where
    K: Clone + Eq + Hash + Send + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

impl<K> Drop for AdmissionPermit<K>
where
    K: Clone + Eq + Hash + Send + 'static,
{
    fn drop(&mut self) {
        let mut map = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(occupied) = map.get_mut(&self.key) {
            *occupied = occupied.saturating_sub(1);
            if *occupied == 0 {
                map.remove(&self.key);
            }
        }
    }
}
