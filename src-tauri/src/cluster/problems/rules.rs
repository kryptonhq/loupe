//! What counts as a problem, decided over a snapshot of the cluster.
//!
//! Everything here is pure: objects in, rows out, with the clock passed
//! in rather than read. That is where all the judgement in the Problems
//! view lives — which states are broken, which are merely in progress,
//! how long "in progress" may last before it is broken — and it is the
//! part that has to be right, so it is the part that needs no cluster to
//! test.

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ContainerStatus, Event, Node, PersistentVolumeClaim, Pod, Taint, Toleration,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::ResourceExt;
use serde::Serialize;

use crate::cluster::resources::format_age;

/// How bad a row is. Ordered: the derived `Ord` puts critical first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Broken now, and not going to fix itself: a crash loop, an image
    /// that cannot be pulled, a node that is not ready.
    Critical,
    /// Wrong for longer than it should be, or degraded rather than down.
    Warning,
    /// Worth knowing, not necessarily wrong — warning events, and the
    /// categories Loupe was not allowed to check.
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Pods,
    Workloads,
    Nodes,
    Events,
    Storage,
}

/// The object a row is about, in the shape the frontend routes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// Stable across snapshots, so the frontend can key rows on it and a
    /// row that is still broken does not re-render as a new one.
    pub id: String,
    pub severity: Severity,
    pub category: Category,
    /// Null only for the rows that stand in for a category Loupe could
    /// not check — there is no object to open.
    pub target: Option<Target>,
    /// A short, stable code: `CrashLoopBackOff`, `Unschedulable`,
    /// `NotPermitted`. For sorting and filtering, not for reading.
    pub reason: String,
    /// The same thing as a sentence, which is what the row shows.
    pub message: String,
    /// When the problem started, in epoch seconds, as best the API can
    /// say. The frontend renders the age from this, so it keeps ticking
    /// between snapshots instead of freezing at whatever it was when the
    /// row was computed.
    pub since: Option<i64>,
    /// How many times it happened, for deduplicated events.
    pub count: Option<u32>,
}

/// The thresholds the user can tune in `settings.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    /// How long a pod may be pending or unready, a workload short of its
    /// replicas, or a claim unbound, before it is a problem rather than
    /// something still starting.
    pub grace_seconds: i64,
    /// Restarts that make a container worth a row even while it is up.
    pub restart_threshold: i32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            grace_seconds: 120,
            restart_threshold: 5,
        }
    }
}

/// Warning events older than this are history, not problems.
pub const EVENT_WINDOW_SECONDS: i64 = 3600;

/// Restarts only count while they are recent. The API keeps a restart
/// *count* but not restart *times*; the last termination's finish time
/// is the only timestamp there is, so "restarted N times in the last
/// hour" is approximated as "N restarts, the latest within the hour".
pub const RESTART_WINDOW_SECONDS: i64 = 3600;

/// Everything the rules read. Borrowed, so evaluating a snapshot copies
/// nothing that is not about to become a row.
pub struct Snapshot<'a> {
    pub pods: Vec<&'a Pod>,
    pub deployments: Vec<&'a Deployment>,
    pub statefulsets: Vec<&'a StatefulSet>,
    pub daemonsets: Vec<&'a DaemonSet>,
    pub jobs: Vec<&'a Job>,
    pub cronjobs: Vec<&'a CronJob>,
    pub nodes: Vec<&'a Node>,
    pub events: Vec<&'a Event>,
    pub pvcs: Vec<&'a PersistentVolumeClaim>,
    /// When each workload was first seen short of its replicas, keyed by
    /// `Kind/namespace/name`. StatefulSets and DaemonSets carry no
    /// condition that says how long they have been degraded, so the
    /// monitor remembers when it first noticed. See `monitor`.
    pub degraded_since: &'a HashMap<String, i64>,
}

