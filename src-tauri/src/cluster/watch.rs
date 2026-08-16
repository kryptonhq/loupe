//! Watching a kind, instead of asking for it again every ten seconds.
//!
//! Every list view used to refetch on a fixed timer. On a cluster with
//! 8,000 pods that was a full LIST every ten seconds, per open view,
//! forever — megabytes of JSON deserialised in Rust, re-serialised over
//! the IPC boundary and re-rendered, to discover that two rows changed.
//! It also put that load on the API server, which is the thing an
//! operator tool should be most careful with.
//!
//! A watch costs one LIST and then deltas. It is both cheaper and
//! fresher, which is unusual enough to be worth stating plainly.
//!
//! What crosses the channel is *that* something changed and which object
//! it was — not the new row. The cells in a listing are printed by the
//! API server (see `cluster::table`), and a watch delivers objects
//! rather than printed rows, so inventing cells here would mean
//! reimplementing kubectl's printers and getting them subtly wrong. The
//! frontend refetches the affected listing instead, which is one request
//! when something actually changed rather than one every ten seconds
//! regardless.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::StreamExt;
use kube::api::{Api, DynamicObject, ResourceExt};
use kube::runtime::watcher;
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::cluster::discovery::{api_for, resolve, GvkRef};
use crate::cluster::Session;
use crate::error::Result;

/// What happened to one object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Applied,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WatchEvent {
    /// An object was added, changed or removed.
    Changed {
        change: Change,
        name: String,
        namespace: Option<String>,
    },
    /// The watch relisted — the API server's `resourceVersion` had aged
    /// out, or the connection dropped and was re-established. Anything
    /// cached from before this is suspect and should be refetched
    /// wholesale rather than patched.
    Reset,
    /// The watch could not be kept up. Reported rather than retried
    /// forever in silence: a view that has quietly stopped updating is
    /// worse than one that says it has.
    Failed { message: String },
}

pub trait WatchSink: Send + Sync + 'static {
    fn send(&self, event: WatchEvent) -> bool;
}

impl WatchSink for tauri::ipc::Channel<WatchEvent> {
    fn send(&self, event: WatchEvent) -> bool {
        tauri::ipc::Channel::send(self, event).is_ok()
    }
}

#[derive(Default)]
pub struct Watches {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, AbortHandle>>,
}

