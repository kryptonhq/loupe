//! The search criteria, against a real cluster.
//!
//! Ignored by default. Run against a throwaway `kind` cluster:
//!
//!   KUBECONFIG=/tmp/kind.kubeconfig LOUPE_TEST_CONTEXT=kind-loupe-problems \
//!     cargo test --release --lib search::live_tests -- --ignored --nocapture
//!
//! Creates a CRD with 200 instances and 5,000 ConfigMaps, measures how
//! long the index takes to warm and how long a query takes once it has,
//! installs a second CRD mid-session to check it joins after a discovery
//! refresh, and checks a restricted user is told how many kinds it could
//! not index. Deletes everything it made.

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{ConfigMap, Namespace, ServiceAccount};
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, PostParams};
use kube::core::{ApiResource, GroupVersionKind};
use serde_json::json;

use super::*;
use crate::cluster::live;

const CONFIGMAPS: usize = 5_000;
const WIDGETS: usize = 200;

fn crd(plural: &str, kind: &str) -> CustomResourceDefinition {
    serde_json::from_value(json!({
        "metadata": { "name": format!("{plural}.loupe.test") },
        "spec": {
            "group": "loupe.test",
            "scope": "Namespaced",
            "names": { "plural": plural, "singular": kind.to_lowercase(), "kind": kind },
            "versions": [{
                "name": "v1", "served": true, "storage": true,
                "schema": { "openAPIV3Schema": { "type": "object", "x-kubernetes-preserve-unknown-fields": true } }
            }]
        }
    }))
    .unwrap()
}