impl Default for Snapshot<'_> {
    fn default() -> Self {
        static NONE: std::sync::LazyLock<HashMap<String, i64>> =
            std::sync::LazyLock::new(HashMap::new);
        Snapshot {
            pods: Vec::new(),
            deployments: Vec::new(),
            statefulsets: Vec::new(),
            daemonsets: Vec::new(),
            jobs: Vec::new(),
            cronjobs: Vec::new(),
            nodes: Vec::new(),
            events: Vec::new(),
            pvcs: Vec::new(),
            degraded_since: &NONE,
        }
    }
}

fn ts(t: &Time) -> i64 {
    t.0.as_second()
}

fn target(group: &str, version: &str, kind: &str, obj: &impl ResourceExt) -> Target {
    Target {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
        namespace: obj.namespace(),
        name: obj.name_any(),
    }
}

fn row_id(reason: &str, t: &Target, detail: &str) -> String {
    format!(
        "{}/{}/{}/{}/{}",
        t.kind,
        t.namespace.as_deref().unwrap_or(""),
        t.name,
        reason,
        detail
    )
}

/// Evaluates every rule, worst first and then oldest first.
pub fn evaluate(snapshot: &Snapshot, now: i64, limits: Thresholds) -> Vec<Problem> {
    let mut out = Vec::new();
    pods(snapshot, now, limits, &mut out);
    workloads(snapshot, now, limits, &mut out);
    nodes(snapshot, &mut out);
    events(snapshot, now, &mut out);
    claims(snapshot, now, limits, &mut out);
    sort(&mut out);
    out
}

pub fn sort(rows: &mut [Problem]) {
    rows.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            // Oldest first within a severity: the thing broken longest is
            // the one least likely to be sorting itself out.
            .then(
                a.since
                    .unwrap_or(i64::MAX)
                    .cmp(&b.since.unwrap_or(i64::MAX)),
            )
            .then(a.id.cmp(&b.id))
    });
}

// ---------------------------------------------------------------- pods

fn pods(snapshot: &Snapshot, now: i64, limits: Thresholds, out: &mut Vec<Problem>) {
    for pod in &snapshot.pods {
        pod_problems(pod, now, limits, out);
    }
}

