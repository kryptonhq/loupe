//! How one object connects to the others around it.
//!
//! Every object used to be an island. Opening a pod showed its
//! containers, events and manifest — but not the ReplicaSet that created
//! it, the Deployment above that, the Service that selects it, the
//! Ingress that routes to that Service, the ConfigMaps it mounts, or the
//! ServiceAccount it runs as. All of that was already in the objects
//! Loupe fetched, in `ownerReferences`, in label selectors and in the
//! pod spec. It was read and thrown away.
//!
//! This is the clearest thing a graphical client does better than a
//! terminal. Tracing "this ingress → this service → these pods → this
//! config" is several `kubectl get -o yaml` calls and some manual
//! selector matching; here it is one click each.
//!
//! Two rules run through all of it. Nothing here fails the view: a
//! reference the user cannot read is *shown, marked unreadable*, because
//! "you do not have permission to see what owns this" is a useful answer
//! and an empty section is not. And nothing is invented: every edge
//! comes from a field in the object, never from a name that looks about
//! right.

use std::collections::BTreeMap;

use kube::api::{Api, DynamicObject, ListParams, ResourceExt};
use serde::Serialize;
use serde_json::Value;

use crate::cluster::discovery::{api_for, resolve, GvkRef};
use crate::cluster::Session;
use crate::error::Result;

/// Why two objects are related.
///
/// Serialised as the section heading the UI groups by, so the wording is
/// part of the contract rather than incidental.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    /// This object's `ownerReferences`, walked to the root.
    OwnedBy,
    /// Objects whose owner is this one.
    Owns,
    /// This object's selector matches them.
    Selects,
    /// Their selector matches this object's labels.
    SelectedBy,
    /// Named in this object's spec — a ConfigMap, Secret, PVC or
    /// ServiceAccount it mounts or runs as.
    Uses,
    /// An Ingress rule points at this Service, or this Ingress points at
    /// them.
    Routes,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedObject {
    pub relation: Relation,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    /// False when the object is referenced but could not be read —
    /// deleted, or denied by RBAC. Shown rather than dropped: a dangling
    /// owner reference is worth seeing.
    pub reachable: bool,
    /// Extra wording for the row, such as which key is mounted.
    pub detail: Option<String>,
}

