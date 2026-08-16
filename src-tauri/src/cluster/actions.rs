//! The handful of verbs an operator reaches for during an incident.
//!
//! Until now the only way to change anything was to edit YAML. That is a
//! poor substitute for typing a replica count, and for "restart this
//! Deployment" it is not a substitute at all — the restart is a patch to
//! a pod-template annotation that nobody should be hand-writing.
//!
//! Everything here is deliberately small and deliberately explicit.
//! Nothing composes, nothing retries, and nothing guesses: each function
//! sends one request and reports exactly what the API server said. The
//! confirmation, and the check that the context allows writes at all,
//! belong to the caller — see `crate::guard`.

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{
    Api, DeleteParams, DynamicObject, EvictParams, ListParams, Patch, PatchParams, ResourceExt,
};
use serde::Serialize;
use serde_json::json;

use crate::cluster::discovery::{api_for, resolve, GvkRef};
use crate::cluster::Session;
use crate::error::{AppError, Result};

/// The annotation `kubectl rollout restart` writes.
///
/// Restarting a workload is not an API verb: kubectl changes the pod
/// template so the controller rolls the pods itself. Using the same
/// annotation means a restart from Loupe and one from kubectl are the
/// same event, rather than two competing conventions on one object.
const RESTART_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";

/// Sets the replica count through the scale subresource.
///
/// The subresource rather than a patch to `spec.replicas`, because it is
/// the one endpoint every scalable kind agrees on — including custom
/// resources that declare a scale subresource of their own.
pub async fn scale(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
    name: &str,
    replicas: i32,
) -> Result<i32> {
    if replicas < 0 {
        // Caught here rather than by the API server, so the message is
        // about what the user did rather than about a schema.
        return Err(AppError::InvalidEdit(
            "a replica count cannot be negative".into(),
        ));
    }

    let (resource, caps) = resolve(session, &gvk).await?;
    let api = api_for(
        session.client().await?,
        &resource,
        &caps,
        namespace.as_deref(),
    );

    api.patch_scale(
        name,
        &PatchParams::default(),
        &Patch::Merge(json!({ "spec": { "replicas": replicas } })),
    )
    .await?;

    Ok(replicas)
}

/// Rolls a workload by touching its pod template.
///
/// `now` is passed in rather than read here so the behaviour can be
/// tested against a fixed clock.
pub async fn rollout_restart(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
    name: &str,
) -> Result<String> {
    let now = chrono::Utc::now().to_rfc3339();
    let patch = restart_patch(&now);

    let (resource, caps) = resolve(session, &gvk).await?;
    let api = api_for(
        session.client().await?,
        &resource,
        &caps,
        namespace.as_deref(),
    );

    api.patch(name, &PatchParams::default(), &Patch::Merge(patch))
        .await?;

    Ok(now)
}

/// The patch a rollout restart sends. Split out so its shape is tested
/// without a cluster — a typo in the path would silently do nothing.
pub(crate) fn restart_patch(now: &str) -> serde_json::Value {
    json!({
        "spec": { "template": { "metadata": { "annotations": {
            RESTART_ANNOTATION: now
        }}}}
    })
}

/// Deletes an object.
///
/// No cascade option is offered. The API server's default — background
/// propagation — is what kubectl does, and the alternatives (orphaning
/// children, foreground blocking) are choices that need more explanation
/// than a confirmation dialog can carry.
pub async fn delete_object(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
    name: &str,
) -> Result<()> {
    let (resource, caps) = resolve(session, &gvk).await?;
    let api: Api<DynamicObject> = api_for(
        session.client().await?,
        &resource,
        &caps,
        namespace.as_deref(),
    );

    api.delete(name, &DeleteParams::default()).await?;
    Ok(())
}

/// Marks a node schedulable or not.
pub async fn set_node_schedulable(
    session: &Session,
    node: &str,
    schedulable: bool,
) -> Result<bool> {
    let api: Api<Node> = Api::all(session.client().await?);
    api.patch(
        node,
        &PatchParams::default(),
        // `unschedulable` is the field; cordoning sets it true.
        &Patch::Merge(json!({ "spec": { "unschedulable": !schedulable } })),
    )
    .await?;
    Ok(schedulable)
}