fn pod_problems(pod: &Pod, now: i64, limits: Thresholds, out: &mut Vec<Problem>) {
    // A pod on its way out is not broken; it is leaving.
    if pod.metadata.deletion_timestamp.is_some() {
        return;
    }
    let Some(status) = &pod.status else { return };
    let phase = status.phase.as_deref().unwrap_or("");
    if phase == "Succeeded" {
        return;
    }

    let t = target("", "v1", "Pod", pod);
    let created = pod.creation_timestamp().map(|c| ts(&c));
    let started = status.start_time.as_ref().map(ts).or(created);
    let before = out.len();

    let containers = status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten());

    for c in containers {
        container_problems(c, &t, started, now, limits, out);
    }

    // The rows below describe the pod as a whole, and only say something
    // a container row has not already said. A pod in CrashLoopBackOff is
    // also not ready; a second row telling you so is noise.
    if out.len() > before {
        return;
    }

    let conditions = status.conditions.as_deref().unwrap_or_default();
    let condition = |kind: &str| conditions.iter().find(|c| c.type_ == kind);
    let older_than_grace =
        |since: Option<i64>| since.is_some_and(|s| now - s >= limits.grace_seconds);

    if phase == "Pending" {
        if !older_than_grace(created) {
            return;
        }
        match condition("PodScheduled") {
            Some(c) if c.status == "False" => {
                let reason = c.reason.clone().unwrap_or_else(|| "Unschedulable".into());
                let message = c
                    .message
                    .clone()
                    .unwrap_or_else(|| "the scheduler found no node for it".into());
                out.push(Problem {
                    id: row_id(&reason, &t, ""),
                    severity: Severity::Warning,
                    category: Category::Pods,
                    target: Some(t),
                    message: format!("Cannot be scheduled: {}", one_line(&message)),
                    reason,
                    since: c.last_transition_time.as_ref().map(ts).or(created),
                    count: None,
                });
            }
            _ => {
                let waiting = status
                    .container_statuses
                    .iter()
                    .flatten()
                    .find_map(|c| c.state.as_ref()?.waiting.as_ref()?.reason.clone());
                out.push(Problem {
                    id: row_id("Pending", &t, ""),
                    severity: Severity::Warning,
                    category: Category::Pods,
                    message: match &waiting {
                        Some(w) => format!(
                            "Pending for {}: {w}",
                            format_age(now - created.unwrap_or(now))
                        ),
                        None => format!("Pending for {}", format_age(now - created.unwrap_or(now))),
                    },
                    target: Some(t),
                    reason: "Pending".into(),
                    since: created,
                    count: None,
                });
            }
        }
        return;
    }

    if phase == "Running" {
        if let Some(ready) = condition("Ready") {
            let since = ready.last_transition_time.as_ref().map(ts);
            if ready.status != "True" && older_than_grace(since) {
                let unready: Vec<String> = status
                    .container_statuses
                    .iter()
                    .flatten()
                    .filter(|c| !c.ready)
                    .map(|c| c.name.clone())
                    .collect();
                out.push(Problem {
                    id: row_id("NotReady", &t, ""),
                    severity: Severity::Warning,
                    category: Category::Pods,
                    message: if unready.is_empty() {
                        format!("Not ready for {}", format_age(now - since.unwrap_or(now)))
                    } else {
                        format!(
                            "Not ready for {}: {} not ready",
                            format_age(now - since.unwrap_or(now)),
                            quote_list(&unready)
                        )
                    },
                    target: Some(t.clone()),
                    reason: "NotReady".into(),
                    since,
                    count: None,
                });
            }
        }
    }

    if phase == "Failed" {
        out.push(Problem {
            id: row_id("Failed", &t, ""),
            severity: Severity::Warning,
            category: Category::Pods,
            message: match &status.message {
                Some(m) => format!("Failed: {}", one_line(m)),
                None => format!(
                    "Failed{}",
                    status
                        .reason
                        .as_ref()
                        .map(|r| format!(": {r}"))
                        .unwrap_or_default()
                ),
            },
            target: Some(t),
            reason: status.reason.clone().unwrap_or_else(|| "Failed".into()),
            since: started,
            count: None,
        });
    }
}

