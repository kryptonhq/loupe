//! Generic resource browsing driven by API discovery.
//!
//! Loupe cannot compile in a type for every CRD an operator installs, so
//! for anything outside the handful of built-ins it asks the cluster
//! what exists and works with untyped objects. That is what makes a
//! freshly-installed CRD browsable without shipping a new build.
//!
//! The cost of going untyped is that no field is guaranteed. Everything
//! here reads defensively and degrades to "unknown" rather than failing
//! the listing, because one badly-shaped object should not blank a table.

use kube::api::{Api, DynamicObject, ListParams, ResourceExt};
use kube::core::{ApiResource, GroupVersionKind};
use kube::discovery::{ApiCapabilities, Scope};
use serde::{Deserialize, Serialize};

use crate::cluster::detail::{sorted_pairs, to_yaml, ConditionView};
use crate::cluster::{resources::age, Session};
use crate::error::{AppError, Result};

/// One resource type the cluster serves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResourceInfo {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    /// "v1" for the core group, "group/version" otherwise — what the
    /// object's own `apiVersion` field says.
    pub api_version: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    /// False for the Kubernetes APIs themselves. The browser leads with
    /// custom resources because the built-ins already have dedicated
    /// views, and an unfiltered list of ~70 kinds buries them.
    pub custom: bool,
}

/// Identifies a resource type across the IPC boundary.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GvkRef {
    #[serde(default)]
    pub group: String,
    pub version: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSummary {
    pub name: String,
    pub namespace: Option<String>,
    pub age: Option<String>,
    /// A one-word health read, when the object offers one. CRDs are
    /// under no obligation to, hence the Option.
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetail {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub age: Option<String>,
    pub status: Option<String>,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub conditions: Vec<ConditionView>,
    /// Whether the API server accepts updates for this type. A view-only
    /// resource should not offer an Edit button that always fails.
    pub editable: bool,
    pub yaml: String,
}

/// Groups whose contents ship with Kubernetes rather than with an
/// operator someone installed.
///
/// `*.k8s.io` covers most of them; the rest predate that convention and
/// have to be named. Anything else is treated as custom — which is the
/// safe direction to be wrong in, since a mislabelled built-in still
/// appears in the browser, just under the wrong heading.
const BUILTIN_GROUPS: [&str; 7] = [
    "",
    "apps",
    "batch",
    "policy",
    "autoscaling",
    "extensions",
    "apiextensions.k8s.io",
];

pub(crate) fn is_builtin(group: &str) -> bool {
    BUILTIN_GROUPS.contains(&group)
        || group.ends_with(".k8s.io")
        || group.ends_with(".kubernetes.io")
}

/// Resolves a kind to something we can build an `Api` from.
///
/// On a miss it rebuilds discovery once before giving up: a CRD applied
/// after connecting is absent from the cached surface, and "I just
/// installed it and Loupe cannot see it" would otherwise need a
/// reconnect to fix.
pub(crate) async fn resolve(
    session: &Session,
    gvk: &GvkRef,
) -> Result<(ApiResource, ApiCapabilities)> {
    let key = GroupVersionKind::gvk(&gvk.group, &gvk.version, &gvk.kind);

    if let Some(found) = session.discovery().await?.resolve_gvk(&key) {
        return Ok(found);
    }
    session
        .refresh_discovery()
        .await?
        .resolve_gvk(&key)
        .ok_or_else(|| {
            AppError::UnknownResource(format!("{} is not served by this cluster", describe(gvk)))
        })
}

fn describe(gvk: &GvkRef) -> String {
    if gvk.group.is_empty() {
        format!("{} ({})", gvk.kind, gvk.version)
    } else {
        format!("{} ({}/{})", gvk.kind, gvk.group, gvk.version)
    }
}

/// Builds an `Api` for a dynamic kind, respecting its scope.
///
/// Asking for a namespace on a cluster-scoped kind would produce a URL
/// the API server 404s on, so the resource's own scope wins over the
/// caller's request.
pub(crate) fn api_for(
    client: kube::Client,
    resource: &ApiResource,
    caps: &ApiCapabilities,
    namespace: Option<&str>,
) -> Api<DynamicObject> {
    match (caps.scope.clone(), namespace) {
        (Scope::Namespaced, Some(ns)) if !ns.is_empty() => {
            Api::namespaced_with(client, ns, resource)
        }
        _ => Api::all_with(client, resource),
    }
}

/// Every kind the cluster serves that can be listed, one row per kind.
///
/// Only the preferred version of each group is offered. A CRD served at
/// both v1alpha1 and v1 would otherwise appear twice, and the older row
/// is never the one anybody wants.
pub async fn list_api_resources(session: &Session) -> Result<Vec<ApiResourceInfo>> {
    let discovery = session.discovery().await?;

    let mut out: Vec<ApiResourceInfo> = discovery
        .groups()
        .flat_map(|group| {
            group
                .recommended_resources()
                .into_iter()
                .map(|(resource, caps)| (group.name().to_string(), resource, caps))
        })
        .filter(|(_, _, caps)| caps.supports_operation("list"))
        .map(|(group, resource, caps)| ApiResourceInfo {
            custom: !is_builtin(&group),
            namespaced: matches!(caps.scope, Scope::Namespaced),
            verbs: caps.operations,
            group: resource.group.clone(),
            version: resource.version.clone(),
            api_version: resource.api_version.clone(),
            kind: resource.kind.clone(),
            plural: resource.plural.clone(),
        })
        .collect();

    // Custom kinds first, then alphabetically — the browser exists for
    // the custom ones, and burying them under `apps` defeats it.
    out.sort_by(|a, b| {
        b.custom
            .cmp(&a.custom)
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.kind.cmp(&b.kind))
    });
    Ok(out)
}