impl RelatedObject {
    fn new(
        relation: Relation,
        api_version: &str,
        kind: &str,
        name: impl Into<String>,
        namespace: Option<String>,
    ) -> Self {
        let (group, version) = split_api_version(api_version);
        RelatedObject {
            relation,
            group,
            version,
            kind: kind.to_string(),
            name: name.into(),
            namespace,
            reachable: true,
            detail: None,
        }
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Splits `apps/v1` into ("apps", "v1"), and bare `v1` into ("", "v1").
pub(crate) fn split_api_version(api_version: &str) -> (String, String) {
    match api_version.split_once('/') {
        Some((group, version)) => (group.to_string(), version.to_string()),
        None => (String::new(), api_version.to_string()),
    }
}

/// How far up an owner chain to walk.
///
/// Pod → ReplicaSet → Deployment is three, and nothing standard goes
/// deeper. The bound exists because an `ownerReferences` cycle is
/// possible in a corrupted cluster and would otherwise hang the view.
const MAX_OWNER_DEPTH: usize = 6;

/// Labels as a plain map, or empty when the object has none.
fn labels_of(object: &Value) -> BTreeMap<String, String> {
    string_map(object.pointer("/metadata/labels"))
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let Some(Value::Object(map)) = value else {
        return BTreeMap::new();
    };
    map.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}

/// Whether a label selector matches a set of labels.
///
/// Equality-based only, which is what `spec.selector` on a Service and
/// `matchLabels` on a workload use. `matchExpressions` is deliberately
/// not implemented rather than approximated: a selector that is *nearly*
/// evaluated would draw edges that do not exist, and a missing edge is a
/// far better failure than a wrong one.
pub(crate) fn selector_matches(
    selector: &BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> bool {
    // An empty selector matches nothing here. Kubernetes reads it as
    // "everything" in some contexts, but a Service with no selector is
    // one backed by manual Endpoints, and claiming it selects every pod
    // in the namespace would be actively misleading.
    if selector.is_empty() {
        return false;
    }
    selector
        .iter()
        .all(|(k, v)| labels.get(k).map(|l| l == v).unwrap_or(false))
}

/// The selector a workload or Service uses, whichever shape it is in.
pub(crate) fn selector_of(object: &Value) -> BTreeMap<String, String> {
    // Workloads nest it under matchLabels; a Service puts it directly
    // under spec.selector.
    let nested = object.pointer("/spec/selector/matchLabels");
    if nested.is_some() {
        return string_map(nested);
    }
    string_map(object.pointer("/spec/selector"))
}

/// Everything a pod spec names: config, secrets, claims, and the
/// identity it runs as.
///
/// Pure, and the most detailed part of this module, so it is the part
/// worth testing directly.
pub(crate) fn pod_spec_references(spec: &Value, namespace: Option<&str>) -> Vec<RelatedObject> {
    let mut out = Vec::new();
    let ns = namespace.map(|s| s.to_string());

    let mut push = |kind: &str, name: &str, detail: &str| {
        if name.is_empty() {
            return;
        }
        out.push(
            RelatedObject::new(Relation::Uses, "v1", kind, name, ns.clone())
                .with_detail(detail.to_string()),
        );
    };

    if let Some(account) = spec.get("serviceAccountName").and_then(|v| v.as_str()) {
        push("ServiceAccount", account, "runs as");
    }

    for volume in spec
        .get("volumes")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![])
    {
        let via = volume
            .get("name")
            .and_then(|v| v.as_str())
            .map(|n| format!("volume {n}"))
            .unwrap_or_else(|| "volume".to_string());

        if let Some(name) = volume.pointer("/configMap/name").and_then(|v| v.as_str()) {
            push("ConfigMap", name, &via);
        }
        if let Some(name) = volume
            .pointer("/secret/secretName")
            .and_then(|v| v.as_str())
        {
            push("Secret", name, &via);
        }
        if let Some(name) = volume
            .pointer("/persistentVolumeClaim/claimName")
            .and_then(|v| v.as_str())
        {
            push("PersistentVolumeClaim", name, &via);
        }
        // A projected volume can carry several of each.
        for source in volume
            .pointer("/projected/sources")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
        {
            if let Some(name) = source.pointer("/configMap/name").and_then(|v| v.as_str()) {
                push("ConfigMap", name, &via);
            }
            if let Some(name) = source.pointer("/secret/name").and_then(|v| v.as_str()) {
                push("Secret", name, &via);
            }
        }
    }

    // Init and regular containers both pull environment from objects.
    for key in ["initContainers", "containers"] {
        for container in spec.get(key).and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            let owner = container
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("container");

            for from in container
                .get("envFrom")
                .and_then(|v| v.as_array())
                .unwrap_or(&vec![])
            {
                if let Some(name) = from.pointer("/configMapRef/name").and_then(|v| v.as_str()) {
                    push("ConfigMap", name, &format!("envFrom in {owner}"));
                }
                if let Some(name) = from.pointer("/secretRef/name").and_then(|v| v.as_str()) {
                    push("Secret", name, &format!("envFrom in {owner}"));
                }
            }

            for env in container
                .get("env")
                .and_then(|v| v.as_array())
                .unwrap_or(&vec![])
            {
                let var = env.get("name").and_then(|v| v.as_str()).unwrap_or("env");
                if let Some(name) = env
                    .pointer("/valueFrom/configMapKeyRef/name")
                    .and_then(|v| v.as_str())
                {
                    push("ConfigMap", name, &format!("${var} in {owner}"));
                }
                if let Some(name) = env
                    .pointer("/valueFrom/secretKeyRef/name")
                    .and_then(|v| v.as_str())
                {
                    push("Secret", name, &format!("${var} in {owner}"));
                }
            }
        }
    }

    dedupe(out)
}

/// The Services an Ingress routes to.
pub(crate) fn ingress_backends(object: &Value, namespace: Option<&str>) -> Vec<RelatedObject> {
    let mut out = Vec::new();
    let ns = namespace.map(|s| s.to_string());

    let mut push = |name: &str, detail: String| {
        if !name.is_empty() {
            out.push(
                RelatedObject::new(Relation::Routes, "v1", "Service", name, ns.clone())
                    .with_detail(detail),
            );
        }
    };

    if let Some(name) = object
        .pointer("/spec/defaultBackend/service/name")
        .and_then(|v| v.as_str())
    {
        push(name, "default backend".to_string());
    }

    for rule in object
        .pointer("/spec/rules")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![])
    {
        let host = rule.get("host").and_then(|v| v.as_str()).unwrap_or("*");
        for path in rule
            .pointer("/http/paths")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
        {
            if let Some(name) = path
                .pointer("/backend/service/name")
                .and_then(|v| v.as_str())
            {
                let route = path.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                push(name, format!("{host}{route}"));
            }
        }
    }