fn container_problems(
    c: &ContainerStatus,
    t: &Target,
    started: Option<i64>,
    now: i64,
    limits: Thresholds,
    out: &mut Vec<Problem>,
) {
    let waiting = c.state.as_ref().and_then(|s| s.waiting.as_ref());
    let waiting_reason = waiting.and_then(|w| w.reason.as_deref()).unwrap_or("");
    let last = c.last_state.as_ref().and_then(|s| s.terminated.as_ref());
    let last_finished = last.and_then(|l| l.finished_at.as_ref()).map(ts);

    let mut push = |reason: &str, severity: Severity, message: String, since: Option<i64>| {
        out.push(Problem {
            id: row_id(reason, t, &c.name),
            severity,
            category: Category::Pods,
            target: Some(t.clone()),
            reason: reason.into(),
            message,
            since,
            count: None,
        })
    };

    match waiting_reason {
        "CrashLoopBackOff" => {
            let exit = last
                .map(|l| match &l.reason {
                    Some(r) => format!("exit code {} ({r})", l.exit_code),
                    None => format!("exit code {}", l.exit_code),
                })
                .unwrap_or_else(|| "no termination recorded".into());
            push(
                "CrashLoopBackOff",
                Severity::Critical,
                format!(
                    "Container `{}` is crash-looping: last {exit}, {} restart{}",
                    c.name,
                    c.restart_count,
                    plural(c.restart_count)
                ),
                started,
            );
            return;
        }
        "ImagePullBackOff" | "ErrImagePull" | "InvalidImageName" => {
            let detail = waiting
                .and_then(|w| w.message.as_deref())
                .map(|m| format!(": {}", one_line(m)))
                .unwrap_or_default();
            push(
                waiting_reason,
                Severity::Critical,
                format!(
                    "Cannot pull image `{}` for container `{}`{detail}",
                    c.image, c.name
                ),
                started,
            );
            return;
        }
        "CreateContainerConfigError" | "CreateContainerError" | "RunContainerError" => {
            let detail = waiting
                .and_then(|w| w.message.as_deref())
                .map(|m| format!(": {}", one_line(m)))
                .unwrap_or_default();
            push(
                waiting_reason,
                Severity::Critical,
                format!("Container `{}` cannot start{detail}", c.name),
                started,
            );
            return;
        }
        _ => {}
    }

    if last.and_then(|l| l.reason.as_deref()) == Some("OOMKilled") {
        push(
            "OOMKilled",
            Severity::Warning,
            format!(
                "Container `{}` was killed for exceeding its memory limit{}",
                c.name,
                if c.restart_count > 0 {
                    format!(" ({} restart{})", c.restart_count, plural(c.restart_count))
                } else {
                    String::new()
                }
            ),
            last_finished,
        );
        return;
    }

    let recent = last_finished.is_some_and(|f| now - f <= RESTART_WINDOW_SECONDS);
    if c.restart_count >= limits.restart_threshold && recent {
        push(
            "Restarting",
            Severity::Warning,
            format!(
                "Container `{}` has restarted {} times, most recently {} ago",
                c.name,
                c.restart_count,
                format_age(now - last_finished.unwrap_or(now))
            ),
            last_finished,
        );
    }
}

// ----------------------------------------------------------- workloads