async fn wait_established(crds: &Api<CustomResourceDefinition>, name: &str) {
    for _ in 0..60 {
        if let Ok(c) = crds.get(name).await {
            let ok = c
                .status
                .and_then(|s| s.conditions)
                .unwrap_or_default()
                .iter()
                .any(|c| c.type_ == "Established" && c.status == "True");
            if ok {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("{name} never established");
}

/// Searches until the index says it has finished warming.
async fn warmed(
    index: &'static SearchIndex,
    session: &Session,
    timeout: Duration,
) -> (SearchResponse, Duration) {
    let start = Instant::now();
    loop {
        let r = index.search(session, "").await.expect("search");
        if !r.warming
            && r.indexed_kinds + r.forbidden_kinds + r.failed_kinds >= r.total_kinds
            && r.total_kinds > 0
        {
            return (r, start.elapsed());
        }
        assert!(
            start.elapsed() < timeout,
            "still warming after {timeout:?}: {} of {}",
            r.indexed_kinds,
            r.total_kinds
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
async fn warms_in_the_background_answers_fast_and_follows_discovery() {
    let session = live::session().await;
    let client = session.client().await.unwrap();
    let stamp = k8s_openapi::jiff::Timestamp::now().as_second();
    let ns = format!("loupe-search-{stamp}");
    let pp = PostParams::default();
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let name = format!("loupe-search-{stamp}");

    namespaces
        .create(
            &pp,
            &serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap(),
        )
        .await
        .unwrap();

    let outcome = async {
        // --- seed: a CRD with instances, and thousands of ConfigMaps.
        crds.create(&pp, &crd("widgets", "Widget")).await.map_err(|e| e.to_string())?;
        wait_established(&crds, "widgets.loupe.test").await;
        session.refresh_discovery().await.map_err(|e| e.to_string())?;
        let widget = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("loupe.test", "v1", "Widget"), "widgets");
        let widgets: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &widget);
        let cms: Api<ConfigMap> = Api::namespaced(client.clone(), &ns);

        let seeded = Instant::now();
        let creates = (0..CONFIGMAPS).map(|i| {
            let cms = cms.clone();
            async move {
                let cm: ConfigMap = serde_json::from_value(json!({ "metadata": { "name": format!("settings-{i:05}") } })).unwrap();
                cms.create(&PostParams::default(), &cm).await.map(|_| ())
            }
        });
        let failures = stream::iter(creates).buffer_unordered(64).filter(|r| futures::future::ready(r.is_err())).count().await;
        for i in 0..WIDGETS {
            let w = DynamicObject::new(&format!("gizmo-widget-{i:03}"), &widget).within(&ns);
            widgets.create(&pp, &w).await.map_err(|e| e.to_string())?;
        }
        println!("seeded {CONFIGMAPS} configmaps and {WIDGETS} widgets in {:.1}s ({failures} failed)", seeded.elapsed().as_secs_f64());

        // --- warm: the first search returns at once, and warming happens behind it.
        let index: &'static SearchIndex = Box::leak(Box::default());
        let first = Instant::now();
        let r = index.search(&session, "settings").await.map_err(|e| e.to_string())?;
        let first_call = first.elapsed();
        println!("first search returned in {first_call:?} while warming={} ({} of {} kinds)", r.warming, r.indexed_kinds, r.total_kinds);
        assert!(first_call < Duration::from_millis(500), "the first search must not wait for the index");

        let (r, warm) = warmed(index, &session, Duration::from_secs(120)).await;
        println!(
            "warm: {} objects across {} kinds ({} forbidden, {} failed) in {:.2}s, ≈ {:.2} MB",
            r.objects, r.indexed_kinds, r.forbidden_kinds, r.failed_kinds, warm.as_secs_f64(), r.approx_bytes as f64 / 1_048_576.0
        );
        {
            let data = index.data.lock().unwrap();
            for (kind, (why, _)) in &data.failed {
                println!("  failed: {kind}: {why}");
            }
        }
        assert!(r.objects >= CONFIGMAPS, "{} objects", r.objects);
        assert!(r.indexed_kinds >= 40, "{} kinds", r.indexed_kinds);

        // --- query latency once warm, end to end through the command path.
        let mut slowest = Duration::ZERO;
        for q in ["set", "giz", "cor", "kub", "wid"] {
            let t = Instant::now();
            let r = index.search(&session, q).await.map_err(|e| e.to_string())?;
            slowest = slowest.max(t.elapsed());
            assert!(!r.hits.is_empty(), "{q} found nothing");
        }
        println!("slowest warm 3-character query: {slowest:?}");
        assert!(slowest < Duration::from_millis(300));

        let r = index.search(&session, "gizmo-widget-042").await.map_err(|e| e.to_string())?;
        assert_eq!(r.hits[0].kind, "Widget", "a custom resource is found like any other kind");
        assert_eq!(r.hits[0].namespace.as_deref(), Some(ns.as_str()));

        // --- a CRD installed after warming joins after a discovery refresh.
        crds.create(&pp, &crd("sprockets", "Sprocket")).await.map_err(|e| e.to_string())?;
        wait_established(&crds, "sprockets.loupe.test").await;
        let sprocket = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("loupe.test", "v1", "Sprocket"), "sprockets");
        Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &sprocket)
            .create(&pp, &DynamicObject::new("late-sprocket", &sprocket).within(&ns))
            .await
            .map_err(|e| e.to_string())?;
        session.refresh_discovery().await.map_err(|e| e.to_string())?;
        let joined = Instant::now();
        loop {
            let r = index.search(&session, "late-sprocket").await.map_err(|e| e.to_string())?;
            if r.hits.iter().any(|h| h.kind == "Sprocket") {
                println!("a CRD installed after warming was searchable {:?} after the refresh", joined.elapsed());
                break;
            }
            assert!(joined.elapsed() < Duration::from_secs(30), "new CRD never indexed");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // --- a restricted user is told what it could not index.
        let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), &ns);
        let roles: Api<ClusterRole> = Api::all(client.clone());
        let bindings: Api<ClusterRoleBinding> = Api::all(client.clone());
        accounts.create(&pp, &serde_json::from_value(json!({ "metadata": { "name": "viewer" } })).unwrap()).await.map_err(|e| e.to_string())?;
        roles.create(&pp, &serde_json::from_value(json!({
            "metadata": { "name": name },
            "rules": [{ "apiGroups": [""], "resources": ["pods", "configmaps", "services"], "verbs": ["list"] }]
        })).unwrap()).await.map_err(|e| e.to_string())?;
        bindings.create(&pp, &serde_json::from_value(json!({
            "metadata": { "name": name },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": name },
            "subjects": [{ "kind": "ServiceAccount", "name": "viewer", "namespace": ns }]
        })).unwrap()).await.map_err(|e| e.to_string())?;
        let token: serde_json::Value = accounts
            .create_subresource("token", "viewer", &pp, &json!({ "apiVersion": "authentication.k8s.io/v1", "kind": "TokenRequest", "spec": {} }))
            .await
            .map_err(|e| e.to_string())?;
        let context = std::env::var("LOUPE_TEST_CONTEXT").unwrap();
        let mut config = kube::Config::from_custom_kubeconfig(
            kube::config::Kubeconfig::read().unwrap(),
            &kube::config::KubeConfigOptions { context: Some(context.clone()), ..Default::default() },
        )
        .await
        .map_err(|e| e.to_string())?;
        config.auth_info = serde_json::from_value(json!({ "token": token["status"]["token"] })).unwrap();
        let restricted = Session::default();
        restricted
            .set(
                kube::Client::try_from(config).map_err(|e| e.to_string())?,
                crate::cluster::ClusterInfo { context, server: String::new(), version: String::new(), platform: String::new() },
            )
            .await;
        tokio::time::sleep(Duration::from_secs(3)).await;

        let restricted_index: &'static SearchIndex = Box::leak(Box::default());
        let (r, _) = warmed(restricted_index, &restricted, Duration::from_secs(120)).await;
        println!("restricted user: {} kinds indexed, {} not permitted", r.indexed_kinds, r.forbidden_kinds);
        let indexed: Vec<String> = restricted_index.data.lock().unwrap().kinds.keys().cloned().collect();
        println!("  restricted user indexed: {indexed:?}");
        for wanted in ["/v1/Pod", "/v1/ConfigMap", "/v1/Service"] {
            assert!(indexed.iter().any(|k| k == wanted), "{wanted} indexed");
        }
        assert!(r.forbidden_kinds >= 40);
        assert!(restricted_index.search(&restricted, "settings-00001").await.unwrap().hits.iter().any(|h| h.kind == "ConfigMap"));
        assert!(
            restricted_index.search(&restricted, "gizmo").await.unwrap().hits.is_empty(),
            "nothing from a kind the user may not list"
        );

        Ok::<(), String>(())
    }
    .await;

    // Outside the scenario, so a failed run does not leak cluster-wide RBAC.
    let _ = Api::<ClusterRoleBinding>::all(client.clone())
        .delete(&name, &DeleteParams::default())
        .await;
    let _ = Api::<ClusterRole>::all(client.clone())
        .delete(&name, &DeleteParams::default())
        .await;
    let _ = crds
        .delete("widgets.loupe.test", &DeleteParams::default())
        .await;
    let _ = crds
        .delete("sprockets.loupe.test", &DeleteParams::default())
        .await;
    let _ = namespaces.delete(&ns, &DeleteParams::default()).await;
    outcome.expect("scenario");
}
