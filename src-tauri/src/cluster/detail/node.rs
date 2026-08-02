//! Node detail: capacity, pressure conditions, taints and what is
//! actually scheduled onto the machine.
//!
//! The interesting question about a node is rarely "is it Ready" — the
//! list view answers that. It is "why will nothing schedule here", and
//! the answer is usually a taint, a pressure condition, or requests that
//! have already claimed the allocatable CPU. All three live here.

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::detail::{sorted_pairs, to_yaml, ConditionView};
use crate::cluster::{resources::age, Session};
use crate::error::Result;

/// One resource dimension's headroom on a node.
///
/// Percentages are of *allocatable*, not capacity: the kubelet reserves
/// some of the machine for itself and the scheduler only ever hands out
/// what is left, so measuring against capacity would flatter every node.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub name: String,
    pub requests: String,
    pub requests_percent: Option<u32>,
    pub limits: String,
    pub limits_percent: Option<u32>,
    pub allocatable: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetail {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub ready: bool,
    /// False when the node is cordoned. Worth its own field: a cordoned
    /// node is still Ready, and the pair is the whole explanation for
    /// "why is nothing landing here".
    pub schedulable: bool,
    pub roles: Vec<String>,
    pub version: String,
    pub age: Option<String>,
    pub addresses: Vec<(String, String)>,
    pub os_image: Option<String>,
    pub kernel_version: Option<String>,
    pub container_runtime: Option<String>,
    pub architecture: Option<String>,
    pub operating_system: Option<String>,
    pub capacity: Vec<(String, String)>,
    pub allocatable: Vec<(String, String)>,
    /// CPU and memory claimed by the pods already scheduled here.
    pub allocated: Vec<ResourceUsage>,
    /// Rendered "key=value:Effect", the form taints are written in.
    pub taints: Vec<String>,
    pub conditions: Vec<ConditionView>,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub pod_count: usize,
    pub yaml: String,
}

/// Parses a Kubernetes quantity into a plain number.
///
/// Quantities carry either decimal SI suffixes (m, k, M, G) or binary
/// ones (Ki, Mi, Gi), and the two mean different things for the same
/// letter — "1M" is a million, "1Mi" is 1048576. Summing them requires
/// collapsing both to a common unit first: cores for CPU, bytes for
/// memory.
pub(crate) fn parse_quantity(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    // Binary suffixes are two characters and must be tested first, or
    // "Ki" would match the decimal "k" and come out 1024x too small.
    const BINARY: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1024f64 * 1024.0),
        ("Gi", 1024f64 * 1024.0 * 1024.0),
        ("Ti", 1024f64 * 1024.0 * 1024.0 * 1024.0),
        ("Pi", 1024f64 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("Ei", 1024f64 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0),
    ];
    for (suffix, factor) in BINARY {
        if let Some(num) = s.strip_suffix(suffix) {
            return num.trim().parse::<f64>().ok().map(|n| n * factor);
        }
    }

    const DECIMAL: [(&str, f64); 9] = [
        ("n", 1e-9),
        ("u", 1e-6),
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    for (suffix, factor) in DECIMAL {
        if let Some(num) = s.strip_suffix(suffix) {
            // "1e3" ends in a bare digit, but "1E" would strip to "1" and
            // silently become 1e18. Only strip when what remains parses.
            if let Ok(n) = num.trim().parse::<f64>() {
                return Some(n * factor);
            }
        }
    }

    // No suffix: a bare number, possibly in exponent form ("1e3").
    s.parse::<f64>().ok()
}

/// Renders a core count the way Kubernetes writes it — whole cores when
/// it divides evenly, millicores otherwise.
pub(crate) fn format_cpu(cores: f64) -> String {
    let millis = (cores * 1000.0).round() as i64;
    if millis != 0 && millis % 1000 == 0 {
        format!("{}", millis / 1000)
    } else {
        format!("{millis}m")
    }
}