    dedupe(out)
}

/// Drops repeats, keeping the first mention of each object.
///
/// The same ConfigMap mounted as a volume and read through `envFrom` is
/// one object, and listing it twice implies two.
fn dedupe(mut objects: Vec<RelatedObject>) -> Vec<RelatedObject> {
    let mut seen = std::collections::HashSet::new();
    objects.retain(|o| {
        seen.insert((
            o.relation,
            o.kind.clone(),
            o.name.clone(),
            o.namespace.clone(),
        ))
    });
    objects
}

/// The owner references on an object, as related rows.
pub(crate) fn owner_references(object: &Value, namespace: Option<&str>) -> Vec<RelatedObject> {
    object
        .pointer("/metadata/ownerReferences")
        .and_then(|v| v.as_array())
        .map(|refs| {
            refs.iter()
                .filter_map(|owner| {
                    let kind = owner.get("kind")?.as_str()?;
                    let name = owner.get("name")?.as_str()?;
                    let api_version = owner.get("apiVersion")?.as_str()?;
                    Some(RelatedObject::new(
                        Relation::OwnedBy,
                        api_version,
                        kind,
                        name,
                        namespace.map(|s| s.to_string()),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Kinds worth looking in for children of a given kind.
///
/// Deliberately a short table rather than "list every kind and check":
/// the latter is dozens of list calls against the API server to answer
/// one page, which is exactly the kind of cost this app should not be
/// imposing.
fn child_kinds(kind: &str) -> &'static [(&'static str, &'static str, &'static str)] {
    match kind {
        "Deployment" => &[("apps", "v1", "ReplicaSet")],
        "ReplicaSet" | "StatefulSet" | "DaemonSet" | "Job" => &[("", "v1", "Pod")],
        "CronJob" => &[("batch", "v1", "Job")],
        _ => &[],
    }
}

/// Everything related to one object.
pub async fn related(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
    name: &str,
) -> Result<Vec<RelatedObject>> {
    let (resource, caps) = resolve(session, &gvk).await?;
    let api = api_for(
        session.client().await?,
        &resource,
        &caps,
        namespace.as_deref(),
    );
    let object = api.get(name).await?;
    let json = serde_json::to_value(&object).unwrap_or(Value::Null);
    let ns = object.namespace();

    let mut out = Vec::new();

    out.extend(owner_chain(session, &json, ns.as_deref()).await);
    out.extend(children(session, &object, &gvk, ns.as_deref()).await);
    out.extend(selector_edges(session, &json, &gvk, ns.as_deref()).await);

    if gvk.kind == "Pod" {
        if let Some(spec) = json.get("spec") {
            out.extend(pod_spec_references(spec, ns.as_deref()));
        }
    }
    if gvk.kind == "Ingress" {
        out.extend(ingress_backends(&json, ns.as_deref()));
    }
    if gvk.kind == "Service" {
        out.extend(ingresses_for_service(session, name, ns.as_deref()).await);
    }

    Ok(dedupe(out))
}

/// Walks `ownerReferences` to the root, marking anything unreadable.
async fn owner_chain(
    session: &Session,
    object: &Value,
    namespace: Option<&str>,
) -> Vec<RelatedObject> {
    let mut out = Vec::new();
    let mut current = object.clone();

    for _ in 0..MAX_OWNER_DEPTH {
        let owners = owner_references(&current, namespace);
        let Some(mut owner) = owners.into_iter().next() else {
            break;
        };

        let gvk = GvkRef {
            group: owner.group.clone(),
            version: owner.version.clone(),
            kind: owner.kind.clone(),
        };

        match fetch(session, &gvk, namespace, &owner.name).await {
            Some(parent) => {
                out.push(owner);
                current = parent;
            }
            None => {
                // A dangling reference is worth showing: it is usually
                // the explanation for whatever the user is looking at.
                owner.reachable = false;
                out.push(owner);
                break;
            }
        }
    }
    out
}

/// Objects whose owner is this one.
async fn children(
    session: &Session,
    object: &DynamicObject,
    gvk: &GvkRef,
    namespace: Option<&str>,
) -> Vec<RelatedObject> {
    let Some(uid) = object.uid() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (group, version, kind) in child_kinds(&gvk.kind) {
        let child = GvkRef {
            group: group.to_string(),
            version: version.to_string(),
            kind: kind.to_string(),
        };
        for item in list(session, &child, namespace).await {
            let owned = item
                .metadata
                .owner_references
                .as_ref()
                .map(|refs| refs.iter().any(|r| r.uid == uid))
                .unwrap_or(false);
            if !owned {
                continue;
            }
            out.push(RelatedObject::new(
                Relation::Owns,
                &api_version_of(&child),
                kind,
                item.name_any(),
                item.namespace(),
            ));
        }
    }
    out
}

/// Selector-based edges, in whichever direction applies.
async fn selector_edges(
    session: &Session,
    object: &Value,
    gvk: &GvkRef,
    namespace: Option<&str>,
) -> Vec<RelatedObject> {
    let mut out = Vec::new();

    // A pod is selected *by* Services and workloads.
    if gvk.kind == "Pod" {
        let labels = labels_of(object);
        if labels.is_empty() {
            return out;
        }
        for (group, version, kind) in [
            ("", "v1", "Service"),
            ("apps", "v1", "Deployment"),
            ("apps", "v1", "StatefulSet"),
            ("apps", "v1", "DaemonSet"),
        ] {
            let other = GvkRef {
                group: group.to_string(),
                version: version.to_string(),
                kind: kind.to_string(),
            };
            for item in list(session, &other, namespace).await {
                let json = serde_json::to_value(&item).unwrap_or(Value::Null);
                if selector_matches(&selector_of(&json), &labels) {
                    out.push(RelatedObject::new(
                        Relation::SelectedBy,
                        &api_version_of(&other),
                        kind,
                        item.name_any(),
                        item.namespace(),
                    ));
                }
            }
        }
        return out;
    }

    // A Service or workload *selects* pods.
    let selector = selector_of(object);
    if selector.is_empty() {
        return out;
    }
    let pod = GvkRef {
        group: String::new(),
        version: "v1".into(),
        kind: "Pod".into(),
    };
    for item in list(session, &pod, namespace).await {
        let json = serde_json::to_value(&item).unwrap_or(Value::Null);
        if selector_matches(&selector, &labels_of(&json)) {
            out.push(RelatedObject::new(
                Relation::Selects,
                "v1",
                "Pod",
                item.name_any(),
                item.namespace(),
            ));
        }
    }
    out
}

/// Ingresses whose rules point at a Service.
async fn ingresses_for_service(
    session: &Session,
    service: &str,
    namespace: Option<&str>,
) -> Vec<RelatedObject> {
    let gvk = GvkRef {
        group: "networking.k8s.io".into(),
        version: "v1".into(),
        kind: "Ingress".into(),
    };

    let mut out = Vec::new();
    for item in list(session, &gvk, namespace).await {
        let json = serde_json::to_value(&item).unwrap_or(Value::Null);
        let backends = ingress_backends(&json, namespace);
        if let Some(hit) = backends.iter().find(|b| b.name == service) {
            let mut row = RelatedObject::new(
                Relation::Routes,
                "networking.k8s.io/v1",
                "Ingress",
                item.name_any(),
                item.namespace(),
            );
            row.detail = hit.detail.clone();
            out.push(row);
        }
    }
    out
}

fn api_version_of(gvk: &GvkRef) -> String {
    if gvk.group.is_empty() {
        gvk.version.clone()
    } else {
        format!("{}/{}", gvk.group, gvk.version)
    }
}

/// Fetches one object, or None if it cannot be read.
///
/// A failure here is not an error for the caller: "cannot read what owns
/// this" is a row in the list, not a reason to blank the section.
async fn fetch(
    session: &Session,
    gvk: &GvkRef,
    namespace: Option<&str>,
    name: &str,
) -> Option<Value> {
    let (resource, caps) = resolve(session, gvk).await.ok()?;
    let api = api_for(session.client().await.ok()?, &resource, &caps, namespace);
    let object = api.get(name).await.ok()?;
    serde_json::to_value(&object).ok()
}

/// Lists a kind, treating any failure as "nothing here".
///
/// The same reasoning as `fetch`: a section the user cannot read should
/// be empty, not fatal to the whole page.
async fn list(session: &Session, gvk: &GvkRef, namespace: Option<&str>) -> Vec<DynamicObject> {
    let Ok((resource, caps)) = resolve(session, gvk).await else {
        return Vec::new();
    };
    let Ok(client) = session.client().await else {
        return Vec::new();
    };
    let api: Api<DynamicObject> = api_for(client, &resource, &caps, namespace);
    api.list(&ListParams::default())
        .await
        .map(|l| l.items)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn an_api_version_splits_into_group_and_version() {
        assert_eq!(split_api_version("apps/v1"), ("apps".into(), "v1".into()));
        // Core group objects say just "v1"; there is no group to find.
        assert_eq!(split_api_version("v1"), ("".into(), "v1".into()));
    }

    #[test]
    fn a_selector_matches_when_every_label_matches() {
        let selector = map(&[("app", "api")]);
        assert!(selector_matches(
            &selector,
            &map(&[("app", "api"), ("tier", "web")])
        ));
    }

    #[test]
    fn a_selector_needs_all_of_its_labels() {
        // Kubernetes selectors are AND, and getting this wrong would
        // draw an edge between a Service and pods it does not route to.
        let selector = map(&[("app", "api"), ("tier", "web")]);
        assert!(!selector_matches(&selector, &map(&[("app", "api")])));
    }

    #[test]
    fn a_selector_does_not_match_a_different_value() {
        let selector = map(&[("app", "api")]);
        assert!(!selector_matches(&selector, &map(&[("app", "worker")])));
    }

    #[test]
    fn an_empty_selector_matches_nothing() {
        // A Service with no selector is backed by manual Endpoints.
        // Claiming it selects every pod in the namespace would be worse
        // than saying nothing.
        assert!(!selector_matches(&map(&[]), &map(&[("app", "api")])));
    }

    #[test]
    fn a_workload_selector_is_read_from_match_labels() {
        let deployment = json!({ "spec": { "selector": { "matchLabels": { "app": "api" } } } });
        assert_eq!(selector_of(&deployment), map(&[("app", "api")]));
    }

    #[test]
    fn a_service_selector_is_read_from_spec_selector() {
        let service = json!({ "spec": { "selector": { "app": "api" } } });
        assert_eq!(selector_of(&service), map(&[("app", "api")]));
    }

    #[test]
    fn match_expressions_are_left_alone_rather_than_approximated() {
        // A selector that is nearly evaluated draws edges that do not
        // exist. A missing edge is a much better failure than a wrong one.
        let deployment = json!({
            "spec": { "selector": { "matchExpressions": [
                { "key": "app", "operator": "In", "values": ["api"] }
            ]}}
        });
        assert!(selector_of(&deployment).is_empty());
    }

    #[test]
    fn owner_references_become_rows() {
        let pod = json!({
            "metadata": { "ownerReferences": [
                { "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "api-7d9", "uid": "abc" }
            ]}
        });
        let owners = owner_references(&pod, Some("payments"));

        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].kind, "ReplicaSet");
        assert_eq!(owners[0].name, "api-7d9");
        assert_eq!(owners[0].group, "apps");
        assert_eq!(owners[0].namespace.as_deref(), Some("payments"));
    }

    #[test]
    fn an_object_with_no_owner_has_no_owner_rows() {
        assert!(owner_references(&json!({ "metadata": {} }), None).is_empty());
    }

    #[test]
    fn a_malformed_owner_reference_is_skipped_rather_than_fatal() {
        // Untyped data from a cluster is not guaranteed to be well
        // formed, and one bad reference must not blank the section.
        let pod = json!({
            "metadata": { "ownerReferences": [
                { "kind": "ReplicaSet" },
                { "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "good" }
            ]}
        });
        let owners = owner_references(&pod, None);
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].name, "good");
    }

    #[test]
    fn a_pod_spec_names_what_it_mounts_and_runs_as() {
        let spec = json!({
            "serviceAccountName": "api",
            "volumes": [
                { "name": "config", "configMap": { "name": "api-config" } },
                { "name": "tls", "secret": { "secretName": "api-tls" } },
                { "name": "data", "persistentVolumeClaim": { "claimName": "api-data" } }
            ],
            "containers": [{
                "name": "api",
                "envFrom": [{ "configMapRef": { "name": "shared-env" } }],
                "env": [{
                    "name": "DB_PASSWORD",
                    "valueFrom": { "secretKeyRef": { "name": "db-creds", "key": "password" } }
                }]
            }]
        });

        let refs = pod_spec_references(&spec, Some("payments"));
        let names: Vec<&str> = refs.iter().map(|r| r.name.as_str()).collect();

        assert!(names.contains(&"api"), "the ServiceAccount: {names:?}");
        assert!(names.contains(&"api-config"));
        assert!(names.contains(&"api-tls"));
        assert!(names.contains(&"api-data"));
        assert!(names.contains(&"shared-env"));
        assert!(names.contains(&"db-creds"));
        assert!(refs
            .iter()
            .all(|r| r.namespace.as_deref() == Some("payments")));
    }

    #[test]
    fn a_pod_spec_reference_says_how_it_is_used() {
        // "api-config" alone does not tell you where to look; "volume
        // config" or "$DB_PASSWORD in api" does.
        let spec = json!({
            "containers": [{
                "name": "api",
                "env": [{
                    "name": "DB_PASSWORD",
                    "valueFrom": { "secretKeyRef": { "name": "db-creds" } }
                }]
            }]
        });
        let refs = pod_spec_references(&spec, None);
        assert_eq!(refs[0].detail.as_deref(), Some("$DB_PASSWORD in api"));
    }

    #[test]
    fn init_containers_are_read_too() {
        // A ConfigMap only an init container reads is exactly the one
        // people forget about when a pod will not start.
        let spec = json!({
            "initContainers": [{
                "name": "migrate",
                "envFrom": [{ "secretRef": { "name": "migrate-creds" } }]
            }],
            "containers": []
        });
        let refs = pod_spec_references(&spec, None);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "migrate-creds");
    }

    #[test]
    fn projected_volume_sources_are_read() {
        let spec = json!({
            "volumes": [{
                "name": "combined",
                "projected": { "sources": [
                    { "configMap": { "name": "a" } },
                    { "secret": { "name": "b" } }
                ]}
            }]
        });
        let names: Vec<String> = pod_spec_references(&spec, None)
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, ["a", "b"]);
    }

    #[test]
    fn the_same_object_referenced_twice_is_listed_once() {
        // A ConfigMap mounted as a volume and read through envFrom is
        // one object; listing it twice implies two.
        let spec = json!({
            "volumes": [{ "name": "c", "configMap": { "name": "shared" } }],
            "containers": [{
                "name": "api",
                "envFrom": [{ "configMapRef": { "name": "shared" } }]
            }]
        });
        let refs = pod_spec_references(&spec, None);
        assert_eq!(refs.len(), 1);
    }

    #[test]
    fn an_empty_pod_spec_references_nothing() {
        assert!(pod_spec_references(&json!({}), None).is_empty());
    }

    #[test]
    fn an_ingress_names_the_services_it_routes_to() {
        let ingress = json!({
            "spec": {
                "defaultBackend": { "service": { "name": "fallback" } },
                "rules": [{
                    "host": "api.example.com",
                    "http": { "paths": [
                        { "path": "/v1", "backend": { "service": { "name": "api-v1" } } },
                        { "path": "/v2", "backend": { "service": { "name": "api-v2" } } }
                    ]}
                }]
            }
        });

        let backends = ingress_backends(&ingress, Some("payments"));
        let names: Vec<&str> = backends.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["fallback", "api-v1", "api-v2"]);
    }

    #[test]
    fn an_ingress_backend_says_which_route_reaches_it() {
        let ingress = json!({
            "spec": { "rules": [{
                "host": "api.example.com",
                "http": { "paths": [
                    { "path": "/v1", "backend": { "service": { "name": "api" } } }
                ]}
            }]}
        });
        let backends = ingress_backends(&ingress, None);
        assert_eq!(backends[0].detail.as_deref(), Some("api.example.com/v1"));
    }

    #[test]
    fn an_ingress_with_no_rules_routes_nowhere() {
        assert!(ingress_backends(&json!({ "spec": {} }), None).is_empty());
    }

    #[test]
    fn only_the_kinds_worth_listing_are_searched_for_children() {
        // Listing every kind to find children would be dozens of calls
        // against the API server to render one page.
        assert_eq!(child_kinds("Deployment").len(), 1);
        assert_eq!(child_kinds("Deployment")[0].2, "ReplicaSet");
        assert_eq!(child_kinds("ReplicaSet")[0].2, "Pod");
        assert_eq!(child_kinds("CronJob")[0].2, "Job");
        assert!(child_kinds("ConfigMap").is_empty());
    }
}
