//! The Problems view: everything currently broken, across the cluster.
//!
//! The first question after connecting is "is anything wrong?", and
//! until now the only way to answer it was to walk every listing. This
//! module keeps the answer current instead: it watches the kinds that
//! can be broken — pods, workloads, nodes, events, claims — holds a
//! trimmed copy of each, and re-evaluates `rules` whenever something
//! changes.
//!
//! Watches rather than polling, for the same reasons as `cluster::watch`:
//! one LIST per kind and then deltas. The store is re-evaluated on a
//! timer as well, but that re-reads memory, not the API server — it is
//! what turns "pending for 1m59s" into "pending for 2m" when nothing in
//! the cluster moved to say so.
//!
//! Each source degrades on its own. A user who may not list nodes still
//! gets pod problems, and the nodes category says it could not be
//! checked rather than implying there is nothing wrong with the nodes.

pub mod rules;

use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Event, Node, PersistentVolumeClaim, Pod};
use kube::api::Api;
use kube::runtime::{watcher, WatchStreamExt};
use kube::{Resource, ResourceExt};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::{Mutex, Notify};
use tokio::task::{AbortHandle, JoinSet};

use crate::cluster::Session;
use crate::error::Result;
pub use rules::{Category, Problem, Severity, Thresholds};

/// Everything is re-evaluated at least this often, so rows whose
/// grace period expires with no cluster event still appear.
const REEVALUATE_EVERY: Duration = Duration::from_secs(15);

/// Changes arriving within this window are one re-evaluation. A rollout
/// is dozens of events a second; evaluating per event is wasted work.
const COALESCE: Duration = Duration::from_millis(250);

/// A kind the monitor watches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Pods,
    Deployments,
    StatefulSets,
    DaemonSets,
    Jobs,
    CronJobs,
    Nodes,
    Events,
    PersistentVolumeClaims,
}

impl Source {
    pub const ALL: [Source; 9] = [
        Source::Pods,
        Source::Deployments,
        Source::StatefulSets,
        Source::DaemonSets,
        Source::Jobs,
        Source::CronJobs,
        Source::Nodes,
        Source::Events,
        Source::PersistentVolumeClaims,
    ];

    pub fn category(self) -> Category {
        match self {
            Source::Pods => Category::Pods,
            Source::Deployments
            | Source::StatefulSets
            | Source::DaemonSets
            | Source::Jobs
            | Source::CronJobs => Category::Workloads,
            Source::Nodes => Category::Nodes,
            Source::Events => Category::Events,
            Source::PersistentVolumeClaims => Category::Storage,
        }
    }