impl Watches {
    fn allocate(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Stops a watch. False means it had already stopped by itself.
    pub async fn stop(&self, id: u64) -> bool {
        match self.active.lock().await.remove(&id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    /// Stops everything. A watch against a cluster the user has left is
    /// an open connection they no longer know about.
    pub async fn stop_all(&self) {
        let mut active = self.active.lock().await;
        for (_, handle) in active.drain() {
            handle.abort();
        }
    }
}

/// Starts watching a kind, returning the id needed to stop it.
pub async fn start(
    session: &Session,
    watches: &'static Watches,
    gvk: GvkRef,
    namespace: Option<String>,
    sink: impl WatchSink,
) -> Result<u64> {
    let (resource, caps) = resolve(session, &gvk).await?;
    let api: Api<DynamicObject> = api_for(
        session.client().await?,
        &resource,
        &caps,
        namespace.as_deref(),
    );

    let id = watches.allocate();

    let task = tokio::spawn(async move {
        // kube's watcher owns the hard parts: it lists once, watches from
        // the resulting resourceVersion, relists on 410 Gone, and backs
        // off on repeated failures rather than hot-looping against the
        // API server. Reimplementing that here would be the same code
        // with fewer eyes on it.
        let stream = watcher(api, watcher::Config::default());
        futures::pin_mut!(stream);

        while let Some(event) = stream.next().await {
            match translate(event) {
                // Nothing worth telling the frontend about.
                None => continue,
                Some(event) => {
                    if !sink.send(event) {
                        break;
                    }
                }
            }
        }

        watches.active.lock().await.remove(&id);
    });

    watches.active.lock().await.insert(id, task.abort_handle());
    Ok(id)
}

/// Turns one watcher event into something the frontend can act on, or
/// None when there is nothing worth saying.
///
/// Split from the loop because this is where all the judgement is: which
/// events are worth a round trip, which mean "refetch", and which mean
/// "this view has stopped updating". Testing it needs no cluster.
pub(crate) fn translate(
    event: std::result::Result<watcher::Event<DynamicObject>, watcher::Error>,
) -> Option<WatchEvent> {
    match event {
        // The initial list. Deliberately silent: the caller already has
        // the listing it opened with, and replaying 8,000 objects at it
        // as individual changes is exactly the cost this exists to
        // avoid.
        Ok(watcher::Event::Init)
        | Ok(watcher::Event::InitApply(_))
        | Ok(watcher::Event::InitDone) => None,

        Ok(watcher::Event::Apply(object)) => Some(WatchEvent::Changed {
            change: Change::Applied,
            name: object.name_any(),
            namespace: object.namespace(),
        }),
        Ok(watcher::Event::Delete(object)) => Some(WatchEvent::Changed {
            change: Change::Deleted,
            name: object.name_any(),
            namespace: object.namespace(),
        }),

        // Recoverable: the watcher relists and carries on, so anything
        // cached from before is suspect while the watch itself is fine.
        // Distinct from a failure, because conflating them either hides
        // a dead watch or makes every relist look like a fault.
        Err(watcher::Error::WatchFailed(_) | watcher::Error::InitialListFailed(_)) => {
            Some(WatchEvent::Reset)
        }
        Err(e) => Some(WatchEvent::Failed {
            message: e.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Discard;
    impl WatchSink for Discard {
        fn send(&self, _: WatchEvent) -> bool {
            true
        }
    }

    fn watches() -> &'static Watches {
        Box::leak(Box::new(Watches::default()))
    }

    fn object(name: &str, namespace: Option<&str>) -> DynamicObject {
        let mut o = DynamicObject::new(
            name,
            &kube::core::ApiResource::erase::<k8s_openapi::api::core::v1::Pod>(&()),
        );
        o.metadata.namespace = namespace.map(|n| n.to_string());
        o
    }

    #[test]
    fn the_initial_list_is_not_replayed_as_changes() {
        // Replaying 8,000 objects at a caller that already has the
        // listing is exactly the cost the watch exists to avoid.
        assert!(translate(Ok(watcher::Event::Init)).is_none());
        assert!(translate(Ok(watcher::Event::InitApply(object("api", None)))).is_none());
        assert!(translate(Ok(watcher::Event::InitDone)).is_none());
    }

    #[test]
    fn an_applied_object_is_reported_with_its_identity() {
        let event = translate(Ok(watcher::Event::Apply(object(
            "api-7d9",
            Some("payments"),
        ))));
        match event {
            Some(WatchEvent::Changed {
                change,
                name,
                namespace,
            }) => {
                assert_eq!(change, Change::Applied);
                assert_eq!(name, "api-7d9");
                assert_eq!(namespace.as_deref(), Some("payments"));
            }
            other => panic!("expected a change, got {other:?}"),
        }
    }

    #[test]
    fn a_deleted_object_is_distinguished_from_an_applied_one() {
        // The frontend refetches either way, but a listing that cannot
        // tell a deletion from an update cannot ever do better.
        let event = translate(Ok(watcher::Event::Delete(object("api-7d9", None))));
        match event {
            Some(WatchEvent::Changed { change, .. }) => {
                assert_eq!(change, Change::Deleted)
            }
            other => panic!("expected a change, got {other:?}"),
        }
    }

    #[test]
    fn a_cluster_scoped_object_reports_no_namespace() {
        let event = translate(Ok(watcher::Event::Apply(object("worker-1", None))));
        match event {
            Some(WatchEvent::Changed { namespace, .. }) => assert!(namespace.is_none()),
            other => panic!("expected a change, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn watching_requires_a_connection() {
        let session = Session::default();
        let gvk = GvkRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        };

        assert!(matches!(
            start(&session, watches(), gvk, None, Discard).await,
            Err(crate::error::AppError::NotConnected)
        ));
    }

    #[tokio::test]
    async fn stopping_an_unknown_watch_is_not_an_error() {
        // The frontend can stop a watch that ended on its own when the
        // view unmounted; that race is normal.
        let watches = Watches::default();
        assert!(!watches.stop(4242).await);
    }

    #[tokio::test]
    async fn watch_ids_are_unique() {
        let watches = Watches::default();
        assert_ne!(watches.allocate(), watches.allocate());
    }

    #[tokio::test]
    async fn stop_all_empties_the_registry() {
        let watches = Watches::default();
        let mut ids = Vec::new();
        for _ in 0..3 {
            let id = watches.allocate();
            let task = tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            });
            watches.active.lock().await.insert(id, task.abort_handle());
            ids.push(id);
        }

        watches.stop_all().await;

        for id in ids {
            assert!(!watches.stop(id).await, "registry should be empty");
        }
    }

    #[test]
    fn a_change_serialises_as_the_frontend_reads_it() {
        // These strings are a contract with src/lib/api.ts; renaming one
        // silently stops the listing updating.
        let event = WatchEvent::Changed {
            change: Change::Deleted,
            name: "api-7d9".into(),
            namespace: Some("payments".into()),
        };
        let json = serde_json::to_value(&event).unwrap();

        assert_eq!(json["kind"], "changed");
        assert_eq!(json["change"], "deleted");
        assert_eq!(json["name"], "api-7d9");
        assert_eq!(json["namespace"], "payments");
    }

    #[test]
    fn a_reset_is_distinct_from_a_failure() {
        // A reset means "refetch, the watch is fine"; a failure means
        // "this view has stopped updating". Conflating them would either
        // hide a dead watch or make every relist look like a fault.
        assert_eq!(
            serde_json::to_value(WatchEvent::Reset).unwrap()["kind"],
            "reset"
        );
        assert_eq!(
            serde_json::to_value(WatchEvent::Failed {
                message: "x".into()
            })
            .unwrap()["kind"],
            "failed"
        );
    }

    #[test]
    fn a_cluster_scoped_change_carries_no_namespace() {
        let event = WatchEvent::Changed {
            change: Change::Applied,
            name: "worker-1".into(),
            namespace: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert!(json["namespace"].is_null());
    }
}