/// What happened to one pod during a drain.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DrainEvent {
    /// How many pods will be attempted, sent before any of them are.
    Started {
        pods: usize,
    },
    Evicted {
        pod: String,
    },
    /// Left alone, with the reason — a mirror pod, or a DaemonSet's.
    Skipped {
        pod: String,
        reason: String,
    },
    Failed {
        pod: String,
        message: String,
    },
    Finished {
        evicted: usize,
        skipped: usize,
        failed: usize,
    },
}

/// Where drain progress goes. Same shape as the log sink, and for the
/// same reason: a drain can take minutes, and a spinner that says
/// nothing for minutes is indistinguishable from a hang.
pub trait DrainSink: Send + Sync + 'static {
    fn send(&self, event: DrainEvent) -> bool;
}

impl DrainSink for tauri::ipc::Channel<DrainEvent> {
    fn send(&self, event: DrainEvent) -> bool {
        tauri::ipc::Channel::send(self, event).is_ok()
    }
}

/// Why a pod should not be evicted, or None if it should.
///
/// Pure, and the part with the actual judgement in it. Getting this
/// wrong means either refusing to drain a node that could be drained, or
/// trying to evict a pod that will be recreated on the same node
/// immediately — kubectl skips both for the same reasons.
pub(crate) fn skip_reason(pod: &Pod) -> Option<String> {
    let owners = pod.owner_references();

    if owners.iter().any(|o| o.kind == "DaemonSet") {
        return Some("managed by a DaemonSet".into());
    }
    // A mirror pod is the kubelet's copy of a static pod; the API server
    // cannot evict it, and the request fails rather than being ignored.
    if pod
        .annotations()
        .contains_key("kubernetes.io/config.mirror")
    {
        return Some("static pod".into());
    }
    if pod
        .status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .is_some_and(|p| p == "Succeeded" || p == "Failed")
    {
        return Some("already terminated".into());
    }
    None
}