    /// The plural the API uses, which is also what an RBAC rule names.
    pub fn resource(self) -> &'static str {
        match self {
            Source::Pods => "pods",
            Source::Deployments => "deployments",
            Source::StatefulSets => "statefulsets",
            Source::DaemonSets => "daemonsets",
            Source::Jobs => "jobs",
            Source::CronJobs => "cronjobs",
            Source::Nodes => "nodes",
            Source::Events => "events",
            Source::PersistentVolumeClaims => "persistentvolumeclaims",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SourceState {
    /// The initial list has not come back yet.
    Loading,
    Ready,
    /// RBAC refused the list. Terminal: retrying will be refused again,
    /// and a watch hammering a 403 is load on the API server for nothing.
    Forbidden {
        message: String,
    },
    /// Could not be listed for some other reason. The watch keeps
    /// retrying with backoff, so this can recover by itself.
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: Source,
    pub category: Category,
    #[serde(flatten)]
    pub state: SourceState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemsSnapshot {
    pub problems: Vec<Problem>,
    pub sources: Vec<SourceStatus>,
    /// Epoch seconds. What `since` on each row is measured against.
    pub generated_at: i64,
    pub grace_seconds: i64,
    pub restart_threshold: i32,
}

pub trait ProblemsSink: Send + Sync + 'static {
    fn send(&self, snapshot: ProblemsSnapshot) -> bool;
}

impl ProblemsSink for tauri::ipc::Channel<ProblemsSnapshot> {
    fn send(&self, snapshot: ProblemsSnapshot) -> bool {
        tauri::ipc::Channel::send(self, snapshot).is_ok()
    }
}

/// What is held of each object: enough for the rules, and no more.
///
/// A pod as the API sends it is mostly fields no rule reads —
/// `managedFields` alone is often half of it — and the monitor holds
/// every pod in the cluster. Dropping them before storing is the
/// difference between megabytes and tens of megabytes on a large
/// cluster.
pub trait Trim {
    fn trim(&mut self);
}

fn trim_meta(meta: &mut kube::api::ObjectMeta) {
    meta.managed_fields = None;
    meta.annotations = None;
}

macro_rules! trim_metadata_only {
    ($($t:ty),*) => {$(
        impl Trim for $t {
            fn trim(&mut self) {
                trim_meta(&mut self.metadata);
            }
        }
    )*};
}
trim_metadata_only!(
    Deployment,
    StatefulSet,
    DaemonSet,
    Job,
    CronJob,
    Event,
    PersistentVolumeClaim
);

impl Trim for Pod {
    fn trim(&mut self) {
        trim_meta(&mut self.metadata);
        self.metadata.labels = None;
        if let Some(spec) = &mut self.spec {
            // The rules read node selection and tolerations. Volumes,
            // environment and probes are the bulk of a pod spec, and
            // nothing here reads them.
            spec.volumes = None;
            for c in spec
                .containers
                .iter_mut()
                .chain(spec.init_containers.iter_mut().flatten())
            {
                c.env = None;
                c.env_from = None;
                c.volume_mounts = None;
                c.args = None;
                c.command = None;
                c.liveness_probe = None;
                c.readiness_probe = None;
                c.startup_probe = None;
            }
        }
    }
}

impl Trim for Node {
    fn trim(&mut self) {
        trim_meta(&mut self.metadata);
        if let Some(status) = &mut self.status {
            // The image list is the largest field on a node and says
            // nothing about whether it is healthy.
            status.images = None;
        }
    }
}

#[derive(Default)]
struct Store {
    pods: HashMap<String, Pod>,
    deployments: HashMap<String, Deployment>,
    statefulsets: HashMap<String, StatefulSet>,
    daemonsets: HashMap<String, DaemonSet>,
    jobs: HashMap<String, Job>,
    cronjobs: HashMap<String, CronJob>,
    nodes: HashMap<String, Node>,
    events: HashMap<String, Event>,
    pvcs: HashMap<String, PersistentVolumeClaim>,
    states: HashMap<Source, SourceState>,
    degraded_since: HashMap<String, i64>,
}

impl Store {
    fn snapshot(&mut self, now: i64, limits: Thresholds) -> ProblemsSnapshot {
        // Events leave the API server after an hour anyway; holding them
        // past the window the rules read is memory for nothing.
        self.events.retain(|_, e| {
            rules::event_time(e).is_none_or(|t| now - t <= rules::EVENT_WINDOW_SECONDS)
        });

        // Remember when each workload was first seen short of replicas,
        // and forget the ones that recovered — so a workload that
        // recovers and degrades again starts its grace period afresh.
        let degraded = rules::is_degraded(&self.view());
        self.degraded_since.retain(|k, _| degraded.contains(k));
        for key in degraded {
            self.degraded_since.entry(key).or_insert(now);
        }

        let mut problems = rules::evaluate(&self.view(), now, limits);
        let sources = Source::ALL
            .iter()
            .map(|&source| SourceStatus {
                source,
                category: source.category(),
                state: self
                    .states
                    .get(&source)
                    .cloned()
                    .unwrap_or(SourceState::Loading),
            })
            .collect::<Vec<_>>();
        problems.extend(sources.iter().filter_map(unavailable_row));
        rules::sort(&mut problems);

        ProblemsSnapshot {
            problems,
            sources,
            generated_at: now,
            grace_seconds: limits.grace_seconds,
            restart_threshold: limits.restart_threshold,
        }
    }

    fn view(&self) -> rules::Snapshot<'_> {
        rules::Snapshot {
            pods: self.pods.values().collect(),
            deployments: self.deployments.values().collect(),
            statefulsets: self.statefulsets.values().collect(),
            daemonsets: self.daemonsets.values().collect(),
            jobs: self.jobs.values().collect(),
            cronjobs: self.cronjobs.values().collect(),
            nodes: self.nodes.values().collect(),
            events: self.events.values().collect(),
            pvcs: self.pvcs.values().collect(),
            degraded_since: &self.degraded_since,
        }
    }
}

/// A row standing in for a source that could not be checked. One per
/// source, so a missing permission is said once rather than implied by
/// an empty category.
fn unavailable_row(status: &SourceStatus) -> Option<Problem> {
    let (reason, message) = match &status.state {
        SourceState::Forbidden { .. } => (
            "NotPermitted",
            format!(
                "Not permitted to list {} across the cluster, so they were not checked",
                status.source.resource()
            ),
        ),
        SourceState::Failed { message } => (
            "Unavailable",
            format!("Could not list {}: {message}", status.source.resource()),
        ),
        _ => return None,
    };
    Some(Problem {
        id: format!("source/{}/{reason}", status.source.resource()),
        severity: Severity::Info,
        category: status.category,
        target: None,
        reason: reason.into(),
        message,
        since: None,
        count: None,
    })
}

fn is_forbidden(e: &watcher::Error) -> bool {
    match e {
        watcher::Error::InitialListFailed(kube::Error::Api(s))
        | watcher::Error::WatchStartFailed(kube::Error::Api(s)) => s.code == 403,
        watcher::Error::WatchError(s) => s.code == 403,
        _ => false,
    }
}

fn store_key(obj: &impl ResourceExt) -> String {
    format!("{}/{}", obj.namespace().unwrap_or_default(), obj.name_any())
}

/// What a watch event means for the monitor.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// The store changed; re-evaluate.
    Notify,
    /// Nothing worth re-evaluating for.
    Quiet,
    /// This source is finished for good. Re-evaluate once more, so the
    /// reason it stopped is shown, then end its watch.
    Stop,
}

