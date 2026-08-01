//! ConfigMap and Secret contents.
//!
//! Both hold a map of keys to values, and both are read constantly —
//! "what is actually in that config" is most of why anyone opens one.
//!
//! Secrets need care that ConfigMaps do not. Their values are base64 in
//! the API, which is an encoding and not a protection: anything that
//! shows the YAML has shown the secret. So a Secret's values never leave
//! the Rust side unless asked for by name, and the YAML the detail view
//! renders has them redacted. That keeps a screen-share, a screenshot,
//! or a glance over a shoulder from leaking credentials that the user
//! only meant to check the *shape* of.

use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use kube::api::Api;
use serde::Serialize;

use crate::cluster::Session;
use crate::error::Result;

/// What a key holds, without necessarily holding it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataKey {
    pub key: String,
    /// Size of the decoded value, so a key can be described without
    /// being shown.
    pub bytes: usize,
    /// The value, when it is safe to send: always for a ConfigMap, only
    /// on explicit request for a Secret.
    pub value: Option<String>,
    /// True when the value is not valid UTF-8 — a keystore, a TLS key in
    /// DER form. There is nothing useful to render, and trying produces
    /// a screen of replacement characters.
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceData {
    pub keys: Vec<DataKey>,
    /// A Secret's type — `kubernetes.io/tls`, `Opaque`, and so on. None
    /// for a ConfigMap.
    pub type_: Option<String>,
    /// True when values are withheld until asked for.
    pub redacted: bool,
}

/// The placeholder shown in place of a Secret's value.
///
/// Fixed-width rather than proportional to the real value: even a length
/// leaks something about a password.
const REDACTED: &str = "«redacted by Loupe — reveal in the Data tab»";

fn describe(key: String, raw: &[u8], reveal: bool) -> DataKey {
    let text = std::str::from_utf8(raw).ok();
    DataKey {
        key,
        bytes: raw.len(),
        binary: text.is_none(),
        value: match (reveal, text) {
            (true, Some(t)) => Some(t.to_string()),
            _ => None,
        },
    }
}

pub async fn get_config_map_data(
    session: &Session,
    namespace: &str,
    name: &str,
) -> Result<ResourceData> {
    let client = session.client().await?;
    let api: Api<ConfigMap> = Api::namespaced(client, namespace);
    let cm = api.get(name).await?;

    let mut keys: Vec<DataKey> = cm
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| describe(k, v.as_bytes(), true))
        .collect();

    // binaryData is a separate map for values that are not UTF-8. They
    // are listed so the key is not invisible, but there is nothing to
    // render for them.
    keys.extend(
        cm.binary_data
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| DataKey {
                key: k,
                bytes: v.0.len(),
                value: None,
                binary: true,
            }),
    );

    keys.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(ResourceData {
        keys,
        type_: None,
        redacted: false,
    })
}

/// A Secret's keys, with values withheld unless `reveal` names them.
///
/// `reveal` is a list rather than a flag so the UI can show one value
/// without putting every credential in the object on screen at once.
pub async fn get_secret_data(
    session: &Session,
    namespace: &str,
    name: &str,
    reveal: Vec<String>,
) -> Result<ResourceData> {
    let client = session.client().await?;
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let secret = api.get(name).await?;

    let mut keys: Vec<DataKey> = secret
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| {
            let show = reveal.contains(&k);
            describe(k, &v.0, show)
        })
        .collect();

    keys.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(ResourceData {
        keys,
        type_: secret.type_,
        // The tab always says values are held back, even when one has
        // been revealed — the state the user should assume is the
        // guarded one.
        redacted: true,
    })
}

/// Replaces every value in an object's `data`/`stringData` maps.
///
/// Applied to the untyped object the detail view already fetched, so a
/// Secret's YAML tab costs no extra request — and so there is exactly
/// one path that renders a Secret, rather than a safe one and a generic
/// one that still prints the lot.
///
/// A redacted object must never be editable. Applying this text back
/// would write the placeholder over every value in the Secret, which is
/// a far worse outcome than not being able to edit it here.
pub(crate) fn redact(object: &mut serde_json::Value) {
    // `stringData` is write-only and should not come back from the API,
    // but redacting it costs nothing and assuming it cannot appear costs
    // a leak.
    for field in ["data", "stringData"] {
        let Some(serde_json::Value::Object(map)) = object.get_mut(field) else {
            continue;
        };
        for value in map.values_mut() {
            *value = serde_json::Value::String(REDACTED.to_string());
        }
    }
}

/// Whether a kind's YAML must be redacted before it is rendered.
pub(crate) fn is_secret(api_version: &str, kind: &str) -> bool {
    kind == "Secret" && api_version == "v1"
}