/// Renders a byte count with the binary suffix that keeps it readable.
pub(crate) fn format_memory(bytes: f64) -> String {
    const UNITS: [(&str, f64); 4] = [
        ("Gi", 1024f64 * 1024.0 * 1024.0),
        ("Mi", 1024f64 * 1024.0),
        ("Ki", 1024.0),
        ("", 1.0),
    ];
    for (suffix, factor) in UNITS {
        if bytes.abs() >= factor {
            let value = bytes / factor;
            // One decimal is enough to distinguish 1.9Gi from 2.0Gi
            // without turning the column into noise.
            return if suffix.is_empty() {
                format!("{}", value.round() as i64)
            } else if (value - value.round()).abs() < 0.05 {
                format!("{}{suffix}", value.round() as i64)
            } else {
                format!("{value:.1}{suffix}")
            };
        }
    }
    "0".into()
}

/// CPU cores and memory bytes a pod claims from the scheduler.
///
/// Init containers run to completion before the app containers start, so
/// a pod's effective claim is the larger of "the biggest init container"
/// and "all app containers together" — not their sum. Getting this wrong
/// overstates every pod that has an init container.
fn pod_demand(
    pod: &Pod,
    field: fn(
        &k8s_openapi::api::core::v1::ResourceRequirements,
    ) -> Option<
        &std::collections::BTreeMap<
            String,
            k8s_openapi::apimachinery::pkg::api::resource::Quantity,
        >,
    >,
) -> (f64, f64) {
    let Some(spec) = &pod.spec else {
        return (0.0, 0.0);
    };

    let of = |containers: &[k8s_openapi::api::core::v1::Container]| -> (f64, f64) {
        containers.iter().fold((0.0, 0.0), |(cpu, mem), c| {
            let Some(map) = c.resources.as_ref().and_then(field) else {
                return (cpu, mem);
            };
            let read = |key: &str| {
                map.get(key)
                    .and_then(|q| parse_quantity(&q.0))
                    .unwrap_or(0.0)
            };
            (cpu + read("cpu"), mem + read("memory"))
        })
    };

    let (app_cpu, app_mem) = of(&spec.containers);
    let (init_cpu, init_mem) = spec
        .init_containers
        .as_deref()
        .unwrap_or_default()
        .iter()
        .fold((0.0f64, 0.0f64), |(cpu, mem), c| {
            let (c_cpu, c_mem) = of(std::slice::from_ref(c));
            (cpu.max(c_cpu), mem.max(c_mem))
        });

    (app_cpu.max(init_cpu), app_mem.max(init_mem))
}

/// Sums what the given pods claim, ignoring ones that have finished.
///
/// A Succeeded or Failed pod still exists in the API and still names a
/// node, but it holds no reservation — counting it would show a node as
/// full when it is empty.
fn allocated_from(
    pods: &[Pod],
    allocatable_cpu: Option<f64>,
    allocatable_mem: Option<f64>,
) -> Vec<ResourceUsage> {
    let live: Vec<&Pod> = pods
        .iter()
        .filter(|p| {
            !matches!(
                p.status.as_ref().and_then(|s| s.phase.as_deref()),
                Some("Succeeded") | Some("Failed")
            )
        })
        .collect();

    let sum = |field: fn(
        &k8s_openapi::api::core::v1::ResourceRequirements,
    ) -> Option<
        &std::collections::BTreeMap<
            String,
            k8s_openapi::apimachinery::pkg::api::resource::Quantity,
        >,
    >| {
        live.iter().fold((0.0, 0.0), |(cpu, mem), p| {
            let (c, m) = pod_demand(p, field);
            (cpu + c, mem + m)
        })
    };

    let (req_cpu, req_mem) = sum(|r| r.requests.as_ref());
    let (lim_cpu, lim_mem) = sum(|r| r.limits.as_ref());

    let percent = |used: f64, total: Option<f64>| {
        total
            .filter(|t| *t > 0.0)
            .map(|t| (used / t * 100.0).round() as u32)
    };

    vec![
        ResourceUsage {
            name: "CPU".into(),
            requests: format_cpu(req_cpu),
            requests_percent: percent(req_cpu, allocatable_cpu),
            limits: format_cpu(lim_cpu),
            limits_percent: percent(lim_cpu, allocatable_cpu),
            allocatable: allocatable_cpu
                .map(format_cpu)
                .unwrap_or_else(|| "—".into()),
        },
        ResourceUsage {
            name: "Memory".into(),
            requests: format_memory(req_mem),
            requests_percent: percent(req_mem, allocatable_mem),
            limits: format_memory(lim_mem),
            limits_percent: percent(lim_mem, allocatable_mem),
            allocatable: allocatable_mem
                .map(format_memory)
                .unwrap_or_else(|| "—".into()),
        },
    ]
}