/// Applies one watch event to the store.
///
/// Split from `follow` so everything it decides — when a partial list
/// becomes the store, what a 403 means, which failures are worth saying —
/// can be tested with events made by hand rather than a cluster.
fn apply_event<K>(
    store: &mut Store,
    source: Source,
    initial: &mut Option<HashMap<String, K>>,
    slot: fn(&mut Store) -> &mut HashMap<String, K>,
    event: std::result::Result<watcher::Event<K>, watcher::Error>,
) -> Step
where
    K: ResourceExt + Trim,
{
    match event {
        Ok(watcher::Event::Init) => {
            *initial = Some(HashMap::new());
            Step::Quiet
        }
        Ok(watcher::Event::InitApply(mut obj)) => {
            obj.trim();
            if let Some(buffer) = initial.as_mut() {
                buffer.insert(store_key(&obj), obj);
            }
            // Not notified: a partial list evaluated as if complete would
            // briefly report problems that are not there — or, worse, the
            // absence of ones that are.
            Step::Quiet
        }
        Ok(watcher::Event::InitDone) => {
            if let Some(buffer) = initial.take() {
                *slot(store) = buffer;
            }
            store.states.insert(source, SourceState::Ready);
            Step::Notify
        }
        Ok(watcher::Event::Apply(mut obj)) => {
            obj.trim();
            slot(store).insert(store_key(&obj), obj);
            Step::Notify
        }
        Ok(watcher::Event::Delete(obj)) => {
            slot(store).remove(&store_key(&obj));
            Step::Notify
        }
        Err(e) if is_forbidden(&e) => {
            store.states.insert(
                source,
                SourceState::Forbidden {
                    message: e.to_string(),
                },
            );
            slot(store).clear();
            Step::Stop
        }
        Err(e) => {
            // A watch that drops after its list is still serving data the
            // watcher will relist; saying "failed" for that would make
            // every reconnect look like an outage. Only a source that
            // never loaded is reported.
            if store.states.get(&source) == Some(&SourceState::Ready) {
                return Step::Quiet;
            }
            store.states.insert(
                source,
                SourceState::Failed {
                    message: e.to_string(),
                },
            );
            Step::Notify
        }
    }
}

