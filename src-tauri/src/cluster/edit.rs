//! Applying an edited object.
//!
//! The write half of the read path: the user edits the same YAML the
//! detail view rendered, and it goes back as a full replace — `kubectl
//! replace`, not `kubectl apply`. That choice buys optimistic
//! concurrency for free. The YAML carries the `resourceVersion` it was
//! loaded at, so an object someone else changed in the meantime is
//! rejected by the API server rather than silently overwritten.
//!
//! Everything checkable is checked before the request leaves the
//! machine. In particular the edit cannot retarget: changing the name in
//! the editor is a typo, not a request to write to a different object,
//! and treating it as the latter is how an editor becomes dangerous.

use kube::api::{DynamicObject, PostParams, ResourceExt};
use serde::{Deserialize, Serialize};

use crate::cluster::detail::to_yaml;
use crate::cluster::discovery::{api_for, resolve, GvkRef};
use crate::cluster::Session;
use crate::error::{AppError, Result};

/// The object the editor was opened on.
///
/// Sent back with the edit so the apply can verify that the YAML still
/// describes the same object, rather than trusting whatever identity the
/// text now claims.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// The object as the API server stored it, re-rendered. The editor
    /// swaps this in so the next save carries the new resourceVersion
    /// instead of conflicting against itself.
    pub yaml: String,
    pub resource_version: Option<String>,
}

/// Splits an `apiVersion` into its group and version.
///
/// Core resources write "v1" with no group; everything else writes
/// "group/version".
pub(crate) fn split_api_version(api_version: &str) -> Result<(String, String)> {
    match api_version.split_once('/') {
        Some((group, version)) if !group.is_empty() && !version.is_empty() => {
            Ok((group.to_string(), version.to_string()))
        }
        Some(_) => Err(AppError::InvalidEdit(format!(
            "apiVersion \"{api_version}\" is not a valid group/version"
        ))),
        None if api_version.is_empty() => Err(AppError::InvalidEdit(
            "the document has no apiVersion".into(),
        )),
        None => Ok((String::new(), api_version.to_string())),
    }
}

/// What the edited document says it is.
#[derive(Debug, PartialEq)]
pub(crate) struct Identity {
    api_version: String,
    kind: String,
    name: String,
    namespace: Option<String>,
    resource_version: Option<String>,
}

fn field<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(key)?;
    }
    cursor.as_str().filter(|s| !s.is_empty())
}

/// Reads the identity out of a parsed document.
pub(crate) fn identity_of(doc: &serde_json::Value) -> Result<Identity> {
    if !doc.is_object() {
        // A YAML list, a bare scalar, or an empty buffer. Each of these
        // parses fine and means nothing as an object to apply.
        return Err(AppError::InvalidEdit(
            "expected a single Kubernetes object".into(),
        ));
    }

    Ok(Identity {
        api_version: field(doc, &["apiVersion"]).unwrap_or_default().to_string(),
        kind: field(doc, &["kind"]).unwrap_or_default().to_string(),
        name: field(doc, &["metadata", "name"]).unwrap_or_default().to_string(),
        namespace: field(doc, &["metadata", "namespace"]).map(str::to_string),
        resource_version: field(doc, &["metadata", "resourceVersion"]).map(str::to_string),
    })
}

/// Rejects an edit that would write somewhere other than where it came
/// from, or that cannot be applied safely.
///
/// The identity fields are not editable in any useful sense: Kubernetes
/// has no rename, so changing one either fails or — worse, for a name
/// that happens to exist — overwrites a bystander.
pub(crate) fn check(target: &EditTarget, found: &Identity) -> Result<()> {
    let mismatch = |field: &str, want: &str, got: &str| {
        AppError::InvalidEdit(format!(
            "cannot change {field} here: this editor is open on {want}, but the document says {got}. \
             Kubernetes has no rename — create the new object instead."
        ))
    };

    if found.api_version != target.api_version {
        return Err(mismatch("apiVersion", &target.api_version, &found.api_version));
    }
    if found.kind != target.kind {
        return Err(mismatch("kind", &target.kind, &found.kind));
    }
    if found.name.is_empty() {
        return Err(AppError::InvalidEdit(
            "the document has no metadata.name".into(),
        ));
    }
    if found.name != target.name {
        return Err(mismatch("the name", &target.name, &found.name));
    }

    // An absent namespace on a namespaced object is not a mismatch: the
    // API server fills it in from the URL. It is only a mismatch when
    // the document names a *different* one.
    if let Some(found_ns) = &found.namespace {
        let target_ns = target.namespace.clone().unwrap_or_default();
        if *found_ns != target_ns {
            return Err(mismatch("the namespace", &target_ns, found_ns));
        }
    }

    if found.resource_version.is_none() {
        // Without it the replace is a blind overwrite that would discard
        // whatever changed while the editor was open.
        return Err(AppError::InvalidEdit(
            "metadata.resourceVersion is missing. It is what lets the cluster reject an edit \
             based on a stale copy — reload and try again."
                .into(),
        ));
    }

    Ok(())
}

