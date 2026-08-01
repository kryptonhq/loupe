//! Resource listings.
//!
//! Each type is summarised into a flat, camelCase shape rather than
//! forwarded as raw Kubernetes JSON. Two reasons: the wire payload for a
//! thousand pods is dominated by managedFields the UI never reads, and a
//! summary gives the frontend a stable contract that does not move when
//! the cluster's API version does.

use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::Session;
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSummary {
    pub name: String,
    pub phase: String,
    pub age: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSummary {
    pub name: String,
    pub namespace: String,
    pub phase: String,
    pub node: Option<String>,
    /// Ready containers over total, the column every operator reads
    /// first. Computed here so the UI does not reimplement it.
    pub ready: String,
    pub restarts: i32,
    pub age: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    pub name: String,
    pub ready: bool,
    pub roles: Vec<String>,
    pub version: String,
    pub age: Option<String>,
}

/// Formats a creation timestamp the way kubectl does — "5d", "3h", "2m".
///
/// k8s-openapi wraps timestamps in `jiff`, not chrono, so the arithmetic
/// goes through epoch seconds rather than a chrono duration.
pub(crate) fn age(resource: &impl ResourceExt) -> Option<String> {
    let created = resource.creation_timestamp()?;
    let now = k8s_openapi::jiff::Timestamp::now();
    // Clamped at zero: clock skew between here and the API server
    // shouldn't render as a negative age.
    Some(format_age((now.as_second() - created.0.as_second()).max(0)))
}

/// The shorthand every age column in the app uses.
///
/// Split out so a timestamp that did not come from object metadata — a
/// Helm release's `last_deployed`, say — renders identically.
pub(crate) fn format_age(seconds: i64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

pub async fn list_namespaces(session: &Session) -> Result<Vec<NamespaceSummary>> {
    let client = session.client().await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;

    Ok(list
        .into_iter()
        .map(|ns| NamespaceSummary {
            age: age(&ns),
            name: ns.name_any(),
            phase: ns
                .status
                .and_then(|s| s.phase)
                .unwrap_or_else(|| "Unknown".into()),
        })
        .collect())
}

fn summarise_pod(pod: Pod) -> PodSummary {
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref());
    let total = statuses.map(|c| c.len()).unwrap_or(0);
    let ready = statuses
        .map(|c| c.iter().filter(|c| c.ready).count())
        .unwrap_or(0);
    let restarts = statuses
        .map(|c| c.iter().map(|c| c.restart_count).sum())
        .unwrap_or(0);

    PodSummary {
        age: age(&pod),
        name: pod.name_any(),
        namespace: pod.namespace().unwrap_or_default(),
        phase: pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        node: pod.spec.as_ref().and_then(|s| s.node_name.clone()),
        ready: format!("{ready}/{total}"),
        restarts,
    }
}

pub async fn list_pods(session: &Session, namespace: Option<String>) -> Result<Vec<PodSummary>> {
    let client = session.client().await?;
    // An absent namespace means "all namespaces", which is what the
    // cluster-wide view asks for. RBAC decides whether that succeeds.
    let api: Api<Pod> = match namespace {
        Some(ns) => Api::namespaced(client, &ns),
        None => Api::all(client),
    };
    let list = api.list(&ListParams::default()).await?;
    Ok(list.into_iter().map(summarise_pod).collect())
}

/// Pods scheduled onto one node.
///
/// Filtered server-side rather than by listing the cluster and keeping
/// the matches: on a large cluster the difference is thirty rows versus
/// thirty thousand.
pub async fn list_pods_on_node(session: &Session, node: &str) -> Result<Vec<PodSummary>> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::all(client);
    let params = ListParams::default().fields(&format!("spec.nodeName={node}"));
    Ok(api
        .list(&params)
        .await?
        .into_iter()
        .map(summarise_pod)
        .collect())
}

pub async fn list_nodes(session: &Session) -> Result<Vec<NodeSummary>> {
    let client = session.client().await?;
    let api: Api<Node> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;

    Ok(list
        .into_iter()
        .map(|node| {
            // Shared with the node detail view so the list and the page
            // it opens can never disagree about a node's roles.
            let roles = crate::cluster::detail::node::roles_of(&node);
            let ready = crate::cluster::detail::node::is_ready(&node);

            let version = node
                .status
                .as_ref()
                .and_then(|s| s.node_info.as_ref())
                .map(|i| i.kubelet_version.clone())
                .unwrap_or_default();

            NodeSummary {
                age: age(&node),
                name: node.name_any(),
                ready,
                roles,
                version,
            }
        })
        .collect())
}