/// Follows one kind into the store until the task is aborted.
async fn follow<K>(
    api: Api<K>,
    source: Source,
    store: Arc<SyncMutex<Store>>,
    changed: Arc<Notify>,
    slot: fn(&mut Store) -> &mut HashMap<String, K>,
) where
    K: Resource<DynamicType = ()> + Trim + Clone + DeserializeOwned + Debug + Send + Sync + 'static,
{
    // `any_semantic` lets the initial list be served from the API
    // server's watch cache rather than etcd, which is the difference
    // that matters on a large cluster; paging keeps each response
    // bounded while it is.
    let config = watcher::Config::default().any_semantic().page_size(500);
    // Backoff, because a watch that fails fast would otherwise retry in a
    // hot loop against the API server.
    let stream = watcher(api, config).default_backoff();
    futures::pin_mut!(stream);

    let mut initial: Option<HashMap<String, K>> = None;

    while let Some(event) = stream.next().await {
        let step = apply_event(
            &mut store.lock().expect("problems store poisoned"),
            source,
            &mut initial,
            slot,
            event,
        );
        match step {
            Step::Quiet => {}
            Step::Notify => changed.notify_one(),
            Step::Stop => {
                changed.notify_one();
                return;
            }
        }
    }
}

/// Re-evaluates the store and pushes the result, on change and on a
/// timer, until the sink stops accepting.
async fn publish(
    store: Arc<SyncMutex<Store>>,
    changed: Arc<Notify>,
    limits: Thresholds,
    sink: &impl ProblemsSink,
) {
    // The first tick fires immediately, so the frontend has an answer —
    // "still loading" — before any watch has listed anything.
    let mut tick = tokio::time::interval(REEVALUATE_EVERY);
    loop {
        tokio::select! {
            _ = changed.notified() => tokio::time::sleep(COALESCE).await,
            _ = tick.tick() => {}
        }
        let now = k8s_openapi::jiff::Timestamp::now().as_second();
        let snapshot = store
            .lock()
            .expect("problems store poisoned")
            .snapshot(now, limits);
        if !sink.send(snapshot) {
            return;
        }
    }
}

#[derive(Default)]
pub struct Monitors {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, AbortHandle>>,
}

