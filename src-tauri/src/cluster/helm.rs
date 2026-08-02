//! Helm releases, read from the cluster rather than from the CLI.
//!
//! Helm keeps each revision of a release in a Secret whose `release`
//! key is base64-over-gzip-over-JSON. Decoding that directly means Loupe
//! shows releases on a machine with no `helm` binary and no repository
//! cache — which is most machines an operator borrows.
//!
//! This reads the Secret driver, Helm's default. A cluster deliberately
//! configured with `HELM_DRIVER=configmap` or the SQL backend keeps its
//! releases elsewhere and will show none here.

use std::collections::BTreeMap;
use std::io::Read;

use base64::Engine;
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::{resources::format_age, Session};
use crate::error::{AppError, Result};

/// The label Helm stamps on every release Secret it owns.
const OWNER_SELECTOR: &str = "owner=helm";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSummary {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub status: String,
    /// "chart-name-1.2.3", the form `helm list` prints.
    pub chart: String,
    pub app_version: Option<String>,
    pub updated: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRevision {
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub app_version: Option<String>,
    pub updated: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetail {
    pub name: String,
    pub namespace: String,
    pub revision: i64,
    pub status: String,
    pub chart: String,
    pub chart_name: String,
    pub chart_version: Option<String>,
    pub app_version: Option<String>,
    pub updated: Option<String>,
    pub first_deployed: Option<String>,
    pub description: Option<String>,
    pub chart_description: Option<String>,
    pub home: Option<String>,
    /// The post-install text. Usually the only place a chart says how to
    /// reach what it just installed.
    pub notes: Option<String>,
    /// The values the user supplied, not the chart's defaults — the same
    /// distinction `helm get values` makes, and the one that answers
    /// "what did we actually configure".
    pub values: String,
    /// Everything the release rendered, as applied.
    pub manifest: String,
    pub history: Vec<ReleaseRevision>,
}

/// Unwraps Helm's `release` payload into the JSON underneath.
///
/// The Secret's value has already been base64-decoded once by the API
/// client; what is left is Helm's own base64 wrapper around gzipped
/// JSON. Very old releases skipped the compression, so the gzip magic
/// number decides rather than the Helm version.
pub(crate) fn decode_release(raw: &[u8]) -> Result<serde_json::Value> {
    let bad =
        |what: &str| AppError::Kube(format!("this does not look like a Helm release: {what}"));

    let unwrapped = if raw.starts_with(&[0x1f, 0x8b]) {
        // Already gzip: no base64 layer to peel.
        raw.to_vec()
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| bad(&format!("its payload is not base64 ({e})")))?
    };

    let json = if unwrapped.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&unwrapped[..])
            .read_to_end(&mut out)
            .map_err(|e| bad(&format!("its payload is not gzip ({e})")))?;
        out
    } else {
        unwrapped
    };

    serde_json::from_slice(&json).map_err(|e| bad(&format!("its payload is not JSON ({e})")))
}

fn text(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(key)?;
    }
    cursor
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Age of an RFC 3339 timestamp, in the same shorthand as everything
/// else in the app.
///
/// Helm writes a local-offset timestamp; an unset one comes through as
/// the zero time, which would render as a nonsense multi-decade age.
pub(crate) fn age_of(timestamp: &str) -> Option<String> {
    let parsed: k8s_openapi::jiff::Timestamp = timestamp.parse().ok()?;
    if parsed.as_second() <= 0 {
        return None;
    }
    let now = k8s_openapi::jiff::Timestamp::now();
    Some(format_age((now.as_second() - parsed.as_second()).max(0)))
}

/// "chart-1.2.3" — how Helm itself names a release's chart.
fn chart_label(release: &serde_json::Value) -> String {
    let name = text(release, &["chart", "metadata", "name"]).unwrap_or_else(|| "unknown".into());
    match text(release, &["chart", "metadata", "version"]) {
        Some(version) => format!("{name}-{version}"),
        None => name,
    }
}

fn revision_of(release: &serde_json::Value) -> i64 {
    release.get("version").and_then(|v| v.as_i64()).unwrap_or(0)
}

fn status_of(release: &serde_json::Value) -> String {
    text(release, &["info", "status"]).unwrap_or_else(|| "unknown".into())
}

fn summarise(release: &serde_json::Value, fallback_namespace: &str) -> ReleaseSummary {
    ReleaseSummary {
        name: text(release, &["name"]).unwrap_or_default(),
        namespace: text(release, &["namespace"]).unwrap_or_else(|| fallback_namespace.to_string()),
        revision: revision_of(release),
        status: status_of(release),
        chart: chart_label(release),
        app_version: text(release, &["chart", "metadata", "appVersion"]),
        updated: text(release, &["info", "last_deployed"]).and_then(|t| age_of(&t)),
        description: text(release, &["info", "description"]),
    }
}

