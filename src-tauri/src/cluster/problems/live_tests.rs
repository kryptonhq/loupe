//! The Problems view's acceptance scenario, against a real cluster.
//!
//! Ignored by default: it needs a cluster, and it creates and deletes a
//! namespace of its own. Run it against a throwaway `kind` cluster:
//!
//!   kind create cluster --name loupe-problems --kubeconfig /tmp/kind.kubeconfig
//!   KUBECONFIG=/tmp/kind.kubeconfig LOUPE_TEST_CONTEXT=kind-loupe-problems \
//!     cargo test --lib problems::live_tests -- --ignored --nocapture
//!
//! It breaks three things on purpose — an image that cannot be pulled, a
//! pod no node can take, a CronJob whose run failed — and asserts the
//! monitor reports all three within five seconds of starting, then that
//! fixing the image clears its row without anything being refetched.

use std::time::{Duration, Instant};

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{DeleteParams, Patch, PatchParams, PostParams};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::cluster::live;

/// Present in every kind node image, so nothing here needs the network
/// to run — only the deliberately broken image does, and it is meant to fail.
const PAUSE: &str = "registry.k8s.io/pause:3.10";

struct Tx(mpsc::UnboundedSender<ProblemsSnapshot>);
impl ProblemsSink for Tx {
    fn send(&self, snapshot: ProblemsSnapshot) -> bool {
        self.0.send(snapshot).is_ok()
    }
}

fn in_ns<'a>(snap: &'a ProblemsSnapshot, ns: &'a str) -> impl Iterator<Item = &'a Problem> + 'a {
    snap.problems
        .iter()
        .filter(move |p| p.target.as_ref().and_then(|t| t.namespace.as_deref()) == Some(ns))
}

fn has(snap: &ProblemsSnapshot, ns: &str, kind: &str, name_prefix: &str, reasons: &[&str]) -> bool {
    in_ns(snap, ns).any(|p| {
        let t = p.target.as_ref().unwrap();
        t.kind == kind && t.name.starts_with(name_prefix) && reasons.contains(&p.reason.as_str())
    })
}