impl Monitors {
    pub async fn stop(&self, id: u64) -> bool {
        match self.active.lock().await.remove(&id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    pub async fn stop_all(&self) {
        for (_, handle) in self.active.lock().await.drain() {
            handle.abort();
        }
    }
}

/// Starts monitoring the active cluster, pushing a snapshot on `sink`
/// whenever the answer may have changed. Returns the id to stop it.
pub async fn start(
    session: &Session,
    monitors: &'static Monitors,
    limits: Thresholds,
    sink: impl ProblemsSink,
) -> Result<u64> {
    let client = session.client().await?;
    let id = monitors.next_id.fetch_add(1, Ordering::Relaxed);

    let task = tokio::spawn(async move {
        let store = Arc::new(SyncMutex::new(Store::default()));
        let changed = Arc::new(Notify::new());

        // Owned by this task, so aborting the monitor aborts every watch
        // with it: a JoinSet aborts its tasks when dropped.
        let mut watches = JoinSet::new();
        macro_rules! watch {
            ($t:ty, $source:expr, $field:ident) => {
                watches.spawn(follow::<$t>(
                    Api::all(client.clone()),
                    $source,
                    store.clone(),
                    changed.clone(),
                    |s| &mut s.$field,
                ));
            };
        }
        watch!(Pod, Source::Pods, pods);
        watch!(Deployment, Source::Deployments, deployments);
        watch!(StatefulSet, Source::StatefulSets, statefulsets);
        watch!(DaemonSet, Source::DaemonSets, daemonsets);
        watch!(Job, Source::Jobs, jobs);
        watch!(CronJob, Source::CronJobs, cronjobs);
        watch!(Node, Source::Nodes, nodes);
        watch!(Event, Source::Events, events);
        watch!(PersistentVolumeClaim, Source::PersistentVolumeClaims, pvcs);

        publish(store, changed, limits, &sink).await;

        drop(watches);
        monitors.active.lock().await.remove(&id);
    });

    monitors.active.lock().await.insert(id, task.abort_handle());
    Ok(id)
}

#[cfg(test)]
mod live_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse<T: DeserializeOwned>(v: serde_json::Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_forbidden_source_becomes_one_not_permitted_row() {
        let mut store = Store::default();
        store.states.insert(
            Source::Nodes,
            SourceState::Forbidden {
                message: "nodes is forbidden".into(),
            },
        );
        for s in Source::ALL {
            store.states.entry(s).or_insert(SourceState::Ready);
        }
        let snap = store.snapshot(1_000, Thresholds::default());

        assert_eq!(snap.problems.len(), 1);
        let row = &snap.problems[0];
        assert_eq!(row.reason, "NotPermitted");
        assert_eq!(row.category, Category::Nodes);
        assert!(row.target.is_none());
        assert!(row.message.contains("nodes"));
    }

    #[test]
    fn a_source_still_loading_is_not_a_row() {
        let snap = Store::default().snapshot(1_000, Thresholds::default());
        assert!(snap.problems.is_empty());
        assert!(snap.sources.iter().all(|s| s.state == SourceState::Loading));
    }

    #[test]
    fn degraded_workloads_are_remembered_and_forgotten() {
        let mut store = Store::default();
        let sts = |available: i32| -> StatefulSet {
            parse(json!({
                "metadata": { "name": "db", "namespace": "shop" },
                "spec": { "replicas": 3, "selector": {}, "template": {}, "serviceName": "db" },
                "status": { "replicas": 3, "availableReplicas": available }
            }))
        };
        store.statefulsets.insert("shop/db".into(), sts(1));

        store.snapshot(1_000, Thresholds::default());
        assert_eq!(
            store.degraded_since.get("StatefulSet/shop/db"),
            Some(&1_000)
        );

        // Still degraded later: the first sighting is kept, and once the
        // grace period has passed from it, it is a row.
        let snap = store.snapshot(1_200, Thresholds::default());
        assert_eq!(
            store.degraded_since.get("StatefulSet/shop/db"),
            Some(&1_000)
        );
        assert!(snap
            .problems
            .iter()
            .any(|p| p.reason == "ReplicasUnavailable"));

        // Recovered: forgotten, so a later relapse starts a fresh grace period.
        store.statefulsets.insert("shop/db".into(), sts(3));
        store.snapshot(1_300, Thresholds::default());
        assert!(store.degraded_since.is_empty());
    }

    #[test]
    fn events_outside_the_window_are_dropped_from_memory() {
        let mut store = Store::default();
        let event = |ago: i64| -> Event {
            parse(json!({
                "metadata": { "name": format!("e{ago}"), "namespace": "x" },
                "involvedObject": {},
                "type": "Warning",
                "lastTimestamp": k8s_openapi::jiff::Timestamp::from_second(10_000 - ago).unwrap().to_string()
            }))
        };
        store.events.insert("x/old".into(), event(7_200));
        store.events.insert("x/new".into(), event(60));
        store.snapshot(10_000, Thresholds::default());
        assert_eq!(store.events.len(), 1);
        assert!(store.events.contains_key("x/new"));
    }

    #[test]
    fn a_403_is_forbidden_and_anything_else_is_not() {
        let status = |code: u16| {
            Box::new(
                serde_json::from_value::<kube::core::Status>(json!({
                    "status": "Failure", "code": code, "reason": "Forbidden", "message": "nope"
                }))
                .unwrap(),
            )
        };
        assert!(is_forbidden(&watcher::Error::InitialListFailed(
            kube::Error::Api(status(403))
        )));
        assert!(!is_forbidden(&watcher::Error::InitialListFailed(
            kube::Error::Api(status(500))
        )));
        assert!(!is_forbidden(&watcher::Error::NoResourceVersion));
    }

    #[test]
    fn trimming_a_pod_keeps_what_the_rules_read() {
        let mut pod: Pod = parse(json!({
            "metadata": {
                "name": "p", "namespace": "n",
                "annotations": { "big": "x".repeat(1000) },
                "managedFields": [{ "manager": "kubelet" }]
            },
            "spec": {
                "nodeSelector": { "zone": "a" },
                "tolerations": [{ "key": "gpu", "operator": "Exists" }],
                "volumes": [{ "name": "v" }],
                "containers": [{ "name": "app", "env": [{ "name": "SECRET", "value": "s" }] }]
            },
            "status": { "phase": "Running" }
        }));
        pod.trim();
        let spec = pod.spec.as_ref().unwrap();
        assert!(pod.metadata.managed_fields.is_none());
        assert!(pod.metadata.annotations.is_none());
        assert!(spec.volumes.is_none());
        assert!(spec.containers[0].env.is_none());
        assert!(spec.node_selector.is_some(), "the taint rule reads this");
        assert!(spec.tolerations.is_some(), "and this");
        assert_eq!(pod.status.unwrap().phase.as_deref(), Some("Running"));
    }

    #[test]
    fn a_snapshot_serialises_with_flattened_source_state() {
        let snap = Store::default().snapshot(5, Thresholds::default());
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["generatedAt"], 5);
        assert_eq!(json["graceSeconds"], 120);
        assert_eq!(json["sources"][0]["source"], "pods");
        assert_eq!(json["sources"][0]["state"], "loading");
        assert_eq!(json["sources"][0]["category"], "pods");
    }

    fn pod_named(name: &str) -> Pod {
        parse(json!({
            "metadata": { "name": name, "namespace": "shop", "managedFields": [{ "manager": "kubelet" }] },
            "spec": { "containers": [{ "name": "app" }] }
        }))
    }

    fn api_error(code: u16) -> watcher::Error {
        watcher::Error::InitialListFailed(kube::Error::Api(Box::new(
            serde_json::from_value::<kube::core::Status>(json!({
                "status": "Failure", "code": code, "reason": "x", "message": "refused"
            }))
            .unwrap(),
        )))
    }

    fn pods_slot(s: &mut Store) -> &mut HashMap<String, Pod> {
        &mut s.pods
    }

    #[test]
    fn the_initial_list_replaces_the_store_only_once_it_is_complete() {
        let mut store = Store::default();
        store.pods.insert("shop/stale".into(), pod_named("stale"));
        let mut initial = None;
        let mut apply =
            |store: &mut Store, e| apply_event(store, Source::Pods, &mut initial, pods_slot, e);

        assert_eq!(apply(&mut store, Ok(watcher::Event::Init)), Step::Quiet);
        assert_eq!(
            apply(&mut store, Ok(watcher::Event::InitApply(pod_named("a")))),
            Step::Quiet
        );
        assert_eq!(
            apply(&mut store, Ok(watcher::Event::InitApply(pod_named("b")))),
            Step::Quiet
        );
        // Mid-list, the store still holds what it had: a half-listed
        // cluster evaluated as if complete would be wrong both ways.
        assert!(store.pods.contains_key("shop/stale"));
        assert_eq!(store.states.get(&Source::Pods), None);

        assert_eq!(
            apply(&mut store, Ok(watcher::Event::InitDone)),
            Step::Notify
        );
        let mut keys: Vec<_> = store.pods.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["shop/a", "shop/b"], "a relist drops what is gone");
        assert_eq!(store.states.get(&Source::Pods), Some(&SourceState::Ready));
        assert!(
            store.pods["shop/a"].metadata.managed_fields.is_none(),
            "stored trimmed"
        );
    }