/// A one-word health read for an object of unknown shape.
///
/// CRD authors settled on no single convention, so this tries the three
/// common spellings of "phase" before falling back to the Ready
/// condition, which is the one thing the API conventions do ask for.
pub(crate) fn summarise_status(data: &serde_json::Value) -> Option<String> {
    let status = data.get("status")?;

    for key in ["phase", "state", "health"] {
        if let Some(s) = status.get(key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }

    let ready = status
        .get("conditions")?
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(|t| t.as_str()) == Some("Ready"))?;

    match ready.get("status").and_then(|s| s.as_str()) {
        Some("True") => Some("Ready".into()),
        // The reason is the useful half; "NotReady" alone says less than
        // the object already told us by not being ready.
        Some(_) => Some(match ready.get("reason").and_then(|r| r.as_str()) {
            Some(reason) if !reason.is_empty() => format!("NotReady: {reason}"),
            _ => "NotReady".into(),
        }),
        None => None,
    }
}

/// Flattens `status.conditions` from an object of unknown shape.
pub(crate) fn conditions_from(data: &serde_json::Value) -> Vec<ConditionView> {
    let Some(list) = data
        .get("status")
        .and_then(|s| s.get("conditions"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    list.iter()
        .filter_map(|c| {
            let str_at = |key: &str| c.get(key).and_then(|v| v.as_str()).map(str::to_string);
            // A condition without a type is unidentifiable; rendering it
            // as an empty row helps nobody.
            Some(ConditionView {
                type_: str_at("type")?,
                status: str_at("status").unwrap_or_else(|| "Unknown".into()),
                reason: str_at("reason"),
                message: str_at("message"),
            })
        })
        .collect()
}

pub async fn list_objects(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
) -> Result<Vec<ObjectSummary>> {
    let client = session.client().await?;
    let (resource, caps) = resolve(session, &gvk).await?;
    let api = api_for(client, &resource, &caps, namespace.as_deref());

    let list = api.list(&ListParams::default()).await?;
    Ok(list
        .into_iter()
        .map(|obj| ObjectSummary {
            age: age(&obj),
            status: summarise_status(&obj.data),
            name: obj.name_any(),
            namespace: obj.namespace(),
        })
        .collect())
}

pub async fn get_object(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
    name: &str,
) -> Result<ObjectDetail> {
    let client = session.client().await?;
    let (resource, caps) = resolve(session, &gvk).await?;
    let api = api_for(client, &resource, &caps, namespace.as_deref());

    let mut obj = api.get(name).await?;
    obj.metadata.managed_fields = None;

    // A Secret's values are base64 in the API, which is an encoding and
    // not a protection: rendering the YAML as-is would put every
    // credential on screen. Redacted here rather than in a separate
    // Secret-only path, so there is no generic route that bypasses it.
    let redacted = crate::cluster::data::is_secret(&resource.api_version, &resource.kind);
    if redacted {
        crate::cluster::data::redact(&mut obj.data);
    }
    // A DynamicObject fetched through the typed path can come back with
    // no `types`, and YAML without apiVersion/kind is not re-appliable —
    // which matters because the editor round-trips exactly this text.
    obj.types = Some(kube::core::TypeMeta {
        api_version: resource.api_version.clone(),
        kind: resource.kind.clone(),
    });

    let yaml = to_yaml(&obj)?;

    Ok(ObjectDetail {
        api_version: resource.api_version.clone(),
        kind: resource.kind.clone(),
        age: age(&obj),
        status: summarise_status(&obj.data),
        labels: sorted_pairs(obj.labels()),
        annotations: sorted_pairs(obj.annotations()),
        conditions: conditions_from(&obj.data),
        // Never offer to apply text whose values have been replaced:
        // saving it would write the placeholder over the real secret.
        editable: caps.supports_operation("update") && !redacted,
        name: obj.name_any(),
        namespace: obj.namespace(),
        yaml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kubernetes_own_groups_are_not_custom() {
        assert!(is_builtin(""), "the core group is built in");
        assert!(is_builtin("apps"));
        assert!(is_builtin("networking.k8s.io"));
        assert!(is_builtin("apiextensions.k8s.io"));
    }

    #[test]
    fn operator_groups_are_custom() {
        assert!(!is_builtin("krypton.ai"));
        assert!(!is_builtin("monitoring.coreos.com"));
        assert!(!is_builtin("cert-manager.io"));
    }

    #[test]
    fn status_prefers_an_explicit_phase() {
        let obj = json!({"status": {"phase": "Running", "conditions": [
            {"type": "Ready", "status": "False"}
        ]}});
        assert_eq!(summarise_status(&obj).as_deref(), Some("Running"));
    }

    #[test]
    fn status_accepts_the_other_spellings_crds_use() {
        assert_eq!(
            summarise_status(&json!({"status": {"state": "Serving"}})).as_deref(),
            Some("Serving")
        );
        assert_eq!(
            summarise_status(&json!({"status": {"health": "Degraded"}})).as_deref(),
            Some("Degraded")
        );
    }

    #[test]
    fn status_falls_back_to_the_ready_condition() {
        let obj = json!({"status": {"conditions": [
            {"type": "Synced", "status": "True"},
            {"type": "Ready", "status": "True"}
        ]}});
        assert_eq!(summarise_status(&obj).as_deref(), Some("Ready"));
    }

    #[test]
    fn a_failing_ready_condition_carries_its_reason() {
        // "NotReady" alone repeats what the row already shows; the
        // reason is the part worth the column width.
        let obj = json!({"status": {"conditions": [
            {"type": "Ready", "status": "False", "reason": "ModelPullFailed"}
        ]}});
        assert_eq!(
            summarise_status(&obj).as_deref(),
            Some("NotReady: ModelPullFailed")
        );
    }

    #[test]
    fn an_object_with_no_status_reports_none_rather_than_unknown() {
        // A CRD is under no obligation to have a status, and inventing
        // "Unknown" for one would read as a problem where there is none.
        assert_eq!(summarise_status(&json!({"spec": {"replicas": 1}})), None);
        assert_eq!(summarise_status(&json!({"status": {}})), None);
        assert_eq!(summarise_status(&json!({"status": {"phase": ""}})), None);
    }

    #[test]
    fn status_survives_fields_of_the_wrong_type() {
        // Nothing stops a CRD from making `phase` an object. Reading it
        // must not panic or abort the whole listing.
        let obj = json!({"status": {"phase": {"nested": true}, "conditions": "not-a-list"}});
        assert_eq!(summarise_status(&obj), None);
        assert!(conditions_from(&obj).is_empty());
    }

    #[test]
    fn conditions_are_flattened_with_their_reasons() {
        let obj = json!({"status": {"conditions": [
            {"type": "Ready", "status": "False", "reason": "Pending", "message": "waiting"},
            {"type": "Synced", "status": "True"}
        ]}});
        let got = conditions_from(&obj);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].type_, "Ready");
        assert_eq!(got[0].reason.as_deref(), Some("Pending"));
        assert_eq!(got[0].message.as_deref(), Some("waiting"));
        assert_eq!(got[1].status, "True");
    }

    #[test]
    fn a_condition_that_omits_its_status_reads_as_unknown() {
        let obj = json!({"status": {"conditions": [{"type": "Degraded"}]}});
        assert_eq!(conditions_from(&obj)[0].status, "Unknown");
    }

    #[test]
    fn a_condition_without_a_type_is_dropped() {
        let obj = json!({"status": {"conditions": [{"status": "True"}]}});
        assert!(conditions_from(&obj).is_empty());
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn discovers_and_browses_a_custom_resource() {
        let session = crate::cluster::live::session().await;

        let resources = list_api_resources(&session).await.expect("discover");
        println!("{} listable kind(s)", resources.len());
        assert!(
            resources
                .iter()
                .any(|r| r.kind == "Pod" && r.group.is_empty()),
            "core v1 Pod should always be discovered"
        );

        // Custom kinds sort first; if any exist, the head of the list is
        // one of them.
        if resources.iter().any(|r| r.custom) {
            assert!(resources[0].custom, "custom kinds should lead the list");
        }

        // Walk custom kinds until one has objects. Stopping at the first
        // custom kind would usually find an empty CRD and leave the half
        // of this test that matters — reading an object — unrun.
        let mut found = None;
        for candidate in resources.iter().filter(|r| r.custom) {
            let gvk = GvkRef {
                group: candidate.group.clone(),
                version: candidate.version.clone(),
                kind: candidate.kind.clone(),
            };
            let objects = list_objects(&session, gvk.clone(), None)
                .await
                .unwrap_or_else(|e| panic!("list {}: {e}", candidate.kind));
            println!(
                "  {}/{}: {} object(s)",
                candidate.group,
                candidate.kind,
                objects.len()
            );
            if let Some(first) = objects.into_iter().next() {
                found = Some((candidate, gvk, first));
                break;
            }
        }

        let Some((target, gvk, first)) = found else {
            println!("no custom resources exist on this cluster; skipping the read half");
            return;
        };
        println!("reading {}/{} {}", target.group, target.kind, first.name);

        let detail = get_object(&session, gvk, first.namespace.clone(), &first.name)
            .await
            .expect("get custom object");

        assert_eq!(detail.name, first.name);
        assert_eq!(detail.kind, target.kind);
        assert_eq!(
            detail.status, first.status,
            "the list and the detail must agree about status"
        );
        // The YAML has to carry its own identity or the editor cannot
        // apply what it round-trips.
        assert!(detail.yaml.contains(&format!("kind: {}", target.kind)));
        assert!(detail.yaml.contains("apiVersion:"));
        assert!(!detail.yaml.contains("managedFields"));
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn an_unserved_kind_is_named_in_the_error() {
        let session = crate::cluster::live::session().await;
        let err = list_objects(
            &session,
            GvkRef {
                group: "example.invalid".into(),
                version: "v1".into(),
                kind: "Nonexistent".into(),
            },
            None,
        )
        .await
        .expect_err("a kind the cluster does not serve should fail");

        let message = err.to_string();
        assert!(
            message.contains("Nonexistent"),
            "unhelpful error: {message}"
        );
    }
}