/// True for the API server's "someone else changed this" rejection.
///
/// The status reply is the reliable signal; the string check is a
/// fallback for transports that lose it.
fn is_conflict(error: &kube::Error) -> bool {
    match error {
        kube::Error::Api(response) => response.code == 409,
        other => other.to_string().contains("409"),
    }
}

pub async fn apply_yaml(session: &Session, target: EditTarget, yaml: &str) -> Result<ApplyResult> {
    let doc: serde_json::Value = serde_yaml::from_str(yaml)
        .map_err(|e| AppError::InvalidEdit(format!("this is not valid YAML: {e}")))?;

    let found = identity_of(&doc)?;
    check(&target, &found)?;

    let (group, version) = split_api_version(&found.api_version)?;
    let gvk = GvkRef {
        group,
        version,
        kind: found.kind.clone(),
    };
    let (resource, caps) = resolve(session, &gvk).await?;
    if !caps.supports_operation("update") {
        return Err(AppError::InvalidEdit(format!(
            "this cluster does not accept updates to {}",
            found.kind
        )));
    }

    let object: DynamicObject = serde_json::from_value(doc)
        .map_err(|e| AppError::InvalidEdit(format!("this is not a Kubernetes object: {e}")))?;

    let client = session.client().await?;
    let api = api_for(client, &resource, &caps, target.namespace.as_deref());

    let mut applied = api
        .replace(&target.name, &PostParams::default(), &object)
        .await
        .map_err(|e| {
            if is_conflict(&e) {
                AppError::Conflict(format!(
                    "{} was changed in the cluster since it was loaded. Reload to see the current \
                     version, then re-apply your edit.",
                    target.name
                ))
            } else {
                AppError::Kube(e.to_string())
            }
        })?;

    applied.metadata.managed_fields = None;
    let resource_version = applied.resource_version();

    Ok(ApplyResult {
        yaml: to_yaml(&applied)?,
        resource_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target() -> EditTarget {
        EditTarget {
            api_version: "v1".into(),
            kind: "ConfigMap".into(),
            namespace: Some("default".into()),
            name: "settings".into(),
        }
    }

    fn document() -> serde_json::Value {
        json!({
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {
                "name": "settings",
                "namespace": "default",
                "resourceVersion": "12345"
            },
            "data": {"log_level": "debug"}
        })
    }

    #[test]
    fn splits_a_grouped_api_version() {
        assert_eq!(
            split_api_version("apps/v1").unwrap(),
            ("apps".to_string(), "v1".to_string())
        );
        assert_eq!(
            split_api_version("krypton.ai/v1alpha1").unwrap(),
            ("krypton.ai".to_string(), "v1alpha1".to_string())
        );
    }

    #[test]
    fn a_core_api_version_has_no_group() {
        assert_eq!(
            split_api_version("v1").unwrap(),
            (String::new(), "v1".to_string())
        );
    }

    #[test]
    fn a_malformed_api_version_is_rejected_not_guessed() {
        assert!(split_api_version("apps/").is_err());
        assert!(split_api_version("/v1").is_err());
        assert!(split_api_version("").is_err());
    }

    #[test]
    fn an_unchanged_document_passes() {
        check(&target(), &identity_of(&document()).unwrap()).expect("should apply cleanly");
    }

    #[test]
    fn a_renamed_document_is_refused() {
        // Kubernetes has no rename. Applying this would either 404 or,
        // if "other" exists, quietly overwrite an object the user never
        // opened — which is the reason this check exists at all.
        let mut doc = document();
        doc["metadata"]["name"] = json!("other");

        let err = check(&target(), &identity_of(&doc).unwrap()).expect_err("rename must fail");
        let message = err.to_string();
        assert!(message.contains("settings"), "{message}");
        assert!(message.contains("other"), "{message}");
        assert!(matches!(err, AppError::InvalidEdit(_)));
    }

    #[test]
    fn a_document_moved_to_another_namespace_is_refused() {
        let mut doc = document();
        doc["metadata"]["namespace"] = json!("kube-system");
        let err = check(&target(), &identity_of(&doc).unwrap()).expect_err("move must fail");
        assert!(err.to_string().contains("kube-system"), "{err}");
    }

    #[test]
    fn a_document_that_changes_kind_or_api_version_is_refused() {
        let mut doc = document();
        doc["kind"] = json!("Secret");
        assert!(check(&target(), &identity_of(&doc).unwrap()).is_err());

        let mut doc = document();
        doc["apiVersion"] = json!("v2");
        assert!(check(&target(), &identity_of(&doc).unwrap()).is_err());
    }

    #[test]
    fn omitting_the_namespace_is_allowed() {
        // The API server fills it in from the request URL, so a document
        // that simply does not mention its namespace is not a move.
        let mut doc = document();
        doc["metadata"].as_object_mut().unwrap().remove("namespace");
        check(&target(), &identity_of(&doc).unwrap()).expect("an absent namespace is fine");
    }

    #[test]
    fn a_document_without_a_resource_version_is_refused() {
        // Replacing without one is a blind overwrite: it would discard
        // whatever changed while the editor sat open.
        let mut doc = document();
        doc["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("resourceVersion");

        let err = check(&target(), &identity_of(&doc).unwrap()).expect_err("must be refused");
        assert!(err.to_string().contains("resourceVersion"), "{err}");
    }

    #[test]
    fn a_document_without_a_name_says_so_plainly() {
        let mut doc = document();
        doc["metadata"].as_object_mut().unwrap().remove("name");
        let err = check(&target(), &identity_of(&doc).unwrap()).expect_err("must be refused");
        assert!(err.to_string().contains("metadata.name"), "{err}");
    }

    #[test]
    fn a_yaml_list_is_not_a_single_object() {
        let doc: serde_json::Value = serde_yaml::from_str("- one\n- two\n").unwrap();
        assert!(identity_of(&doc).is_err());
    }

    #[test]
    fn an_empty_buffer_is_not_an_object() {
        // Select-all-delete-save is a plausible accident, and "null" is
        // what it parses to.
        let doc: serde_json::Value = serde_yaml::from_str("").unwrap();
        assert!(identity_of(&doc).is_err());
    }

    #[test]
    fn identity_reads_the_fields_it_needs() {
        let found = identity_of(&document()).unwrap();
        assert_eq!(found.name, "settings");
        assert_eq!(found.namespace.as_deref(), Some("default"));
        assert_eq!(found.resource_version.as_deref(), Some("12345"));
        assert_eq!(found.kind, "ConfigMap");
    }

    /// Round-trips a real edit: read a ConfigMap, change it, apply it,
    /// verify the change landed, then put it back.
    ///
    /// This is the one test that writes to the cluster. It creates its
    /// own ConfigMap in `default` and deletes it at the end, so it never
    /// touches anything the user cares about.
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn applies_an_edit_and_rejects_a_stale_one() {
        use k8s_openapi::api::core::v1::ConfigMap;
        use kube::api::{Api, DeleteParams};

        let session = crate::cluster::live::session().await;
        let client = session.client().await.unwrap();
        let maps: Api<ConfigMap> = Api::namespaced(client, "default");

        let name = "loupe-edit-test";
        // Left over from an interrupted run; ignore the "not found".
        let _ = maps.delete(name, &DeleteParams::default()).await;

        let created = maps
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "metadata": {"name": name, "namespace": "default"},
                    "data": {"level": "info"}
                }))
                .unwrap(),
            )
            .await
            .expect("create the fixture");

        let target = EditTarget {
            api_version: "v1".into(),
            kind: "ConfigMap".into(),
            namespace: Some("default".into()),
            name: name.into(),
        };

        let yaml = serde_yaml::to_string(&created).unwrap();
        let edited = yaml.replace("level: info", "level: debug");
        assert_ne!(edited, yaml, "the fixture edit should change something");

        let applied = apply_yaml(&session, target.clone(), &edited)
            .await
            .expect("apply the edit");
        assert!(applied.yaml.contains("level: debug"), "{}", applied.yaml);

        let stored = maps.get(name).await.expect("re-read");
        assert_eq!(
            stored.data.unwrap().get("level").map(String::as_str),
            Some("debug"),
            "the edit should have reached the cluster"
        );

        // The original YAML still carries the pre-edit resourceVersion,
        // so re-applying it is exactly the stale-write case.
        let err = apply_yaml(&session, target, &yaml)
            .await
            .expect_err("a stale resourceVersion must be rejected");
        assert!(
            matches!(err, AppError::Conflict(_)),
            "expected a conflict, got {err:?}"
        );

        maps.delete(name, &DeleteParams::default())
            .await
            .expect("clean up the fixture");
    }
}