async fn eventually<F, Fut>(what: &str, timeout: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check().await {
            println!("  ready: {what} ({:.1}s)", start.elapsed().as_secs_f64());
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
#[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
async fn reports_broken_workloads_within_five_seconds_and_clears_a_fixed_one() {
    let session = live::session().await;
    let client = session.client().await.unwrap();
    let ns = format!(
        "loupe-problems-{}",
        k8s_openapi::jiff::Timestamp::now().as_second()
    );
    let pp = PostParams::default();

    let namespaces: Api<Namespace> = Api::all(client.clone());
    namespaces
        .create(
            &pp,
            &serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap(),
        )
        .await
        .expect("create namespace");

    let result = scenario(&session, client.clone(), &ns).await;

    let _ = namespaces.delete(&ns, &DeleteParams::default()).await;
    result.expect("scenario");
}

async fn scenario(
    session: &Session,
    client: kube::Client,
    ns: &str,
) -> std::result::Result<(), String> {
    let pp = PostParams::default();
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), ns);
    let jobs: Api<Job> = Api::namespaced(client.clone(), ns);

    println!("breaking three things in {ns}");

    // 1. An image that does not exist.
    deployments
        .create(&pp, &serde_json::from_value(json!({
            "metadata": { "name": "bad-image" },
            "spec": {
                "replicas": 1,
                "selector": { "matchLabels": { "app": "bad-image" } },
                "template": {
                    "metadata": { "labels": { "app": "bad-image" } },
                    "spec": { "containers": [{ "name": "app", "image": "registry.invalid/loupe/does-not-exist:1" }] }
                }
            }
        })).unwrap())
        .await
        .map_err(|e| e.to_string())?;

    // 2. A pod no node can take.
    pods.create(
        &pp,
        &serde_json::from_value(json!({
            "metadata": { "name": "impossible" },
            "spec": {
                "nodeSelector": { "loupe.test/never": "true" },
                "containers": [{ "name": "app", "image": PAUSE }]
            }
        }))
        .unwrap(),
    )
    .await
    .map_err(|e| e.to_string())?;

    // 3. A CronJob whose last run failed. The run is created by hand the way
    //    `kubectl create job --from=cronjob/…` does — owned by the CronJob —
    //    rather than waiting for a schedule, and fails by deadline so it
    //    needs no image with a shell in it.
    let cron = cronjobs
        .create(
            &pp,
            &serde_json::from_value(json!({
                "metadata": { "name": "failing" },
                "spec": {
                    "schedule": "0 0 1 1 *",
                    "jobTemplate": { "spec": { "template": { "spec": {
                        "restartPolicy": "Never",
                        "containers": [{ "name": "app", "image": PAUSE }]
                    }}}}
                }
            }))
            .unwrap(),
        )
        .await
        .map_err(|e| e.to_string())?;
    jobs.create(
        &pp,
        &serde_json::from_value(json!({
            "metadata": {
                "name": "failing-manual",
                "ownerReferences": [{
                    "apiVersion": "batch/v1", "kind": "CronJob", "name": "failing",
                    "uid": cron.metadata.uid, "controller": true
                }]
            },
            "spec": {
                "backoffLimit": 0,
                "activeDeadlineSeconds": 1,
                "template": { "spec": {
                    "restartPolicy": "Never",
                    "containers": [{ "name": "app", "image": PAUSE }]
                }}
            }
        }))
        .unwrap(),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Wait for the cluster to actually be in the broken state, so what is
    // measured below is Loupe's latency and not the kubelet's.
    eventually("image pull failing", Duration::from_secs(120), || async {
        pods.list(&Default::default()).await.is_ok_and(|l| {
            l.items.iter().any(|p| {
                p.metadata
                    .name
                    .as_deref()
                    .unwrap_or("")
                    .starts_with("bad-image")
                    && p.status
                        .as_ref()
                        .and_then(|s| s.container_statuses.as_ref())
                        .is_some_and(|cs| {
                            cs.iter().any(|c| {
                                matches!(
                                    c.state
                                        .as_ref()
                                        .and_then(|s| s.waiting.as_ref())
                                        .and_then(|w| w.reason.as_deref()),
                                    Some("ErrImagePull" | "ImagePullBackOff")
                                )
                            })
                        })
            })
        })
    })
    .await;
    eventually("pod unschedulable", Duration::from_secs(60), || async {
        pods.get("impossible").await.is_ok_and(|p| {
            p.status
                .and_then(|s| s.conditions)
                .unwrap_or_default()
                .iter()
                .any(|c| c.type_ == "PodScheduled" && c.status == "False")
        })
    })
    .await;
    eventually("job failed", Duration::from_secs(120), || async {
        jobs.get("failing-manual").await.is_ok_and(|j| {
            j.status
                .and_then(|s| s.conditions)
                .unwrap_or_default()
                .iter()
                .any(|c| c.type_ == "Failed" && c.status == "True")
        })
    })
    .await;

    // The pending pod needs to be older than the grace period. The real
    // default is two minutes; the test uses five seconds so it does not
    // spend two minutes proving arithmetic the unit tests already cover.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let limits = Thresholds {
        grace_seconds: 5,
        ..Thresholds::default()
    };

    // Now "connect": start a fresh monitor and time the first complete answer.
    let monitors: &'static Monitors = Box::leak(Box::default());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let started = Instant::now();
    let id = start(session, monitors, limits, Tx(tx))
        .await
        .map_err(|e| e.to_string())?;

    let mut latest = None;
    while started.elapsed() < Duration::from_secs(5) {
        let Ok(Some(snap)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await
        else {
            continue;
        };
        let all = has(
            &snap,
            ns,
            "Pod",
            "bad-image",
            &["ErrImagePull", "ImagePullBackOff"],
        ) && has(&snap, ns, "Pod", "impossible", &["Unschedulable"])
            && has(&snap, ns, "CronJob", "failing", &["LastRunFailed"]);
        latest = Some(snap);
        if all {
            break;
        }
    }
    let elapsed = started.elapsed();
    let snap = latest.ok_or("no snapshot within 5s")?;
    for p in in_ns(&snap, ns) {
        println!(
            "  {:?} {} {}: {}",
            p.severity,
            p.reason,
            p.target.as_ref().unwrap().name,
            p.message
        );
    }
    assert!(
        has(
            &snap,
            ns,
            "Pod",
            "bad-image",
            &["ErrImagePull", "ImagePullBackOff"]
        ),
        "bad image row"
    );
    assert!(
        has(&snap, ns, "Pod", "impossible", &["Unschedulable"]),
        "unschedulable row"
    );
    assert!(
        has(&snap, ns, "CronJob", "failing", &["LastRunFailed"]),
        "cronjob row"
    );
    let unschedulable = in_ns(&snap, ns)
        .find(|p| p.reason == "Unschedulable")
        .unwrap();
    assert!(
        unschedulable.message.contains("node affinity/selector"),
        "the scheduler's reason is carried: {}",
        unschedulable.message
    );
    println!(
        "all three reported {:.2}s after starting",
        elapsed.as_secs_f64()
    );
    assert!(elapsed < Duration::from_secs(5));

    // Fix the image. Nothing is refetched by the test: the row has to go
    // because the watch saw the rollout.
    deployments
        .patch(
            "bad-image",
            &PatchParams::default(),
            &Patch::Merge(json!({ "spec": { "template": { "spec": { "containers": [{ "name": "app", "image": PAUSE }] } } } })),
        )
        .await
        .map_err(|e| e.to_string())?;
    let fixed = Instant::now();
    loop {
        let snap = tokio::time::timeout(
            Duration::from_secs(90).saturating_sub(fixed.elapsed()),
            rx.recv(),
        )
        .await
        .map_err(|_| "image row still present 90s after the fix".to_string())?
        .ok_or("monitor stopped")?;
        if !has(
            &snap,
            ns,
            "Pod",
            "bad-image",
            &["ErrImagePull", "ImagePullBackOff"],
        ) {
            println!(
                "image row cleared {:.1}s after the fix",
                fixed.elapsed().as_secs_f64()
            );
            break;
        }
    }

    monitors.stop(id).await;
    Ok(())
}

/// A user who may list workloads but not nodes or events still gets
/// every other category, and the two refused ones each say so once.
///
/// Run with the same environment as the test above. It creates a
/// ServiceAccount with exactly that access, connects as it, and deletes
/// everything afterwards.
#[tokio::test]
#[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
async fn a_forbidden_category_is_one_not_permitted_row_and_the_rest_still_work() {
    use k8s_openapi::api::core::v1::ServiceAccount;
    use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding};

    let admin = live::session().await;
    let client = admin.client().await.unwrap();
    let stamp = k8s_openapi::jiff::Timestamp::now().as_second();
    let ns = format!("loupe-rbac-{stamp}");
    let name = format!("loupe-no-nodes-{stamp}");
    let pp = PostParams::default();

    let namespaces: Api<Namespace> = Api::all(client.clone());
    let roles: Api<ClusterRole> = Api::all(client.clone());
    let bindings: Api<ClusterRoleBinding> = Api::all(client.clone());
    namespaces
        .create(
            &pp,
            &serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap(),
        )
        .await
        .unwrap();

    let outcome = async {
        let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), &ns);
        accounts
            .create(&pp, &serde_json::from_value(json!({ "metadata": { "name": "viewer" } })).unwrap())
            .await
            .map_err(|e| e.to_string())?;
        roles
            .create(&pp, &serde_json::from_value(json!({
                "metadata": { "name": name },
                "rules": [
                    { "apiGroups": [""], "resources": ["pods", "persistentvolumeclaims"], "verbs": ["list", "watch"] },
                    { "apiGroups": ["apps"], "resources": ["deployments", "statefulsets", "daemonsets"], "verbs": ["list", "watch"] },
                    { "apiGroups": ["batch"], "resources": ["jobs", "cronjobs"], "verbs": ["list", "watch"] }
                ]
            })).unwrap())
            .await
            .map_err(|e| e.to_string())?;
        bindings
            .create(&pp, &serde_json::from_value(json!({
                "metadata": { "name": name },
                "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": name },
                "subjects": [{ "kind": "ServiceAccount", "name": "viewer", "namespace": ns }]
            })).unwrap())
            .await
            .map_err(|e| e.to_string())?;

        // Something broken the restricted user can see.
        Api::<Pod>::namespaced(client.clone(), &ns)
            .create(&pp, &serde_json::from_value(json!({
                "metadata": { "name": "impossible" },
                "spec": { "nodeSelector": { "loupe.test/never": "true" }, "containers": [{ "name": "app", "image": PAUSE }] }
            })).unwrap())
            .await
            .map_err(|e| e.to_string())?;

        let token: serde_json::Value = accounts
            .create_subresource("token", "viewer", &pp, &json!({
                "apiVersion": "authentication.k8s.io/v1", "kind": "TokenRequest", "spec": {}
            }))
            .await
            .map_err(|e| e.to_string())?;
        let token = token["status"]["token"].as_str().ok_or("no token")?.to_string();

        // The admin's cluster, the service account's identity.
        let context = std::env::var("LOUPE_TEST_CONTEXT").unwrap();
        let mut config = kube::Config::from_custom_kubeconfig(
            kube::config::Kubeconfig::read().unwrap(),
            &kube::config::KubeConfigOptions { context: Some(context.clone()), ..Default::default() },
        )
        .await
        .map_err(|e| e.to_string())?;
        config.auth_info = serde_json::from_value(json!({ "token": token })).unwrap();
        let restricted = Session::default();
        restricted
            .set(
                kube::Client::try_from(config).map_err(|e| e.to_string())?,
                crate::cluster::ClusterInfo {
                    context,
                    server: String::new(),
                    version: String::new(),
                    platform: String::new(),
                },
            )
            .await;

        // Give RBAC a moment to propagate, and the pod its grace period.
        tokio::time::sleep(Duration::from_secs(6)).await;

        let monitors: &'static Monitors = Box::leak(Box::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let limits = Thresholds { grace_seconds: 5, ..Thresholds::default() };
        start(&restricted, monitors, limits, Tx(tx)).await.map_err(|e| e.to_string())?;

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut snap = None;
        while Instant::now() < deadline {
            let Ok(Some(s)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await else { continue };
            let done = s.sources.iter().all(|x| x.state != SourceState::Loading);
            snap = Some(s);
            if done {
                break;
            }
        }
        let snap = snap.ok_or("no snapshot")?;
        monitors.stop_all().await;

        for p in &snap.problems {
            if p.target.is_none() || p.target.as_ref().and_then(|t| t.namespace.as_deref()) == Some(ns.as_str()) {
                println!("  {:?} {} {}", p.severity, p.reason, p.message);
            }
        }

        let refused: Vec<&str> = snap
            .problems
            .iter()
            .filter(|p| p.reason == "NotPermitted")
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(refused.len(), 2, "one row each for nodes and events: {refused:?}");
        assert!(refused.contains(&"source/nodes/NotPermitted"));
        assert!(refused.contains(&"source/events/NotPermitted"));
        for s in &snap.sources {
            match s.source {
                Source::Nodes | Source::Events => assert!(matches!(s.state, SourceState::Forbidden { .. }), "{s:?}"),
                _ => assert_eq!(s.state, SourceState::Ready, "{s:?}"),
            }
        }
        assert!(
            snap.problems.iter().any(|p| p.reason == "Unschedulable"
                && p.target.as_ref().and_then(|t| t.namespace.as_deref()) == Some(ns.as_str())),
            "pod problems still reported"
        );
        Ok::<(), String>(())
    }
    .await;

    let _ = bindings.delete(&name, &DeleteParams::default()).await;
    let _ = roles.delete(&name, &DeleteParams::default()).await;
    let _ = namespaces.delete(&ns, &DeleteParams::default()).await;
    outcome.expect("scenario");
}