/// Sorted key names. Used by the tests to describe a Secret's shape
/// without printing it.
#[cfg(test)]
pub(crate) fn key_names(data: &ResourceData) -> Vec<String> {
    data.keys.iter().map(|k| k.key.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_configmap_value_is_returned_as_written() {
        let key = describe("log_level".into(), b"debug", true);
        assert_eq!(key.value.as_deref(), Some("debug"));
        assert_eq!(key.bytes, 5);
        assert!(!key.binary);
    }

    #[test]
    fn a_withheld_value_still_reports_its_size() {
        // The point of the unrevealed view: you can see that a key
        // exists and roughly what it is, without reading it.
        let key = describe("password".into(), b"hunter2", false);
        assert_eq!(key.value, None);
        assert_eq!(key.bytes, 7);
    }

    #[test]
    fn a_non_utf8_value_is_flagged_rather_than_mangled() {
        // A DER-encoded key rendered as text is a screen of replacement
        // characters that looks like corruption.
        let key = describe("tls.key".into(), &[0xff, 0xfe, 0x00], true);
        assert!(key.binary);
        assert_eq!(key.value, None, "binary values are never rendered");
        assert_eq!(key.bytes, 3);
    }

    #[test]
    fn only_secrets_are_treated_as_secret() {
        assert!(is_secret("v1", "Secret"));
        assert!(!is_secret("v1", "ConfigMap"));
        // A CRD may legitimately call itself Secret in its own group,
        // and it is not the one with base64 values in `data`.
        assert!(!is_secret("example.com/v1", "Secret"));
    }

    #[test]
    fn redaction_replaces_every_value_and_keeps_every_key() {
        // Keys are the shape of the Secret and are safe to show; values
        // are the Secret. Dropping the keys would make the tab useless,
        // and keeping one value would make it dangerous.
        let mut object = serde_json::json!({
            "kind": "Secret",
            "metadata": {"name": "db"},
            "type": "Opaque",
            "data": {"username": "cG9zdGdyZXM=", "password": "aHVudGVyMg=="},
            "stringData": {"legacy": "plaintext"}
        });
        redact(&mut object);

        let data = object["data"].as_object().unwrap();
        assert_eq!(data.len(), 2, "keys stay");
        assert!(data.values().all(|v| v.as_str() == Some(REDACTED)));
        assert_eq!(object["stringData"]["legacy"], REDACTED);
        // Everything that is not a value is left alone.
        assert_eq!(object["type"], "Opaque");
        assert_eq!(object["metadata"]["name"], "db");
    }

    #[test]
    fn redacting_an_object_with_no_data_is_a_no_op() {
        let mut object = serde_json::json!({"kind": "Secret", "metadata": {"name": "empty"}});
        redact(&mut object);
        assert_eq!(object["metadata"]["name"], "empty");
    }

    #[test]
    fn redaction_ignores_a_data_field_that_is_not_a_map() {
        // A CRD can have a scalar `data`. Redacting it would corrupt an
        // object that was never a Secret to begin with.
        let mut object = serde_json::json!({"data": "a string"});
        redact(&mut object);
        assert_eq!(object["data"], "a string");
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn a_live_secret_is_described_without_being_disclosed() {
        let session = crate::cluster::live::session().await;

        // Helm's release secrets exist on any cluster with a release,
        // and are the largest secrets around — a good subject.
        let data = get_secret_data(&session, "krypton-system", "sh.helm.release.v1.krypton.v1", vec![])
            .await
            .expect("read secret");

        println!("type {:?}, keys {:?}", data.type_, key_names(&data));
        assert!(data.redacted);
        assert!(!data.keys.is_empty(), "a helm release secret has a key");
        assert!(
            data.keys.iter().all(|k| k.value.is_none()),
            "nothing should be disclosed without being asked for"
        );
        assert!(
            data.keys.iter().all(|k| k.bytes > 0),
            "sizes describe a key without revealing it"
        );

        // The detail view's YAML tab goes through the generic object
        // path, so the redaction has to hold there — that is the route
        // an operator actually takes to a Secret.
        let detail = crate::cluster::discovery::get_object(
            &session,
            crate::cluster::table::gvk("", "v1", "Secret"),
            Some("krypton-system".into()),
            "sh.helm.release.v1.krypton.v1",
        )
        .await
        .expect("get secret through the generic path");

        assert!(detail.yaml.contains("kind: Secret"));
        assert!(
            detail.yaml.contains("redacted"),
            "the YAML tab must not print the value"
        );
        assert!(
            !detail.editable,
            "redacted YAML must not be appliable — it would overwrite every value"
        );

        // Naming a key opts into seeing it, and nothing else.
        let revealed = get_secret_data(
            &session,
            "krypton-system",
            "sh.helm.release.v1.krypton.v1",
            vec!["release".into()],
        )
        .await
        .expect("reveal one key");
        let release = revealed.keys.iter().find(|k| k.key == "release").unwrap();
        assert!(release.value.is_some(), "the named key should be readable");
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn a_live_configmap_is_readable() {
        let session = crate::cluster::live::session().await;

        // Every cluster has this one: the cluster-info ConfigMap.
        let data = get_config_map_data(&session, "kube-system", "coredns")
            .await
            .expect("read configmap");
        println!("keys: {:?}", key_names(&data));

        assert!(!data.redacted, "a ConfigMap holds nothing to hide");
        assert!(
            data.keys.iter().any(|k| k.value.is_some()),
            "a ConfigMap's values are shown outright"
        );
    }
}
