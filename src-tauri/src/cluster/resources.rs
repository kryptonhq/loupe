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

fn summarise_namespace(ns: Namespace) -> NamespaceSummary {
    NamespaceSummary {
        age: age(&ns),
        name: ns.name_any(),
        phase: ns
            .status
            .and_then(|s| s.phase)
            .unwrap_or_else(|| "Unknown".into()),
    }
}

pub async fn list_namespaces(session: &Session) -> Result<Vec<NamespaceSummary>> {
    let client = session.client().await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    Ok(list.into_iter().map(summarise_namespace).collect())
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

fn summarise_node(node: Node) -> NodeSummary {
    // Roles and readiness are shared with the node detail view so the
    // list and the page it opens can never disagree about a node.
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
}

pub async fn list_nodes(session: &Session) -> Result<Vec<NodeSummary>> {
    let client = session.client().await?;
    let api: Api<Node> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    Ok(list.into_iter().map(summarise_node).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        ContainerStatus, NamespaceStatus, NodeStatus, NodeSystemInfo, PodSpec, PodStatus,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};

    fn meta(name: &str) -> ObjectMeta {
        ObjectMeta {
            name: Some(name.into()),
            ..Default::default()
        }
    }

    /// A container status with everything the ready/restart columns read.
    fn container(name: &str, ready: bool, restarts: i32) -> ContainerStatus {
        ContainerStatus {
            name: name.into(),
            ready,
            restart_count: restarts,
            image: "nginx:1.27".into(),
            ..Default::default()
        }
    }

    #[test]
    fn age_uses_the_largest_unit_that_still_reads_as_a_number() {
        // kubectl's shorthand. Each boundary is one second either side,
        // because an off-by-one here shows "60m" where kubectl shows
        // "1h" and quietly stops matching the tool people compare against.
        assert_eq!(format_age(0), "0s");
        assert_eq!(format_age(59), "59s");
        assert_eq!(format_age(60), "1m");
        assert_eq!(format_age(3599), "59m");
        assert_eq!(format_age(3600), "1h");
        assert_eq!(format_age(86_399), "23h");
        assert_eq!(format_age(86_400), "1d");
        assert_eq!(format_age(86_400 * 400), "400d");
    }

    #[test]
    fn an_object_with_no_creation_timestamp_has_no_age() {
        // Rendering "0s" would claim the object was created just now,
        // which is a stronger statement than "we do not know".
        let pod = Pod {
            metadata: meta("undated"),
            ..Default::default()
        };
        assert_eq!(age(&pod), None);
    }

    #[test]
    fn a_creation_timestamp_in_the_future_clamps_to_zero() {
        // Clock skew between the workstation and the API server is
        // routine; a node whose age renders as "-3s" reads as a bug in
        // Loupe rather than as a clock that needs fixing.
        let future = k8s_openapi::jiff::Timestamp::now().as_second() + 600;
        let pod = Pod {
            metadata: ObjectMeta {
                creation_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(future).unwrap(),
                )),
                ..meta("skewed")
            },
            ..Default::default()
        };
        assert_eq!(age(&pod).as_deref(), Some("0s"));
    }

    #[test]
    fn ready_counts_only_the_containers_reporting_ready() {
        // The column every operator reads first. "2/3" and "3/3" are the
        // difference between a healthy pod and one to investigate.
        let pod = Pod {
            metadata: meta("web"),
            spec: Some(PodSpec {
                node_name: Some("node-1".into()),
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".into()),
                container_statuses: Some(vec![
                    container("app", true, 0),
                    container("sidecar", false, 2),
                    container("proxy", true, 1),
                ]),
                ..Default::default()
            }),
        };

        let got = summarise_pod(pod);
        assert_eq!(got.ready, "2/3");
        // Restarts are summed across containers: a pod is restarting if
        // any container is, and the per-container split is on the
        // detail page rather than in a list column.
        assert_eq!(got.restarts, 3);
        assert_eq!(got.node.as_deref(), Some("node-1"));
        assert_eq!(got.phase, "Running");
    }

    #[test]
    fn a_pod_that_has_not_been_scheduled_yet_summarises_without_panicking() {
        // Between creation and scheduling there is no status and no
        // node. This is the state a pod is in exactly when someone is
        // watching the list to see whether it schedules.
        let pod = Pod {
            metadata: meta("pending"),
            ..Default::default()
        };

        let got = summarise_pod(pod);
        assert_eq!(got.ready, "0/0");
        assert_eq!(got.restarts, 0);
        assert_eq!(got.node, None);
        // Not "Running", and not an empty cell that reads as a rendering
        // failure.
        assert_eq!(got.phase, "Unknown");
        assert_eq!(got.namespace, "", "an unscoped pod reports no namespace");
    }

    #[test]
    fn a_namespace_without_a_status_reads_as_unknown_rather_than_active() {
        // Guessing "Active" would be the dangerous direction to be wrong
        // in: a terminating namespace would look healthy.
        let ns = Namespace {
            metadata: meta("orphan"),
            ..Default::default()
        };
        assert_eq!(summarise_namespace(ns).phase, "Unknown");

        let terminating = Namespace {
            metadata: meta("going"),
            status: Some(NamespaceStatus {
                phase: Some("Terminating".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(summarise_namespace(terminating).phase, "Terminating");
    }

    #[test]
    fn a_node_summary_carries_its_kubelet_version_and_roles() {
        let node = Node {
            metadata: ObjectMeta {
                labels: Some(
                    [(
                        "node-role.kubernetes.io/control-plane".to_string(),
                        String::new(),
                    )]
                    .into_iter()
                    .collect(),
                ),
                ..meta("cp-0")
            },
            status: Some(NodeStatus {
                node_info: Some(NodeSystemInfo {
                    kubelet_version: "v1.33.1".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let got = summarise_node(node);
        assert_eq!(got.name, "cp-0");
        assert_eq!(got.version, "v1.33.1");
        assert_eq!(got.roles, vec!["control-plane"]);
        // No Ready condition at all is not the same as Ready.
        assert!(!got.ready);
    }

    #[test]
    fn a_node_that_reports_no_version_renders_blank_rather_than_failing() {
        // A node mid-registration has no nodeInfo yet. An empty version
        // cell is honest; refusing to list the node is not.
        let node = Node {
            metadata: meta("joining"),
            ..Default::default()
        };
        let got = summarise_node(node);
        assert_eq!(got.version, "");
        assert!(got.roles.is_empty());
    }
}