#[tokio::test]
#[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
async fn the_snapshot_carries_the_dashboard_overview() {
    // The dashboard costs nothing extra because its counts ride on this
    // snapshot. Against any live cluster, once every source has listed,
    // there is at least one node with allocatable CPU and the kube-system
    // pods are counted.
    let session = live::session().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let monitors: &'static Monitors = Box::leak(Box::default());
    let id = start(&session, monitors, Thresholds::default(), Tx(tx))
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let overview = loop {
        let snap = tokio::time::timeout_at(deadline.into(), rx.recv())
            .await
            .expect("no snapshot with every source listed")
            .unwrap();
        if snap.sources.iter().all(|s| s.state == SourceState::Ready) {
            break snap.overview;
        }
    };
    monitors.stop(id).await;

    println!("{overview:#?}");
    assert!(overview.nodes.total >= 1);
    assert_eq!(overview.nodes.ready, overview.nodes.total);
    assert!(overview.capacity.cpu_allocatable > 0.0);
    assert!(overview.capacity.memory_allocatable > 0.0);
    assert!(
        overview.capacity.cpu_requested > 0.0,
        "kube-system requests CPU"
    );
    assert!(overview.pods.running > 0);
    assert!(overview
        .namespaces
        .iter()
        .any(|n| n.namespace == "kube-system"));
    assert!(overview
        .workloads
        .iter()
        .any(|w| w.kind == "Deployment" && w.total >= 1));
}