/// Evicts the pods on a node, reporting each one.
///
/// Uses the eviction API rather than deleting pods, so PodDisruptionBudgets
/// are honoured — deleting would ignore them, which is the difference
/// between draining a node and causing an outage.
pub async fn drain(session: &Session, node: &str, sink: impl DrainSink) -> Result<()> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::all(client);

    let pods = api
        .list(&ListParams::default().fields(&format!("spec.nodeName={node}")))
        .await?;

    if !sink.send(DrainEvent::Started {
        pods: pods.items.len(),
    }) {
        return Ok(());
    }

    let (mut evicted, mut skipped, mut failed) = (0, 0, 0);

    for pod in pods.items {
        let name = pod.name_any();
        let namespace = pod.namespace().unwrap_or_default();

        if let Some(reason) = skip_reason(&pod) {
            skipped += 1;
            if !sink.send(DrainEvent::Skipped { pod: name, reason }) {
                return Ok(());
            }
            continue;
        }

        let scoped: Api<Pod> = Api::namespaced(session.client().await?, &namespace);
        let sent = match scoped.evict(&name, &EvictParams::default()).await {
            Ok(_) => {
                evicted += 1;
                sink.send(DrainEvent::Evicted { pod: name })
            }
            Err(e) => {
                // A PodDisruptionBudget refusal arrives here. It is the
                // system working, and the message says which budget.
                failed += 1;
                sink.send(DrainEvent::Failed {
                    pod: name,
                    message: e.to_string(),
                })
            }
        };
        if !sent {
            return Ok(());
        }
    }

    sink.send(DrainEvent::Finished {
        evicted,
        skipped,
        failed,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;

    fn pod(name: &str) -> Pod {
        Pod {
            metadata: kube::api::ObjectMeta {
                name: Some(name.into()),
                namespace: Some("default".into()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn owned_by(kind: &str) -> OwnerReference {
        OwnerReference {
            api_version: "apps/v1".into(),
            kind: kind.into(),
            name: "owner".into(),
            uid: "uid".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_restart_patches_the_pod_template_not_the_workload() {
        // The annotation has to land on spec.template.metadata, or the
        // controller sees no change and nothing rolls. A typo in this
        // path is silent: the patch succeeds and does nothing.
        let patch = restart_patch("2026-08-16T10:00:00Z");
        let at = patch
            .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
            .and_then(|v| v.as_str());
        assert_eq!(at, Some("2026-08-16T10:00:00Z"));
    }

    #[test]
    fn a_restart_uses_the_same_annotation_kubectl_does() {
        // So a restart from Loupe and one from kubectl are the same
        // event rather than two conventions fighting over one object.
        assert_eq!(RESTART_ANNOTATION, "kubectl.kubernetes.io/restartedAt");
    }

    #[test]
    fn an_ordinary_pod_is_evicted() {
        assert_eq!(skip_reason(&pod("api-1")), None);
    }

    #[test]
    fn a_daemonset_pod_is_skipped() {
        // It would be recreated on the same node immediately, so
        // evicting it achieves nothing and slows the drain down.
        let mut p = pod("node-exporter");
        p.metadata.owner_references = Some(vec![owned_by("DaemonSet")]);
        assert!(skip_reason(&p).unwrap().contains("DaemonSet"));
    }

    #[test]
    fn a_replicaset_pod_is_not_skipped() {
        let mut p = pod("api-1");
        p.metadata.owner_references = Some(vec![owned_by("ReplicaSet")]);
        assert_eq!(skip_reason(&p), None);
    }

    #[test]
    fn a_static_pod_is_skipped() {
        // The API server cannot evict a mirror pod; the request fails
        // rather than being ignored, which reads as a broken drain.
        let mut p = pod("kube-apiserver-node-1");
        p.metadata.annotations = Some(
            [("kubernetes.io/config.mirror".to_string(), "abc".to_string())]
                .into_iter()
                .collect(),
        );
        assert!(skip_reason(&p).unwrap().contains("static"));
    }

    #[test]
    fn a_finished_pod_is_skipped() {
        for phase in ["Succeeded", "Failed"] {
            let mut p = pod("job-run");
            p.status = Some(k8s_openapi::api::core::v1::PodStatus {
                phase: Some(phase.into()),
                ..Default::default()
            });
            assert!(
                skip_reason(&p).is_some(),
                "a {phase} pod has nothing to evict"
            );
        }
    }

    #[test]
    fn a_running_pod_is_not_skipped() {
        let mut p = pod("api-1");
        p.status = Some(k8s_openapi::api::core::v1::PodStatus {
            phase: Some("Running".into()),
            ..Default::default()
        });
        assert_eq!(skip_reason(&p), None);
    }

    #[tokio::test]
    async fn scaling_below_zero_is_refused_before_it_leaves_the_machine() {
        let session = Session::default();
        let err = scale(
            &session,
            GvkRef {
                group: "apps".into(),
                version: "v1".into(),
                kind: "Deployment".into(),
            },
            Some("default".into()),
            "api",
            -1,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidEdit(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn every_action_needs_a_connection() {
        // Each of these would otherwise panic or hang rather than
        // reporting the obvious thing.
        let session = Session::default();
        let gvk = || GvkRef {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
        };

        assert!(matches!(
            scale(&session, gvk(), None, "api", 3).await,
            Err(AppError::NotConnected)
        ));
        assert!(matches!(
            rollout_restart(&session, gvk(), None, "api").await,
            Err(AppError::NotConnected)
        ));
        assert!(matches!(
            delete_object(&session, gvk(), None, "api").await,
            Err(AppError::NotConnected)
        ));
        assert!(matches!(
            set_node_schedulable(&session, "node-1", false).await,
            Err(AppError::NotConnected)
        ));
    }
}