fn workloads(snapshot: &Snapshot, now: i64, limits: Thresholds, out: &mut Vec<Problem>) {
    for d in &snapshot.deployments {
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let status = d.status.as_ref();
        let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
        let t = target("apps", "v1", "Deployment", *d);
        let conditions = status
            .and_then(|s| s.conditions.as_deref())
            .unwrap_or_default();

        // A rollout that has given up is a problem however many replicas
        // happen to be up — it is not going to finish on its own.
        let stalled = conditions.iter().find(|c| {
            c.type_ == "Progressing" && c.reason.as_deref() == Some("ProgressDeadlineExceeded")
        });
        if let Some(c) = stalled {
            out.push(Problem {
                id: row_id("ProgressDeadlineExceeded", &t, ""),
                severity: Severity::Critical,
                category: Category::Workloads,
                message: format!(
                    "Rollout stalled with {available} of {desired} replicas available{}",
                    c.message
                        .as_deref()
                        .map(|m| format!(": {}", one_line(m)))
                        .unwrap_or_default()
                ),
                target: Some(t),
                reason: "ProgressDeadlineExceeded".into(),
                since: c
                    .last_update_time
                    .as_ref()
                    .or(c.last_transition_time.as_ref())
                    .map(ts),
                count: None,
            });
            continue;
        }

        if available >= desired {
            continue;
        }
        let since = conditions
            .iter()
            .find(|c| c.type_ == "Available" && c.status == "False")
            .and_then(|c| c.last_transition_time.as_ref().map(ts))
            .or_else(|| snapshot.degraded_since.get(&degraded_key(&t)).copied());
        replicas_short(t, desired, available, since, now, limits, out);
    }

    for s in &snapshot.statefulsets {
        let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let status = s.status.as_ref();
        let available = status
            .and_then(|s| s.available_replicas.or(s.ready_replicas))
            .unwrap_or(0);
        let t = target("apps", "v1", "StatefulSet", *s);
        if available < desired {
            let since = snapshot.degraded_since.get(&degraded_key(&t)).copied();
            replicas_short(t, desired, available, since, now, limits, out);
        }
    }

    for d in &snapshot.daemonsets {
        let status = d.status.as_ref();
        let desired = status.map(|s| s.desired_number_scheduled).unwrap_or(0);
        let available = status.and_then(|s| s.number_available).unwrap_or(0);
        let t = target("apps", "v1", "DaemonSet", *d);
        if available < desired {
            let since = snapshot.degraded_since.get(&degraded_key(&t)).copied();
            replicas_short(t, desired, available, since, now, limits, out);
        }
    }

    for j in &snapshot.jobs {
        let failed = j
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_deref())
            .unwrap_or_default()
            .iter()
            .find(|c| c.type_ == "Failed" && c.status == "True");
        if let Some(c) = failed {
            let t = target("batch", "v1", "Job", *j);
            let reason = c.reason.clone().unwrap_or_else(|| "Failed".into());
            out.push(Problem {
                id: row_id("JobFailed", &t, ""),
                severity: Severity::Critical,
                category: Category::Workloads,
                message: format!(
                    "Job failed ({reason}){}",
                    c.message
                        .as_deref()
                        .map(|m| format!(": {}", one_line(m)))
                        .unwrap_or_default()
                ),
                target: Some(t),
                reason: "JobFailed".into(),
                since: c.last_transition_time.as_ref().map(ts),
                count: None,
            });
        }
    }

    for cj in &snapshot.cronjobs {
        if cj.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false) {
            continue;
        }
        let Some(uid) = cj.uid() else { continue };
        // The newest Job this CronJob owns is its last run. Owner by uid,
        // not by name: a CronJob deleted and recreated under the same name
        // should not inherit its predecessor's failures.
        let last_run = snapshot
            .jobs
            .iter()
            .filter(|j| j.namespace() == cj.namespace())
            .filter(|j| j.owner_references().iter().any(|o| o.uid == uid))
            .max_by_key(|j| j.creation_timestamp().map(|c| ts(&c)).unwrap_or(i64::MIN));
        let Some(job) = last_run else { continue };
        let failed = job
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_deref())
            .unwrap_or_default()
            .iter()
            .find(|c| c.type_ == "Failed" && c.status == "True");
        if let Some(c) = failed {
            let t = target("batch", "v1", "CronJob", *cj);
            out.push(Problem {
                id: row_id("LastRunFailed", &t, ""),
                severity: Severity::Warning,
                category: Category::Workloads,
                message: format!(
                    "Last run `{}` failed ({})",
                    job.name_any(),
                    c.reason.as_deref().unwrap_or("Failed")
                ),
                target: Some(t),
                reason: "LastRunFailed".into(),
                since: c.last_transition_time.as_ref().map(ts),
                count: None,
            });
        }
    }
}

/// The key `degraded_since` is held under.
pub fn degraded_key(t: &Target) -> String {
    format!(
        "{}/{}/{}",
        t.kind,
        t.namespace.as_deref().unwrap_or(""),
        t.name
    )
}

/// Whether a workload is short of its replicas right now, regardless of
/// for how long. What the monitor uses to decide what to remember.
pub fn is_degraded(snapshot: &Snapshot) -> Vec<String> {
    let mut keys = Vec::new();
    for d in &snapshot.deployments {
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let available = d
            .status
            .as_ref()
            .and_then(|s| s.available_replicas)
            .unwrap_or(0);
        if available < desired {
            keys.push(degraded_key(&target("apps", "v1", "Deployment", *d)));
        }
    }
    for s in &snapshot.statefulsets {
        let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let available = s
            .status
            .as_ref()
            .and_then(|s| s.available_replicas.or(s.ready_replicas))
            .unwrap_or(0);
        if available < desired {
            keys.push(degraded_key(&target("apps", "v1", "StatefulSet", *s)));
        }
    }
    for d in &snapshot.daemonsets {
        let status = d.status.as_ref();
        let desired = status.map(|s| s.desired_number_scheduled).unwrap_or(0);
        let available = status.and_then(|s| s.number_available).unwrap_or(0);
        if available < desired {
            keys.push(degraded_key(&target("apps", "v1", "DaemonSet", *d)));
        }
    }
    keys
}