/// Roles live in labels, not a field: node-role.kubernetes.io/<role>.
pub(crate) fn roles_of(node: &Node) -> Vec<String> {
    node.labels()
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn is_ready(node: &Node) -> bool {
    node.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        .unwrap_or(false)
}

fn quantities(
    map: Option<
        &std::collections::BTreeMap<
            String,
            k8s_openapi::apimachinery::pkg::api::resource::Quantity,
        >,
    >,
) -> Vec<(String, String)> {
    map.map(|m| m.iter().map(|(k, v)| (k.clone(), v.0.clone())).collect())
        .unwrap_or_default()
}

pub async fn get_node(session: &Session, name: &str) -> Result<NodeDetail> {
    let client = session.client().await?;
    let api: Api<Node> = Api::all(client.clone());
    let node = api.get(name).await?;

    // Pods are fetched server-side by node, not filtered client-side
    // from a cluster-wide listing: on a large cluster the difference is
    // thirty rows versus thirty thousand.
    let pods: Api<Pod> = Api::all(client);
    let scheduled = pods
        .list(&ListParams::default().fields(&format!("spec.nodeName={name}")))
        .await?
        .items;

    node_detail_from(node, &scheduled)
}

/// Builds the node detail from the node and the pods scheduled onto it.
///
/// Split from the fetch so the parts an operator reads when nothing will
/// schedule — taints, cordon state, allocation against allocatable — can
/// be tested against constructed nodes.
pub(crate) fn node_detail_from(mut node: Node, scheduled: &[Pod]) -> Result<NodeDetail> {
    node.metadata.managed_fields = None;

    let yaml = to_yaml(&node)?;

    let status = node.status.clone();
    let info = status.as_ref().and_then(|s| s.node_info.as_ref());

    let allocatable = status.as_ref().and_then(|s| s.allocatable.as_ref());
    let alloc_cpu = allocatable
        .and_then(|m| m.get("cpu"))
        .and_then(|q| parse_quantity(&q.0));
    let alloc_mem = allocatable
        .and_then(|m| m.get("memory"))
        .and_then(|q| parse_quantity(&q.0));

    Ok(NodeDetail {
        api_version: "v1".into(),
        kind: "Node".into(),
        age: age(&node),
        ready: is_ready(&node),
        // `unschedulable: true` is what `kubectl cordon` sets; absent
        // means schedulable.
        schedulable: !node
            .spec
            .as_ref()
            .and_then(|s| s.unschedulable)
            .unwrap_or(false),
        roles: roles_of(&node),
        version: info.map(|i| i.kubelet_version.clone()).unwrap_or_default(),
        addresses: status
            .as_ref()
            .and_then(|s| s.addresses.as_ref())
            .map(|a| {
                a.iter()
                    .map(|a| (a.type_.clone(), a.address.clone()))
                    .collect()
            })
            .unwrap_or_default(),
        os_image: info.map(|i| i.os_image.clone()),
        kernel_version: info.map(|i| i.kernel_version.clone()),
        container_runtime: info.map(|i| i.container_runtime_version.clone()),
        architecture: info.map(|i| i.architecture.clone()),
        operating_system: info.map(|i| i.operating_system.clone()),
        capacity: quantities(status.as_ref().and_then(|s| s.capacity.as_ref())),
        allocatable: quantities(allocatable),
        allocated: allocated_from(scheduled, alloc_cpu, alloc_mem),
        taints: node
            .spec
            .as_ref()
            .and_then(|s| s.taints.as_ref())
            .map(|ts| {
                ts.iter()
                    .map(|t| match &t.value {
                        Some(v) if !v.is_empty() => format!("{}={}:{}", t.key, v, t.effect),
                        _ => format!("{}:{}", t.key, t.effect),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        conditions: status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| {
                cs.iter()
                    .map(|c| ConditionView {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        labels: sorted_pairs(node.labels()),
        annotations: sorted_pairs(node.annotations()),
        pod_count: scheduled.len(),
        name: node.name_any(),
        yaml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Container, PodSpec, PodStatus, ResourceRequirements};
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn requirements(cpu: &str, memory: &str) -> ResourceRequirements {
        let mut map = std::collections::BTreeMap::new();
        map.insert("cpu".to_string(), Quantity(cpu.into()));
        map.insert("memory".to_string(), Quantity(memory.into()));
        ResourceRequirements {
            requests: Some(map.clone()),
            limits: Some(map),
            ..Default::default()
        }
    }

    fn pod(phase: &str, containers: Vec<Container>, init: Vec<Container>) -> Pod {
        Pod {
            spec: Some(PodSpec {
                containers,
                init_containers: if init.is_empty() { None } else { Some(init) },
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some(phase.into()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn container(cpu: &str, memory: &str) -> Container {
        Container {
            name: "c".into(),
            resources: Some(requirements(cpu, memory)),
            ..Default::default()
        }
    }

    #[test]
    fn parses_binary_suffixes_distinctly_from_decimal_ones() {
        // The same letter means different things; conflating them is a
        // 4.8% error on memory columns, which looks like a rounding bug
        // rather than a unit bug.
        assert_eq!(parse_quantity("1Mi"), Some(1_048_576.0));
        assert_eq!(parse_quantity("1M"), Some(1_000_000.0));
        assert_eq!(parse_quantity("1Ki"), Some(1024.0));
        assert_eq!(parse_quantity("1k"), Some(1000.0));
    }

    #[test]
    fn parses_millicores_and_bare_numbers() {
        assert_eq!(parse_quantity("100m"), Some(0.1));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("0.5"), Some(0.5));
    }

    #[test]
    fn parses_exponent_notation_without_mistaking_e_for_exa() {
        // "1e3" is a thousand. Stripping a trailing "E" suffix off it
        // would make it 1e18.
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert_eq!(parse_quantity("2E"), Some(2e18));
    }

    #[test]
    fn rejects_garbage_rather_than_guessing_zero() {
        // A zero would silently understate a node's allocation; None
        // lets the caller show that it does not know.
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("lots"), None);
        assert_eq!(parse_quantity("Mi"), None);
    }

    #[test]
    fn formats_cpu_as_cores_or_millicores() {
        assert_eq!(format_cpu(2.0), "2");
        assert_eq!(format_cpu(0.25), "250m");
        assert_eq!(format_cpu(1.5), "1500m");
        assert_eq!(format_cpu(0.0), "0m");
    }

    #[test]
    fn formats_memory_with_a_readable_binary_suffix() {
        assert_eq!(format_memory(1024.0 * 1024.0 * 1024.0), "1Gi");
        assert_eq!(format_memory(1.5 * 1024.0 * 1024.0 * 1024.0), "1.5Gi");
        assert_eq!(format_memory(512.0 * 1024.0 * 1024.0), "512Mi");
        assert_eq!(format_memory(0.0), "0");
    }

    #[test]
    fn a_pods_claim_is_the_larger_of_its_init_and_app_containers() {
        // Init containers run before the app containers, so they never
        // hold memory at the same time. Summing them would double-count.
        let p = pod(
            "Running",
            vec![container("100m", "128Mi")],
            vec![container("500m", "512Mi")],
        );
        let (cpu, mem) = pod_demand(&p, |r| r.requests.as_ref());
        assert_eq!(cpu, 0.5);
        assert_eq!(mem, 512.0 * 1024.0 * 1024.0);
    }

    #[test]
    fn app_containers_are_summed_across_the_pod() {
        let p = pod(
            "Running",
            vec![container("100m", "128Mi"), container("200m", "128Mi")],
            vec![],
        );
        let (cpu, mem) = pod_demand(&p, |r| r.requests.as_ref());
        assert!((cpu - 0.3).abs() < 1e-9, "got {cpu}");
        assert_eq!(mem, 256.0 * 1024.0 * 1024.0);
    }

    #[test]
    fn a_container_without_requests_claims_nothing() {
        let bare = Container {
            name: "c".into(),
            ..Default::default()
        };
        assert_eq!(
            pod_demand(&pod("Running", vec![bare], vec![]), |r| r.requests.as_ref()),
            (0.0, 0.0)
        );
    }

    #[test]
    fn finished_pods_do_not_hold_a_reservation() {
        // A Succeeded pod still names a node. Counting it would show a
        // node as full when nothing is actually running on it.
        let pods = vec![
            pod("Running", vec![container("1", "1Gi")], vec![]),
            pod("Succeeded", vec![container("4", "8Gi")], vec![]),
            pod("Failed", vec![container("4", "8Gi")], vec![]),
        ];
        let usage = allocated_from(&pods, Some(4.0), Some(4.0 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(usage[0].requests, "1");
        assert_eq!(usage[1].requests, "1Gi");
    }

    #[test]
    fn allocation_percentages_are_of_allocatable() {
        let pods = vec![pod("Running", vec![container("1", "1Gi")], vec![])];
        let usage = allocated_from(&pods, Some(4.0), Some(4.0 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(usage[0].requests_percent, Some(25));
        assert_eq!(usage[1].requests_percent, Some(25));
        assert_eq!(usage[0].allocatable, "4");
    }

    #[test]
    fn unknown_allocatable_yields_no_percentage_rather_than_zero() {
        // A node whose status we could not read should say so, not claim
        // it is 0% utilised.
        let pods = vec![pod("Running", vec![container("1", "1Gi")], vec![])];
        let usage = allocated_from(&pods, None, None);
        assert_eq!(usage[0].requests_percent, None);
        assert_eq!(usage[0].allocatable, "—");
    }

    /// A node with the shape the detail view reads: capacity, a Ready
    /// condition, and the labels roles come from.
    fn node(name: &str) -> Node {
        use k8s_openapi::api::core::v1::{NodeCondition, NodeStatus, NodeSystemInfo};

        let quantities = |cpu: &str, mem: &str| {
            let mut m = std::collections::BTreeMap::new();
            m.insert("cpu".to_string(), Quantity(cpu.into()));
            m.insert("memory".to_string(), Quantity(mem.into()));
            m
        };

        Node {
            metadata: kube::core::ObjectMeta {
                name: Some(name.into()),
                labels: Some(
                    [("node-role.kubernetes.io/worker", "")]
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                ),
                ..Default::default()
            },
            status: Some(NodeStatus {
                capacity: Some(quantities("8", "16Gi")),
                allocatable: Some(quantities("7800m", "15Gi")),
                conditions: Some(vec![NodeCondition {
                    type_: "Ready".into(),
                    status: "True".into(),
                    ..Default::default()
                }]),
                node_info: Some(NodeSystemInfo {
                    kubelet_version: "v1.33.1".into(),
                    os_image: "Debian GNU/Linux 12".into(),
                    architecture: "arm64".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_cordoned_node_is_still_ready_but_not_schedulable() {
        // The pair is the whole explanation for "why is nothing landing
        // here". Collapsing them into one flag loses the answer:
        // `kubectl cordon` does not make a node unhealthy.
        let mut cordoned = node("worker-1");
        cordoned.spec = Some(k8s_openapi::api::core::v1::NodeSpec {
            unschedulable: Some(true),
            ..Default::default()
        });

        let detail = node_detail_from(cordoned, &[]).expect("build detail");
        assert!(detail.ready, "cordoning does not make a node unhealthy");
        assert!(!detail.schedulable);
    }

    #[test]
    fn a_node_with_no_spec_is_schedulable() {
        // `unschedulable` absent means schedulable. Defaulting the other
        // way would show every healthy node as cordoned.
        let detail = node_detail_from(node("worker-1"), &[]).expect("build detail");
        assert!(detail.schedulable);
        assert!(detail.ready);
        assert_eq!(detail.roles, vec!["worker"]);
        assert_eq!(detail.version, "v1.33.1");
        assert_eq!(detail.architecture.as_deref(), Some("arm64"));
    }

    #[test]
    fn taints_render_the_way_they_are_written() {
        // The form they are applied in, so what the page shows can be
        // pasted back into a toleration.
        use k8s_openapi::api::core::v1::{NodeSpec, Taint};

        let mut tainted = node("worker-1");
        tainted.spec = Some(NodeSpec {
            taints: Some(vec![
                Taint {
                    key: "dedicated".into(),
                    value: Some("gpu".into()),
                    effect: "NoSchedule".into(),
                    ..Default::default()
                },
                // A valueless taint is common — the control-plane one is
                // exactly this shape — and "key=:Effect" would be wrong.
                Taint {
                    key: "node.kubernetes.io/unreachable".into(),
                    value: None,
                    effect: "NoExecute".into(),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        });

        let detail = node_detail_from(tainted, &[]).expect("build detail");
        assert_eq!(
            detail.taints,
            vec![
                "dedicated=gpu:NoSchedule",
                "node.kubernetes.io/unreachable:NoExecute"
            ]
        );
    }

    #[test]
    fn allocation_is_measured_against_allocatable_not_capacity() {
        // The kubelet reserves part of the machine for itself and the
        // scheduler only hands out what is left. Measuring against
        // capacity would flatter every node — here 4 of 8 cores reads as
        // 50%, when the scheduler only has 7.8 to give.
        let pods = vec![pod("Running", vec![container("4", "4Gi")], vec![])];
        let detail = node_detail_from(node("worker-1"), &pods).expect("build detail");

        let cpu = detail.allocated.iter().find(|u| u.name == "CPU").unwrap();
        assert_eq!(cpu.allocatable, "7800m");
        assert_eq!(
            cpu.requests_percent,
            Some(51),
            "4 cores of 7.8 allocatable, not of 8 capacity"
        );
        assert_eq!(detail.pod_count, 1);
        // Capacity is still reported, just not what percentages are of.
        assert!(detail.capacity.iter().any(|(k, v)| k == "cpu" && v == "8"));
    }

    #[test]
    fn a_node_with_nothing_scheduled_reports_zero_rather_than_nothing() {
        // An empty node still has rows: "0 of 7800m" is information,
        // whereas a missing table reads as a failure to load.
        let detail = node_detail_from(node("worker-1"), &[]).expect("build detail");
        assert_eq!(detail.pod_count, 0);
        assert_eq!(detail.allocated.len(), 2, "CPU and Memory");
        assert_eq!(detail.allocated[0].requests_percent, Some(0));
    }

    #[test]
    fn node_detail_strips_managed_fields_and_carries_its_identity() {
        let mut noisy = node("worker-1");
        noisy.metadata.managed_fields = Some(vec![
            k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry {
                manager: Some("kubelet".into()),
                ..Default::default()
            },
        ]);

        let detail = node_detail_from(noisy, &[]).expect("build detail");
        assert!(!detail.yaml.contains("managedFields"));
        assert_eq!(detail.api_version, "v1");
        assert_eq!(detail.kind, "Node");
        assert_eq!(detail.name, "worker-1");
    }

    #[test]
    fn a_node_reporting_no_status_still_renders() {
        // A node mid-registration. Every optional field is absent, and
        // the page has to degrade rather than fail.
        let bare = Node {
            metadata: kube::core::ObjectMeta {
                name: Some("joining".into()),
                ..Default::default()
            },
            ..Default::default()
        };

        let detail = node_detail_from(bare, &[]).expect("build detail");
        assert!(!detail.ready);
        assert!(detail.schedulable);
        assert!(detail.conditions.is_empty());
        assert!(detail.addresses.is_empty());
        assert!(detail.capacity.is_empty());
        assert_eq!(detail.os_image, None);
        // The allocation table still exists, with nothing known to
        // measure against.
        assert_eq!(detail.allocated[0].allocatable, "—");
    }

    #[test]
    fn conditions_carry_the_reason_that_explains_the_pressure() {
        // "MemoryPressure=True" says the node is under pressure;
        // the reason says which threshold tripped, and that is what
        // decides what to do about it.
        use k8s_openapi::api::core::v1::{NodeCondition, NodeStatus};

        let mut pressured = node("worker-1");
        pressured.status = Some(NodeStatus {
            conditions: Some(vec![NodeCondition {
                type_: "MemoryPressure".into(),
                status: "True".into(),
                reason: Some("KubeletHasInsufficientMemory".into()),
                message: Some("kubelet has insufficient memory available".into()),
                ..Default::default()
            }]),
            ..pressured.status.unwrap()
        });

        let detail = node_detail_from(pressured, &[]).expect("build detail");
        let pressure = detail
            .conditions
            .iter()
            .find(|c| c.type_ == "MemoryPressure")
            .expect("condition should survive");
        assert_eq!(
            pressure.reason.as_deref(),
            Some("KubeletHasInsufficientMemory")
        );
        assert!(pressure.message.is_some());
        // No Ready condition in this status, so the node is not Ready.
        assert!(!detail.ready);
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn reads_a_live_node_detail() {
        let session = crate::cluster::live::session().await;

        let nodes = crate::cluster::resources::list_nodes(&session)
            .await
            .expect("list nodes");
        let target = nodes.first().expect("a cluster has a node");

        let detail = get_node(&session, &target.name).await.expect("get node");
        println!(
            "{}: {} pod(s), cpu {} of {} ({:?}%)",
            detail.name,
            detail.pod_count,
            detail.allocated[0].requests,
            detail.allocated[0].allocatable,
            detail.allocated[0].requests_percent,
        );

        assert_eq!(detail.name, target.name);
        assert_eq!(detail.kind, "Node");
        assert!(!detail.capacity.is_empty(), "a node reports capacity");

        // The count on the overview and the rows in the Pods tab come
        // from two separate calls; if they disagree, one of the field
        // selectors is wrong.
        let scheduled = crate::cluster::resources::list_pods_on_node(&session, &target.name)
            .await
            .expect("list pods on node");
        assert_eq!(detail.pod_count, scheduled.len());
        assert!(
            scheduled
                .iter()
                .all(|p| p.node.as_deref() == Some(target.name.as_str())),
            "the field selector should return only this node's pods"
        );

        assert!(detail.os_image.is_some(), "a node reports its OS image");
        assert!(detail.yaml.contains("kind: Node"));
        assert!(!detail.yaml.contains("managedFields"));
        assert!(
            detail.conditions.iter().any(|c| c.type_ == "Ready"),
            "a node always has a Ready condition"
        );
    }
}
