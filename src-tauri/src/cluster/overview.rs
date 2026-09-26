//! The dashboard's numbers: how big the cluster is and how much of it is
//! healthy, at a glance.
//!
//! Computed from the Problems monitor's store rather than fetched. That
//! monitor already watches every kind these numbers come from — pods,
//! workloads, nodes, claims — and holds a trimmed copy of each, so the
//! dashboard costs no LIST of its own and is exactly as live as the
//! Problems view: the same snapshot carries both.
//!
//! Everything here is a pure function of that store, so it is tested with
//! objects made by hand rather than a cluster.

use std::collections::HashMap;

use k8s_openapi::api::core::v1::{Node, Pod};
use serde::Serialize;

use crate::cluster::detail::node::{parse_quantity, pod_demand};
use crate::cluster::problems::rules::Snapshot;

/// How many rows the ranked lists keep. A dashboard is a glance; the
/// full answer is one click away in the listing.
const TOP: usize = 5;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub nodes: NodeCounts,
    pub pods: PodCounts,
    /// One row per workload kind, in a fixed order.
    pub workloads: Vec<WorkloadCount>,
    /// What the scheduler has handed out, against what it can.
    pub capacity: Capacity,
    /// Every node, for the per-node bars and for joining live usage onto.
    pub node_rows: Vec<NodeRow>,
    /// The containers restarting most, worst first.
    pub restarts: Vec<RestartRow>,
    /// Namespaces by how many pods they run, largest first.
    pub namespaces: Vec<NamespaceRow>,
    pub namespace_count: usize,
    pub claims: ClaimCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCounts {
    pub total: usize,
    pub ready: usize,
    /// Still Ready, but taking no new pods. Counted apart because the
    /// pair — ready and cordoned — is what "nothing lands here" usually is.
    pub cordoned: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodCounts {
    pub total: usize,
    pub running: usize,
    pub pending: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub unknown: usize,
    /// Running by phase but with a container in CrashLoopBackOff. A pod
    /// in a crash loop reports phase Running, so the phase alone would
    /// count it as healthy.
    pub crash_looping: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadCount {
    /// The API's kind, which is also how the frontend finds its listing.
    pub kind: String,
    pub total: usize,
    /// Doing what it was asked: every replica available, a Job that has
    /// not failed, a CronJob that is not suspended.
    pub healthy: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    /// Cores and bytes, summed over nodes' allocatable — not capacity:
    /// the kubelet keeps some of each machine for itself, and the
    /// scheduler only hands out the rest.
    pub cpu_allocatable: f64,
    pub memory_allocatable: f64,
    pub cpu_requested: f64,
    pub memory_requested: f64,
    pub pods_allocatable: u64,
    /// Pods holding a slot on a node: scheduled and not finished.
    pub pods_scheduled: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub name: String,
    pub ready: bool,
    pub cordoned: bool,
    pub cpu_allocatable: f64,
    pub memory_allocatable: f64,
    pub cpu_requested: f64,
    pub memory_requested: f64,
    pub pods: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartRow {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub restarts: i32,
    /// Why it last stopped — `OOMKilled`, `Error` — when the API says.
    pub last_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceRow {
    pub namespace: String,
    pub pods: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCounts {
    pub total: usize,
    pub bound: usize,
    pub pending: usize,
    pub lost: usize,
}

fn phase(pod: &Pod) -> &str {
    pod.status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .unwrap_or("Unknown")
}

/// Finished pods hold no reservation on a node, though they still name one.
fn is_finished(pod: &Pod) -> bool {
    matches!(phase(pod), "Succeeded" | "Failed")
}

fn is_crash_looping(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .into_iter()
        .flatten()
        .any(|c| {
            c.state
                .as_ref()
                .and_then(|s| s.waiting.as_ref())
                .and_then(|w| w.reason.as_deref())
                == Some("CrashLoopBackOff")
        })
}

fn node_ready(node: &Node) -> bool {
    node.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .into_iter()
        .flatten()
        .any(|c| c.type_ == "Ready" && c.status == "True")
}

fn node_cordoned(node: &Node) -> bool {
    node.spec
        .as_ref()
        .and_then(|s| s.unschedulable)
        .unwrap_or(false)
}

fn allocatable(node: &Node, key: &str) -> f64 {
    node.status
        .as_ref()
        .and_then(|s| s.allocatable.as_ref())
        .and_then(|a| a.get(key))
        .and_then(|q| parse_quantity(&q.0))
        .unwrap_or(0.0)
}

fn node_counts(nodes: &[&Node]) -> NodeCounts {
    NodeCounts {
        total: nodes.len(),
        ready: nodes.iter().filter(|n| node_ready(n)).count(),
        cordoned: nodes.iter().filter(|n| node_cordoned(n)).count(),
    }
}

fn pod_counts(pods: &[&Pod]) -> PodCounts {
    let mut counts = PodCounts {
        total: pods.len(),
        ..Default::default()
    };
    for pod in pods {
        match phase(pod) {
            "Running" => counts.running += 1,
            "Pending" => counts.pending += 1,
            "Succeeded" => counts.succeeded += 1,
            "Failed" => counts.failed += 1,
            _ => counts.unknown += 1,
        }
        if is_crash_looping(pod) {
            counts.crash_looping += 1;
        }
    }
    counts
}

fn workload_counts(view: &Snapshot<'_>) -> Vec<WorkloadCount> {
    let count = |kind: &str, total: usize, healthy: usize| WorkloadCount {
        kind: kind.into(),
        total,
        healthy,
    };

    let deployments = view
        .deployments
        .iter()
        .filter(|d| {
            let want = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let have = d
                .status
                .as_ref()
                .and_then(|s| s.available_replicas)
                .unwrap_or(0);
            have >= want
        })
        .count();

    let statefulsets = view
        .statefulsets
        .iter()
        .filter(|s| {
            let want = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let have = s
                .status
                .as_ref()
                .and_then(|s| s.available_replicas)
                .unwrap_or(0);
            have >= want
        })
        .count();

    let daemonsets = view
        .daemonsets
        .iter()
        .filter(|d| {
            d.status
                .as_ref()
                .map(|s| s.number_available.unwrap_or(0) >= s.desired_number_scheduled)
                .unwrap_or(false)
        })
        .count();

    let jobs = view
        .jobs
        .iter()
        .filter(|j| {
            !j.status
                .as_ref()
                .and_then(|s| s.conditions.as_ref())
                .into_iter()
                .flatten()
                .any(|c| c.type_ == "Failed" && c.status == "True")
        })
        .count();

    let cronjobs = view
        .cronjobs
        .iter()
        .filter(|c| !c.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false))
        .count();

    vec![
        count("Deployment", view.deployments.len(), deployments),
        count("StatefulSet", view.statefulsets.len(), statefulsets),
        count("DaemonSet", view.daemonsets.len(), daemonsets),
        count("Job", view.jobs.len(), jobs),
        count("CronJob", view.cronjobs.len(), cronjobs),
    ]
}

/// Per-node allocation, and the cluster totals that are their sum.
fn capacity(nodes: &[&Node], pods: &[&Pod]) -> (Capacity, Vec<NodeRow>) {
    let mut by_node: HashMap<&str, (f64, f64, usize)> = HashMap::new();
    for pod in pods.iter().filter(|p| !is_finished(p)) {
        let Some(node) = pod.spec.as_ref().and_then(|s| s.node_name.as_deref()) else {
            continue;
        };
        let (cpu, mem) = pod_demand(pod, |r| r.requests.as_ref());
        let entry = by_node.entry(node).or_default();
        entry.0 += cpu;
        entry.1 += mem;
        entry.2 += 1;
    }

    let mut rows: Vec<NodeRow> = nodes
        .iter()
        .map(|n| {
            let name = n.metadata.name.clone().unwrap_or_default();
            let (cpu, mem, pods) = by_node.get(name.as_str()).copied().unwrap_or_default();
            NodeRow {
                ready: node_ready(n),
                cordoned: node_cordoned(n),
                cpu_allocatable: allocatable(n, "cpu"),
                memory_allocatable: allocatable(n, "memory"),
                cpu_requested: cpu,
                memory_requested: mem,
                pods,
                name,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));

    let total = Capacity {
        cpu_allocatable: rows.iter().map(|r| r.cpu_allocatable).sum(),
        memory_allocatable: rows.iter().map(|r| r.memory_allocatable).sum(),
        cpu_requested: rows.iter().map(|r| r.cpu_requested).sum(),
        memory_requested: rows.iter().map(|r| r.memory_requested).sum(),
        pods_allocatable: nodes.iter().map(|n| allocatable(n, "pods") as u64).sum(),
        pods_scheduled: rows.iter().map(|r| r.pods).sum(),
    };
    (total, rows)
}

fn restarts(pods: &[&Pod]) -> Vec<RestartRow> {
    let mut rows: Vec<RestartRow> = pods
        .iter()
        .flat_map(|pod| {
            let namespace = pod.metadata.namespace.clone().unwrap_or_default();
            let name = pod.metadata.name.clone().unwrap_or_default();
            pod.status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .into_iter()
                .flatten()
                .filter(|c| c.restart_count > 0)
                .map(move |c| RestartRow {
                    namespace: namespace.clone(),
                    pod: name.clone(),
                    container: c.name.clone(),
                    restarts: c.restart_count,
                    last_reason: c
                        .last_state
                        .as_ref()
                        .and_then(|s| s.terminated.as_ref())
                        .and_then(|t| t.reason.clone()),
                })
        })
        .collect();
    // Worst first; ties by name so the list does not reshuffle between
    // snapshots when nothing changed.
    rows.sort_by(|a, b| {
        b.restarts
            .cmp(&a.restarts)
            .then_with(|| a.namespace.cmp(&b.namespace))
            .then_with(|| a.pod.cmp(&b.pod))
            .then_with(|| a.container.cmp(&b.container))
    });
    rows.truncate(TOP);
    rows
}

fn namespaces(pods: &[&Pod]) -> (Vec<NamespaceRow>, usize) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for pod in pods {
        *counts
            .entry(pod.metadata.namespace.as_deref().unwrap_or_default())
            .or_default() += 1;
    }
    let distinct = counts.len();
    let mut rows: Vec<NamespaceRow> = counts
        .into_iter()
        .map(|(namespace, pods)| NamespaceRow {
            namespace: namespace.into(),
            pods,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.pods
            .cmp(&a.pods)
            .then_with(|| a.namespace.cmp(&b.namespace))
    });
    rows.truncate(TOP);
    (rows, distinct)
}

fn claims(view: &Snapshot<'_>) -> ClaimCounts {
    let mut counts = ClaimCounts {
        total: view.pvcs.len(),
        ..Default::default()
    };
    for pvc in &view.pvcs {
        match pvc.status.as_ref().and_then(|s| s.phase.as_deref()) {
            Some("Bound") => counts.bound += 1,
            Some("Lost") => counts.lost += 1,
            _ => counts.pending += 1,
        }
    }
    counts
}

/// The dashboard's numbers for one moment of the store.
pub fn summarise(view: &Snapshot<'_>) -> Overview {
    let (capacity, node_rows) = capacity(&view.nodes, &view.pods);
    let (namespaces, namespace_count) = namespaces(&view.pods);
    Overview {
        nodes: node_counts(&view.nodes),
        pods: pod_counts(&view.pods),
        workloads: workload_counts(view),
        capacity,
        node_rows,
        restarts: restarts(&view.pods),
        namespaces,
        namespace_count,
        claims: claims(view),
    }
}

#[cfg(test)]
mod tests;