fn replicas_short(
    t: Target,
    desired: i32,
    available: i32,
    since: Option<i64>,
    now: i64,
    limits: Thresholds,
    out: &mut Vec<Problem>,
) {
    // Short of replicas mid-rollout is normal. Short for longer than the
    // grace period is not.
    if !since.is_some_and(|s| now - s >= limits.grace_seconds) {
        return;
    }
    out.push(Problem {
        id: row_id("ReplicasUnavailable", &t, ""),
        severity: if available == 0 {
            Severity::Critical
        } else {
            Severity::Warning
        },
        category: Category::Workloads,
        message: format!(
            "{available} of {desired} replica{} available for {}",
            plural(desired),
            format_age(now - since.unwrap_or(now))
        ),
        target: Some(t),
        reason: "ReplicasUnavailable".into(),
        since,
        count: None,
    });
}

// --------------------------------------------------------------- nodes

const UNSCHEDULABLE_TAINT: &str = "node.kubernetes.io/unschedulable";

fn nodes(snapshot: &Snapshot, out: &mut Vec<Problem>) {
    for node in &snapshot.nodes {
        let t = target("", "v1", "Node", *node);
        let conditions = node
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_deref())
            .unwrap_or_default();

        if let Some(ready) = conditions.iter().find(|c| c.type_ == "Ready") {
            if ready.status != "True" {
                out.push(Problem {
                    id: row_id("NotReady", &t, ""),
                    severity: Severity::Critical,
                    category: Category::Nodes,
                    message: format!(
                        "Node is not ready{}",
                        ready
                            .message
                            .as_deref()
                            .map(|m| format!(": {}", one_line(m)))
                            .unwrap_or_default()
                    ),
                    target: Some(t.clone()),
                    reason: "NotReady".into(),
                    since: ready.last_transition_time.as_ref().map(ts),
                    count: None,
                });
            }
        }

        for pressure in ["MemoryPressure", "DiskPressure", "PIDPressure"] {
            if let Some(c) = conditions
                .iter()
                .find(|c| c.type_ == pressure && c.status == "True")
            {
                out.push(Problem {
                    id: row_id(pressure, &t, ""),
                    severity: Severity::Warning,
                    category: Category::Nodes,
                    message: format!(
                        "{}{}",
                        match pressure {
                            "MemoryPressure" => "Node is short of memory",
                            "DiskPressure" => "Node is short of disk",
                            _ => "Node is short of process IDs",
                        },
                        c.message
                            .as_deref()
                            .map(|m| format!(": {}", one_line(m)))
                            .unwrap_or_default()
                    ),
                    target: Some(t.clone()),
                    reason: pressure.into(),
                    since: c.last_transition_time.as_ref().map(ts),
                    count: None,
                });
            }
        }

        if node
            .spec
            .as_ref()
            .and_then(|s| s.unschedulable)
            .unwrap_or(false)
        {
            let cordoned_at = taints(node)
                .iter()
                .find(|t| t.key == UNSCHEDULABLE_TAINT)
                .and_then(|t| t.time_added.as_ref().map(ts));
            out.push(Problem {
                id: row_id("Unschedulable", &t, ""),
                severity: Severity::Warning,
                category: Category::Nodes,
                message: "Node is cordoned: no new pods will be scheduled on it".into(),
                target: Some(t.clone()),
                reason: "Unschedulable".into(),
                since: cordoned_at,
                count: None,
            });
        }
    }

    blocking_taints(snapshot, out);
}

fn taints(node: &Node) -> &[Taint] {
    node.spec
        .as_ref()
        .and_then(|s| s.taints.as_deref())
        .unwrap_or_default()
}