    #[test]
    fn applies_and_deletes_change_the_store_and_ask_for_evaluation() {
        let mut store = Store::default();
        let mut initial = None;

        let step = apply_event(
            &mut store,
            Source::Pods,
            &mut initial,
            pods_slot,
            Ok(watcher::Event::Apply(pod_named("a"))),
        );
        assert_eq!(step, Step::Notify);
        assert!(store.pods["shop/a"].metadata.managed_fields.is_none());

        let step = apply_event(
            &mut store,
            Source::Pods,
            &mut initial,
            pods_slot,
            Ok(watcher::Event::Delete(pod_named("a"))),
        );
        assert_eq!(step, Step::Notify);
        assert!(store.pods.is_empty());
    }

    #[test]
    fn a_403_stops_the_source_and_empties_what_it_held() {
        let mut store = Store::default();
        store.pods.insert("shop/a".into(), pod_named("a"));
        let mut initial = None;

        let step = apply_event(
            &mut store,
            Source::Pods,
            &mut initial,
            pods_slot,
            Err(api_error(403)),
        );
        assert_eq!(step, Step::Stop);
        assert!(
            store.pods.is_empty(),
            "nothing shown for a kind the user may not list"
        );
        assert!(matches!(
            store.states.get(&Source::Pods),
            Some(SourceState::Forbidden { .. })
        ));
    }