fn revision_view(release: &serde_json::Value) -> ReleaseRevision {
    ReleaseRevision {
        revision: revision_of(release),
        status: status_of(release),
        chart: chart_label(release),
        app_version: text(release, &["chart", "metadata", "appVersion"]),
        updated: text(release, &["info", "last_deployed"]).and_then(|t| age_of(&t)),
        description: text(release, &["info", "description"]),
    }
}

/// Picks the newest revision of each release from a set of Secrets.
///
/// Helm keeps every revision as its own Secret, so a release upgraded
/// ten times has ten of them. The list view wants one row per release,
/// and the revision number lives in a label — no need to decode nine
/// payloads to find out they are old.
pub(crate) fn latest_revisions(secrets: &[(String, String, i64)]) -> Vec<(String, String, i64)> {
    let mut newest: BTreeMap<(String, String), (String, String, i64)> = BTreeMap::new();

    for (namespace, secret_name, revision) in secrets {
        // The release name is not in this tuple, so key on the Secret
        // name with its revision suffix removed: Helm's naming is
        // sh.helm.release.v1.<release>.v<revision>.
        let release = release_name_from(secret_name).unwrap_or_else(|| secret_name.clone());
        let key = (namespace.clone(), release);

        let entry = newest
            .entry(key)
            .or_insert_with(|| (namespace.clone(), secret_name.clone(), *revision));
        if *revision > entry.2 {
            *entry = (namespace.clone(), secret_name.clone(), *revision);
        }
    }

    newest.into_values().collect()
}

/// Recovers the release name from a Helm Secret's name.
///
/// A release may itself contain dots ("my.app"), so the split is from
/// the right, at the trailing ".v<n>" — not at the first dot.
pub(crate) fn release_name_from(secret_name: &str) -> Option<String> {
    let rest = secret_name.strip_prefix("sh.helm.release.v1.")?;
    let (name, revision) = rest.rsplit_once(".v")?;
    // Guard against a release genuinely called "foo.vbar".
    revision.parse::<i64>().ok()?;
    (!name.is_empty()).then(|| name.to_string())
}