/// Taints that are keeping a pending pod off a node it would otherwise
/// fit on.
///
/// Only pods the scheduler has actually given up on count, and only
/// nodes whose labels match the pod's `nodeSelector` — a taint on a node
/// the pod could never have used anyway is not what is stopping it.
/// Affinity is not evaluated; see the handoff log.
fn blocking_taints(snapshot: &Snapshot, out: &mut Vec<Problem>) {
    let unschedulable: Vec<&Pod> = snapshot
        .pods
        .iter()
        .copied()
        .filter(|p| {
            p.spec.as_ref().and_then(|s| s.node_name.as_ref()).is_none()
                && p.status
                    .as_ref()
                    .and_then(|s| s.conditions.as_deref())
                    .unwrap_or_default()
                    .iter()
                    .any(|c| {
                        c.type_ == "PodScheduled"
                            && c.status == "False"
                            && c.reason.as_deref() == Some("Unschedulable")
                    })
        })
        .collect();
    if unschedulable.is_empty() {
        return;
    }

    for node in &snapshot.nodes {
        let labels = node.labels();
        // Keyed by the taint's printed form, so two pods blocked by the
        // same taint are one row with a count rather than two rows.
        let mut blocked: BTreeMap<String, u32> = BTreeMap::new();

        for pod in &unschedulable {
            let spec = pod.spec.as_ref();
            let selector = spec.and_then(|s| s.node_selector.as_ref());
            if !selector.is_none_or(|sel| sel.iter().all(|(k, v)| labels.get(k) == Some(v))) {
                continue;
            }
            let tolerations = spec
                .and_then(|s| s.tolerations.as_deref())
                .unwrap_or_default();
            for taint in taints(node) {
                if taint.key == UNSCHEDULABLE_TAINT {
                    continue; // Said by the cordon row already.
                }
                if !matches!(taint.effect.as_str(), "NoSchedule" | "NoExecute") {
                    continue;
                }
                if !tolerations.iter().any(|tol| tolerates(tol, taint)) {
                    *blocked.entry(print_taint(taint)).or_default() += 1;
                }
            }
        }

        for (taint, pods) in blocked {
            let t = target("", "v1", "Node", *node);
            out.push(Problem {
                id: row_id("TaintBlocksPods", &t, &taint),
                severity: Severity::Warning,
                category: Category::Nodes,
                message: format!(
                    "Taint `{taint}` is not tolerated by {pods} pending pod{}",
                    plural(pods as i32)
                ),
                target: Some(t),
                reason: "TaintBlocksPods".into(),
                since: None,
                count: Some(pods),
            });
        }
    }
}

/// Kubernetes' own toleration matching.
pub fn tolerates(tol: &Toleration, taint: &Taint) -> bool {
    if let Some(effect) = tol.effect.as_deref() {
        if !effect.is_empty() && effect != taint.effect {
            return false;
        }
    }
    let operator = tol.operator.as_deref().unwrap_or("Equal");
    match tol.key.as_deref() {
        // An empty key with Exists tolerates every taint.
        None | Some("") => operator == "Exists",
        Some(key) if key != taint.key => false,
        Some(_) => match operator {
            "Exists" => true,
            _ => tol.value.as_deref().unwrap_or("") == taint.value.as_deref().unwrap_or(""),
        },
    }
}

fn print_taint(t: &Taint) -> String {
    match t.value.as_deref() {
        Some(v) if !v.is_empty() => format!("{}={}:{}", t.key, v, t.effect),
        _ => format!("{}:{}", t.key, t.effect),
    }
}

// -------------------------------------------------------------- events

/// When an event last fired. `lastTimestamp` wins because it is what
/// moves when a repeating event fires again.
pub fn event_time(e: &Event) -> Option<i64> {
    e.series
        .as_ref()
        .and_then(|s| s.last_observed_time.as_ref())
        .map(|t| t.0.as_second())
        .or_else(|| e.last_timestamp.as_ref().map(ts))
        .or_else(|| e.event_time.as_ref().map(|t| t.0.as_second()))
        .or_else(|| e.creation_timestamp().map(|c| ts(&c)))
}

