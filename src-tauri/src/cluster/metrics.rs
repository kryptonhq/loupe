//! Live CPU and memory use, from the metrics API.
//!
//! Requests say what the scheduler has promised; usage says what the
//! machines are actually doing, and the two diverge by a lot on most
//! clusters. Usage lives in `metrics.k8s.io`, served by metrics-server —
//! an add-on, absent on many clusters (kind, fresh EKS). So its absence
//! is an answer, not an error: the dashboard falls back to requests and
//! says why, rather than showing a red banner over a healthy cluster.
//!
//! Polled rather than watched: the metrics API does not support watch,
//! and it only refreshes every fifteen seconds or so anyway.

use kube::api::{Api, ApiResource, DynamicObject, ListParams};
use kube::core::GroupVersionKind;
use serde::Serialize;

use crate::cluster::detail::node::parse_quantity;
use crate::cluster::Session;
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsage {
    pub name: String,
    /// Cores in use.
    pub cpu: f64,
    /// Bytes in use (the working set).
    pub memory: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UsageAnswer {
    Available {
        nodes: Vec<NodeUsage>,
    },
    /// Why there is no usage to show, in words for the dashboard.
    Unavailable {
        reason: String,
    },
}

fn node_metrics() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "NodeMetrics"),
        "nodes",
    )
}

/// Reads each NodeMetrics' `usage`. An object the API sent malformed is
/// skipped rather than failing the lot: one odd node should not blank
/// the whole widget.
pub(crate) fn usage_from(objects: &[DynamicObject]) -> Vec<NodeUsage> {
    let mut rows: Vec<NodeUsage> = objects
        .iter()
        .filter_map(|o| {
            let usage = o.data.get("usage")?;
            let read = |key: &str| usage.get(key)?.as_str().and_then(parse_quantity);
            Some(NodeUsage {
                name: o.metadata.name.clone()?,
                cpu: read("cpu")?,
                memory: read("memory")?,
            })
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

/// What a failed metrics request means for the dashboard.
pub(crate) fn unavailable_reason(e: &kube::Error) -> String {
    match e {
        kube::Error::Api(s) if s.code == 404 => {
            "metrics-server is not installed, so usage is unknown".into()
        }
        kube::Error::Api(s) if s.code == 403 => "Not permitted to read node metrics".into(),
        // The APIService is registered but its backend is down — common
        // right after install, or when metrics-server cannot reach the
        // kubelets.
        kube::Error::Api(s) if s.code == 503 => {
            "The metrics API is registered but not answering".into()
        }
        other => format!("Could not read node metrics: {other}"),
    }
}

/// Current usage for every node, or why there is none.
pub async fn node_usage(session: &Session) -> Result<UsageAnswer> {
    let api: Api<DynamicObject> = Api::all_with(session.client().await?, &node_metrics());
    Ok(match api.list(&ListParams::default()).await {
        Ok(list) => UsageAnswer::Available {
            nodes: usage_from(&list.items),
        },
        Err(e) => UsageAnswer::Unavailable {
            reason: unavailable_reason(&e),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metrics(name: &str, usage: serde_json::Value) -> DynamicObject {
        serde_json::from_value(json!({
            "apiVersion": "metrics.k8s.io/v1beta1",
            "kind": "NodeMetrics",
            "metadata": { "name": name },
            "timestamp": "2026-09-26T00:00:00Z",
            "window": "10s",
            "usage": usage
        }))
        .unwrap()
    }

    fn status(code: u16) -> kube::Error {
        kube::Error::Api(
            kube::core::Status::failure("x", "y")
                .with_code(code)
                .boxed(),
        )
    }

    #[test]
    fn reads_cores_and_bytes() {
        let rows = usage_from(&[
            metrics("b", json!({ "cpu": "1500m", "memory": "2Gi" })),
            metrics("a", json!({ "cpu": "250000000n", "memory": "1048576Ki" })),
        ]);
        assert_eq!(
            rows,
            vec![
                NodeUsage {
                    name: "a".into(),
                    cpu: 0.25,
                    memory: 1024f64.powi(3)
                },
                NodeUsage {
                    name: "b".into(),
                    cpu: 1.5,
                    memory: 2.0 * 1024f64.powi(3)
                },
            ]
        );
    }

    #[test]
    fn skips_a_malformed_node_rather_than_failing_the_lot() {
        let rows = usage_from(&[
            metrics("ok", json!({ "cpu": "1", "memory": "1Gi" })),
            metrics("odd", json!({ "cpu": "lots" })),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "ok");
    }

    #[test]
    fn explains_each_way_the_metrics_api_can_be_missing() {
        assert!(unavailable_reason(&status(404)).contains("not installed"));
        assert!(unavailable_reason(&status(403)).contains("Not permitted"));
        assert!(unavailable_reason(&status(503)).contains("not answering"));
        assert!(unavailable_reason(&status(500)).starts_with("Could not read"));
    }

    #[test]
    fn serialises_the_way_the_frontend_reads_it() {
        let json = serde_json::to_value(UsageAnswer::Unavailable {
            reason: "nope".into(),
        })
        .unwrap();
        assert_eq!(json, json!({ "state": "unavailable", "reason": "nope" }));
        let json = serde_json::to_value(UsageAnswer::Available { nodes: vec![] }).unwrap();
        assert_eq!(json["state"], "available");
    }

    #[tokio::test]
    #[ignore = "needs a live cluster; set LOUPE_TEST_CONTEXT"]
    async fn a_live_cluster_answers_one_way_or_the_other() {
        // Either metrics-server is there and every node reports, or it is
        // not and the answer says so — never an error for the dashboard.
        let session = crate::cluster::live::session().await;
        match node_usage(&session).await.unwrap() {
            UsageAnswer::Available { nodes } => {
                println!("usage: {nodes:?}");
                assert!(!nodes.is_empty());
                assert!(nodes.iter().all(|n| n.cpu > 0.0 && n.memory > 0.0));
            }
            UsageAnswer::Unavailable { reason } => {
                println!("unavailable: {reason}");
                assert!(!reason.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn needs_a_connection() {
        assert!(matches!(
            node_usage(&Session::default()).await,
            Err(crate::error::AppError::NotConnected)
        ));
    }
}