/// Revision number from the Secret's `version` label.
fn labelled_revision(secret: &impl ResourceExt) -> i64 {
    secret
        .labels()
        .get("version")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

fn payload(secret: &Secret) -> Option<&[u8]> {
    secret
        .data
        .as_ref()
        .and_then(|d| d.get("release"))
        .map(|b| b.0.as_slice())
}

fn secrets_api(client: kube::Client, namespace: Option<&str>) -> Api<Secret> {
    match namespace {
        Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
        _ => Api::all(client),
    }
}

/// Every Helm release, newest revision only.
pub async fn list_releases(
    session: &Session,
    namespace: Option<String>,
) -> Result<Vec<ReleaseSummary>> {
    let client = session.client().await?;
    let api = secrets_api(client, namespace.as_deref());
    let params = ListParams::default().labels(OWNER_SELECTOR);

    // Metadata first: a release's payload can be megabytes (the rendered
    // manifest of a large chart), and all we need to choose between
    // revisions is a label. Only the winners are fetched in full.
    let index: Vec<(String, String, i64)> = api
        .list_metadata(&params)
        .await?
        .into_iter()
        .map(|m| {
            (
                m.namespace().unwrap_or_default(),
                m.name_any(),
                labelled_revision(&m),
            )
        })
        .collect();

    let mut releases = Vec::new();
    for (ns, secret_name, _) in latest_revisions(&index) {
        let api: Api<Secret> = secrets_api(session.client().await?, Some(&ns));
        let secret = api.get(&secret_name).await?;
        let Some(raw) = payload(&secret) else {
            continue;
        };
        // One malformed release should not blank the whole list; a
        // release Loupe cannot parse is better skipped than fatal.
        if let Ok(release) = decode_release(raw) {
            releases.push(summarise(&release, &ns));
        }
    }

    releases.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(releases)
}

/// One release in full, with every revision it has been through.
pub async fn get_release(session: &Session, namespace: &str, name: &str) -> Result<ReleaseDetail> {
    let client = session.client().await?;
    let api: Api<Secret> = Api::namespaced(client, namespace);
    let params = ListParams::default().labels(&format!("{OWNER_SELECTOR},name={name}"));

    let mut revisions: Vec<serde_json::Value> = Vec::new();
    for secret in api.list(&params).await?.items {
        let Some(raw) = payload(&secret) else {
            continue;
        };
        if let Ok(release) = decode_release(raw) {
            revisions.push(release);
        }
    }

    release_detail_from(revisions, namespace, name)
}

/// Assembles the detail payload from every revision of one release.
///
/// Split from `get_release` so the two decisions worth pinning — which
/// revision leads, and which values are shown — can be tested without a
/// cluster that happens to have a release installed on it.
pub(crate) fn release_detail_from(
    mut revisions: Vec<serde_json::Value>,
    namespace: &str,
    name: &str,
) -> Result<ReleaseDetail> {
    // Newest first: the current revision leads, and the history below it
    // reads backwards in time the way `helm history` prints it.
    revisions.sort_by_key(|r| std::cmp::Reverse(revision_of(r)));

    let current = revisions.first().ok_or_else(|| {
        AppError::UnknownResource(format!("no Helm release named {name} in {namespace}"))
    })?;

    // The chart's own defaults live in chart.values; `config` is what
    // the user overrode. Showing the defaults here would bury the two
    // lines somebody actually set under a thousand they did not.
    let values = match current.get("config") {
        Some(config) if !config.is_null() && config.as_object().is_some_and(|o| !o.is_empty()) => {
            serde_yaml::to_string(config)
                .map_err(|e| AppError::Kube(format!("render values: {e}")))?
        }
        _ => String::new(),
    };

    Ok(ReleaseDetail {
        name: text(current, &["name"]).unwrap_or_else(|| name.to_string()),
        namespace: text(current, &["namespace"]).unwrap_or_else(|| namespace.to_string()),
        revision: revision_of(current),
        status: status_of(current),
        chart: chart_label(current),
        chart_name: text(current, &["chart", "metadata", "name"]).unwrap_or_default(),
        chart_version: text(current, &["chart", "metadata", "version"]),
        app_version: text(current, &["chart", "metadata", "appVersion"]),
        updated: text(current, &["info", "last_deployed"]).and_then(|t| age_of(&t)),
        first_deployed: text(current, &["info", "first_deployed"]).and_then(|t| age_of(&t)),
        description: text(current, &["info", "description"]),
        chart_description: text(current, &["chart", "metadata", "description"]),
        home: text(current, &["chart", "metadata", "home"]),
        notes: text(current, &["info", "notes"]),
        values,
        manifest: text(current, &["manifest"]).unwrap_or_default(),
        history: revisions.iter().map(revision_view).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use std::io::Write;

    fn release_json() -> serde_json::Value {
        json!({
            "name": "prom",
            "namespace": "monitoring",
            "version": 3,
            "info": {
                "status": "deployed",
                "description": "Upgrade complete",
                "notes": "browse http://localhost:3000",
                "first_deployed": "2026-05-27T16:53:58.208722+05:30",
                "last_deployed": "2026-05-27T16:53:58.208722+05:30"
            },
            "chart": {"metadata": {
                "name": "kube-prometheus-stack",
                "version": "85.3.3",
                "appVersion": "v0.87.0",
                "description": "collects Kubernetes manifests"
            }},
            "config": {"grafana": {"enabled": true}},
            "manifest": "apiVersion: v1\nkind: Service\n"
        })
    }

    /// Encodes a value the way Helm stores it: gzip, then base64.
    fn helm_payload(value: &serde_json::Value) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&serde_json::to_vec(value).unwrap())
            .unwrap();
        let gzipped = encoder.finish().unwrap();
        base64::engine::general_purpose::STANDARD
            .encode(gzipped)
            .into_bytes()
    }

    #[test]
    fn decodes_a_release_stored_the_way_helm_stores_it() {
        let decoded = decode_release(&helm_payload(&release_json())).expect("decode");
        assert_eq!(decoded["name"], "prom");
        assert_eq!(decoded["version"], 3);
    }

    #[test]
    fn decodes_a_release_that_was_never_compressed() {
        // Releases written by very old Helm skipped the gzip layer.
        let raw = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&release_json()).unwrap())
            .into_bytes();
        assert_eq!(decode_release(&raw).unwrap()["name"], "prom");
    }

    #[test]
    fn decodes_a_payload_that_arrives_as_bare_gzip() {
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&serde_json::to_vec(&release_json()).unwrap())
            .unwrap();
        let gzipped = encoder.finish().unwrap();
        assert_eq!(decode_release(&gzipped).unwrap()["name"], "prom");
    }

    #[test]
    fn a_secret_that_is_not_a_release_fails_with_a_legible_message() {
        let err = decode_release(b"!!!not base64!!!").expect_err("should fail");
        assert!(err.to_string().contains("Helm release"), "{err}");

        let json_but_not_gzip = base64::engine::general_purpose::STANDARD
            .encode(b"plain text")
            .into_bytes();
        assert!(decode_release(&json_but_not_gzip).is_err());
    }

    #[test]
    fn summarises_a_release_the_way_helm_list_prints_it() {
        let got = summarise(&release_json(), "fallback");
        assert_eq!(got.name, "prom");
        assert_eq!(got.namespace, "monitoring");
        assert_eq!(got.revision, 3);
        assert_eq!(got.status, "deployed");
        assert_eq!(got.chart, "kube-prometheus-stack-85.3.3");
        assert_eq!(got.app_version.as_deref(), Some("v0.87.0"));
    }

    #[test]
    fn a_release_missing_its_chart_metadata_still_summarises() {
        // A payload we cannot fully read should still produce a row —
        // the release exists whether or not we understand its chart.
        let got = summarise(&json!({"name": "bare", "version": 1}), "default");
        assert_eq!(got.chart, "unknown");
        assert_eq!(got.status, "unknown");
        assert_eq!(
            got.namespace, "default",
            "falls back to the Secret's namespace"
        );
    }

    #[test]
    fn reads_the_release_name_out_of_a_secret_name() {
        assert_eq!(
            release_name_from("sh.helm.release.v1.prom.v12").as_deref(),
            Some("prom")
        );
    }

    #[test]
    fn a_release_name_containing_dots_survives() {
        // Splitting at the first dot would call this release "my".
        assert_eq!(
            release_name_from("sh.helm.release.v1.my.app.v2").as_deref(),
            Some("my.app")
        );
    }

    #[test]
    fn a_release_name_ending_in_v_something_is_not_mistaken_for_a_revision() {
        assert_eq!(
            release_name_from("sh.helm.release.v1.app.vnext.v4").as_deref(),
            Some("app.vnext")
        );
    }

    #[test]
    fn a_secret_that_is_not_helms_is_not_a_release() {
        assert_eq!(release_name_from("my-tls-cert"), None);
        assert_eq!(release_name_from("sh.helm.release.v1.noversion"), None);
    }

    #[test]
    fn only_the_newest_revision_of_each_release_survives() {
        let secrets = vec![
            ("monitoring".into(), "sh.helm.release.v1.prom.v1".into(), 1),
            ("monitoring".into(), "sh.helm.release.v1.prom.v3".into(), 3),
            ("monitoring".into(), "sh.helm.release.v1.prom.v2".into(), 2),
            ("default".into(), "sh.helm.release.v1.app.v1".into(), 1),
        ];
        let got = latest_revisions(&secrets);
        assert_eq!(got.len(), 2, "one row per release: {got:?}");
        let prom = got.iter().find(|(_, n, _)| n.contains("prom")).unwrap();
        assert_eq!(prom.2, 3, "the newest revision should win");
    }

    #[test]
    fn releases_of_the_same_name_in_different_namespaces_stay_separate() {
        // Two teams installing "app" in their own namespaces is normal,
        // and collapsing them would hide one of them entirely.
        let secrets = vec![
            ("a".into(), "sh.helm.release.v1.app.v1".into(), 1),
            ("b".into(), "sh.helm.release.v1.app.v5".into(), 5),
        ];
        assert_eq!(latest_revisions(&secrets).len(), 2);
    }

    #[test]
    fn the_zero_timestamp_has_no_age() {
        // Helm writes it for a release that was never deployed; showing
        // it as "20000d" would be worse than showing nothing.
        assert_eq!(age_of("1970-01-01T00:00:00Z"), None);
        assert_eq!(age_of("not a timestamp"), None);
    }

    #[test]
    fn a_real_timestamp_renders_an_age() {
        let recent = k8s_openapi::jiff::Timestamp::now().to_string();
        assert!(age_of(&recent).is_some());
    }

    /// The same release at an earlier revision.
    fn revision_at(version: i64, status: &str) -> serde_json::Value {
        let mut release = release_json();
        release["version"] = json!(version);
        release["info"]["status"] = json!(status);
        release
    }

    #[test]
    fn the_current_revision_leads_however_the_secrets_arrived() {
        // The API returns Secrets in name order, which puts v10 before
        // v2. Leading with the wrong one would show a superseded release
        // as the live one — the worst thing this view could get wrong.
        let detail = release_detail_from(
            vec![
                revision_at(2, "superseded"),
                revision_at(10, "deployed"),
                revision_at(1, "superseded"),
            ],
            "monitoring",
            "prom",
        )
        .expect("build detail");

        assert_eq!(detail.revision, 10);
        assert_eq!(detail.status, "deployed");
        assert_eq!(detail.history[0].revision, 10);
        assert!(
            detail
                .history
                .windows(2)
                .all(|w| w[0].revision >= w[1].revision),
            "history reads backwards in time"
        );
    }

    #[test]
    fn values_show_what_was_overridden_not_the_charts_defaults() {
        // `config` is the user's overrides; the chart's own defaults live
        // in chart.values. Showing the defaults would bury the two lines
        // somebody actually set under a thousand they did not.
        let detail =
            release_detail_from(vec![release_json()], "monitoring", "prom").expect("build detail");
        assert!(detail.values.contains("grafana"));
        assert!(detail.values.contains("enabled"));
    }

    #[test]
    fn a_release_installed_with_no_overrides_shows_empty_values() {
        // `helm install` with no -f and no --set. Rendering "{}" or
        // "null" would read as a value someone set.
        let mut release = release_json();
        release["config"] = json!({});
        let detail =
            release_detail_from(vec![release], "monitoring", "prom").expect("build detail");
        assert_eq!(detail.values, "");

        let mut null_config = release_json();
        null_config["config"] = serde_json::Value::Null;
        let detail =
            release_detail_from(vec![null_config], "monitoring", "prom").expect("build detail");
        assert_eq!(detail.values, "");
    }

    #[test]
    fn a_release_with_no_readable_revisions_says_so_by_name() {
        // Reached when every Secret for the name failed to decode. The
        // error has to name the release and namespace, because the next
        // question is always "which one".
        let err = release_detail_from(Vec::new(), "monitoring", "prom")
            .expect_err("no revisions is an error");
        let message = err.to_string();
        assert!(message.contains("prom"), "{message}");
        assert!(message.contains("monitoring"), "{message}");
    }

    #[test]
    fn detail_carries_the_notes_and_chart_metadata_the_view_renders() {
        let detail =
            release_detail_from(vec![release_json()], "monitoring", "prom").expect("build detail");

        assert_eq!(detail.chart_name, "kube-prometheus-stack");
        assert_eq!(detail.chart_version.as_deref(), Some("85.3.3"));
        assert_eq!(detail.chart, "kube-prometheus-stack-85.3.3");
        // Usually the only place a chart says how to reach what it
        // installed, so losing it costs the user the next step.
        assert_eq!(
            detail.notes.as_deref(),
            Some("browse http://localhost:3000")
        );
        assert!(detail.manifest.contains("kind: Service"));
    }

    #[test]
    fn a_release_whose_payload_omits_its_own_name_falls_back_to_the_secrets() {
        // The name and namespace were already known from the Secret; a
        // payload missing them should not produce a detail page titled
        // with an empty string.
        let detail = release_detail_from(
            vec![json!({"version": 1, "info": {"status": "deployed"}})],
            "monitoring",
            "prom",
        )
        .expect("build detail");
        assert_eq!(detail.name, "prom");
        assert_eq!(detail.namespace, "monitoring");
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn reads_live_helm_releases() {
        let session = crate::cluster::live::session().await;

        let releases = list_releases(&session, None).await.expect("list releases");
        println!("{} release(s)", releases.len());
        for r in &releases {
            println!(
                "  {}/{} {} rev {} ({})",
                r.namespace, r.name, r.chart, r.revision, r.status
            );
        }

        let Some(first) = releases.first() else {
            println!("no Helm releases installed; nothing to detail");
            return;
        };

        let detail = get_release(&session, &first.namespace, &first.name)
            .await
            .expect("get release");
        println!(
            "{}: chart {}, {} revision(s), manifest {} bytes",
            detail.name,
            detail.chart,
            detail.history.len(),
            detail.manifest.len()
        );

        assert_eq!(detail.name, first.name);
        assert_eq!(detail.revision, first.revision);
        assert!(!detail.chart_name.is_empty(), "a release names its chart");
        assert!(
            !detail.manifest.is_empty(),
            "a deployed release rendered something"
        );
        // History is newest-first, and the head of it is the release we
        // just asked about.
        assert_eq!(detail.history[0].revision, detail.revision);
        assert!(
            detail
                .history
                .windows(2)
                .all(|w| w[0].revision >= w[1].revision),
            "history should read backwards in time"
        );
    }
}