fn events(snapshot: &Snapshot, now: i64, out: &mut Vec<Problem>) {
    struct Group<'a> {
        latest: &'a Event,
        latest_at: i64,
        count: u32,
    }
    // Keyed by subject and reason, per the handoff: forty FailedScheduling
    // events for one pod are one fact seen forty times.
    let mut groups: BTreeMap<(String, String, String, String), Group> = BTreeMap::new();

    for e in &snapshot.events {
        if e.type_.as_deref() != Some("Warning") {
            continue;
        }
        let Some(at) = event_time(e) else { continue };
        if now - at > EVENT_WINDOW_SECONDS {
            continue;
        }
        let subject = &e.involved_object;
        let key = (
            subject.kind.clone().unwrap_or_default(),
            subject
                .namespace
                .clone()
                .or_else(|| e.namespace())
                .unwrap_or_default(),
            subject.name.clone().unwrap_or_default(),
            e.reason.clone().unwrap_or_default(),
        );
        let seen = e
            .series
            .as_ref()
            .and_then(|s| s.count)
            .or(e.count)
            .unwrap_or(1)
            .max(1) as u32;
        let group = groups.entry(key).or_insert(Group {
            latest: e,
            latest_at: at,
            count: 0,
        });
        group.count += seen;
        if at >= group.latest_at {
            group.latest = e;
            group.latest_at = at;
        }
    }

    for ((kind, namespace, name, reason), g) in groups {
        let (group, version) = split_api_version(g.latest.involved_object.api_version.as_deref());
        let t = Target {
            group,
            version,
            kind: kind.clone(),
            namespace: (!namespace.is_empty()).then_some(namespace),
            name,
        };
        out.push(Problem {
            id: row_id(&format!("Event:{reason}"), &t, ""),
            severity: Severity::Info,
            category: Category::Events,
            message: g
                .latest
                .message
                .as_deref()
                .map(one_line)
                .unwrap_or_else(|| reason.clone()),
            // An event about something with no kind cannot be opened.
            target: (!kind.is_empty() && !t.name.is_empty()).then_some(t),
            reason,
            since: Some(g.latest_at),
            count: Some(g.count),
        });
    }
}

fn split_api_version(api_version: Option<&str>) -> (String, String) {
    match api_version.unwrap_or("v1").split_once('/') {
        Some((group, version)) => (group.into(), version.into()),
        None => (String::new(), api_version.unwrap_or("v1").into()),
    }
}

// ------------------------------------------------------------- storage

fn claims(snapshot: &Snapshot, now: i64, limits: Thresholds, out: &mut Vec<Problem>) {
    for pvc in &snapshot.pvcs {
        if pvc.status.as_ref().and_then(|s| s.phase.as_deref()) != Some("Pending") {
            continue;
        }
        let created = pvc.creation_timestamp().map(|c| ts(&c));
        if !created.is_some_and(|c| now - c >= limits.grace_seconds) {
            continue;
        }
        let t = target("", "v1", "PersistentVolumeClaim", *pvc);
        let class = pvc
            .spec
            .as_ref()
            .and_then(|s| s.storage_class_name.as_deref())
            .map(|c| format!(" (storage class `{c}`)"))
            .unwrap_or_default();
        out.push(Problem {
            id: row_id("ClaimPending", &t, ""),
            severity: Severity::Warning,
            category: Category::Storage,
            message: format!(
                "Claim has not been bound for {}{class}",
                format_age(now - created.unwrap_or(now))
            ),
            target: Some(t),
            reason: "ClaimPending".into(),
            since: created,
            count: None,
        });
    }
}

// ------------------------------------------------------------- wording

/// Kubernetes messages are often multi-line; a row is one.
fn one_line(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 300;
    if joined.chars().count() > MAX {
        let cut: String = joined.chars().take(MAX).collect();
        format!("{cut}…")
    } else {
        joined
    }
}

fn plural(n: i32) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn quote_list(items: &[String]) -> String {
    items
        .iter()
        .map(|i| format!("`{i}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests;