    #[test]
    fn a_failure_is_reported_before_the_first_list_and_not_after() {
        let mut store = Store::default();
        let mut initial = None;

        let step = apply_event(
            &mut store,
            Source::Pods,
            &mut initial,
            pods_slot,
            Err(api_error(500)),
        );
        assert_eq!(step, Step::Notify);
        assert!(matches!(
            store.states.get(&Source::Pods),
            Some(SourceState::Failed { .. })
        ));

        // Once listed, a dropped watch is a reconnect, not an outage.
        store.states.insert(Source::Pods, SourceState::Ready);
        let step = apply_event(
            &mut store,
            Source::Pods,
            &mut initial,
            pods_slot,
            Err(api_error(500)),
        );
        assert_eq!(step, Step::Quiet);
        assert_eq!(store.states.get(&Source::Pods), Some(&SourceState::Ready));
    }

    struct Collect(tokio::sync::mpsc::UnboundedSender<ProblemsSnapshot>);
    impl ProblemsSink for Collect {
        fn send(&self, snapshot: ProblemsSnapshot) -> bool {
            self.0.send(snapshot).is_ok()
        }
    }

    #[tokio::test]
    async fn publishing_answers_at_once_then_on_every_change_until_nobody_listens() {
        let store = Arc::new(SyncMutex::new(Store::default()));
        let changed = Arc::new(Notify::new());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let task = tokio::spawn({
            let (store, changed) = (store.clone(), changed.clone());
            async move { publish(store, changed, Thresholds::default(), &Collect(tx)).await }
        });

        // An answer before anything has listed: every source loading.
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("an immediate snapshot")
            .unwrap();
        assert!(first
            .sources
            .iter()
            .all(|s| s.state == SourceState::Loading));

        // A change is published after the coalescing window.
        store
            .lock()
            .unwrap()
            .states
            .insert(Source::Pods, SourceState::Ready);
        changed.notify_one();
        let second = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("a snapshot after the change")
            .unwrap();
        assert_eq!(second.sources[0].state, SourceState::Ready);

        // With nobody listening, the next publish ends the loop.
        drop(rx);
        changed.notify_one();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("publish stops once the sink refuses")
            .unwrap();
    }

    #[tokio::test]
    async fn stopping_monitors() {
        let monitors = Monitors::default();
        assert!(!monitors.stop(42).await, "an unknown id is not an error");

        let long = || tokio::spawn(tokio::time::sleep(Duration::from_secs(3600)));
        let a = long();
        let b = long();
        monitors.active.lock().await.insert(1, a.abort_handle());
        monitors.active.lock().await.insert(2, b.abort_handle());

        assert!(monitors.stop(1).await);
        assert!(a.await.unwrap_err().is_cancelled());

        monitors.stop_all().await;
        assert!(b.await.unwrap_err().is_cancelled());
        assert!(monitors.active.lock().await.is_empty());
    }

    #[tokio::test]
    async fn monitoring_requires_a_connection() {
        struct Discard;
        impl ProblemsSink for Discard {
            fn send(&self, _: ProblemsSnapshot) -> bool {
                true
            }
        }
        let monitors: &'static Monitors = Box::leak(Box::default());
        assert!(matches!(
            start(
                &Session::default(),
                monitors,
                Thresholds::default(),
                Discard
            )
            .await,
            Err(crate::error::AppError::NotConnected)
        ));
    }
}
