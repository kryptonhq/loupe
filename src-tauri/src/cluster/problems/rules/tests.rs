use super::*;
use serde_json::json;

/// A fixed "now", so ages in messages are stable.
const NOW: i64 = 1_800_000_000;

fn at(seconds_ago: i64) -> String {
    k8s_openapi::jiff::Timestamp::from_second(NOW - seconds_ago)
        .unwrap()
        .to_string()
}

fn parse<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
    serde_json::from_value(value).expect("fixture parses as the API type")
}

fn run<'a>(build: impl FnOnce(&mut Snapshot<'a>)) -> Vec<Problem> {
    let mut snapshot = Snapshot::default();
    build(&mut snapshot);
    evaluate(&snapshot, NOW, Thresholds::default())
}

fn reasons(rows: &[Problem]) -> Vec<&str> {
    rows.iter().map(|r| r.reason.as_str()).collect()
}

fn pod(name: &str, created_ago: i64, status: serde_json::Value) -> Pod {
    parse(json!({
        "metadata": { "name": name, "namespace": "shop", "creationTimestamp": at(created_ago) },
        "spec": { "containers": [{ "name": "app", "image": "shop:1" }] },
        "status": status,
    }))
}

// ---------------------------------------------------------------- pods

#[test]
fn a_crash_looping_container_is_critical_and_names_the_exit_code() {
    let p = pod(
        "api-1",
        600,
        json!({
            "phase": "Running",
            "startTime": at(600),
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": false, "restartCount": 7,
                "state": { "waiting": { "reason": "CrashLoopBackOff" } },
                "lastState": { "terminated": { "exitCode": 1, "reason": "Error", "finishedAt": at(30) } }
            }],
            "conditions": [{ "type": "Ready", "status": "False", "lastTransitionTime": at(590) }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);

    assert_eq!(
        reasons(&rows),
        ["CrashLoopBackOff"],
        "one row, not also NotReady or Restarting"
    );
    assert_eq!(rows[0].severity, Severity::Critical);
    assert!(
        rows[0].message.contains("exit code 1 (Error)"),
        "{}",
        rows[0].message
    );
    assert!(rows[0].message.contains("7 restarts"));
    assert_eq!(rows[0].target.as_ref().unwrap().kind, "Pod");
}

#[test]
fn a_bad_image_is_reported_with_the_image_reference() {
    let p = pod(
        "web-1",
        20,
        json!({
            "phase": "Pending",
            "containerStatuses": [{
                "name": "app", "image": "registry.example/shop:nope", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "waiting": { "reason": "ImagePullBackOff", "message": "Back-off pulling image" } }
            }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);

    // No grace period: an image that cannot be pulled will not start
    // being pullable by waiting two minutes.
    assert_eq!(reasons(&rows), ["ImagePullBackOff"]);
    assert!(rows[0].message.contains("registry.example/shop:nope"));
    assert_eq!(rows[0].severity, Severity::Critical);
}

#[test]
fn an_unschedulable_pod_carries_the_schedulers_reason_after_the_grace_period() {
    let status = json!({
        "phase": "Pending",
        "conditions": [{
            "type": "PodScheduled", "status": "False", "reason": "Unschedulable",
            "message": "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.",
            "lastTransitionTime": at(300)
        }]
    });
    let fresh = pod("fresh", 30, status.clone());
    let stuck = pod("stuck", 300, status);
    let rows = run(|s| s.pods = vec![&fresh, &stuck]);

    assert_eq!(rows.len(), 1, "a pod pending for 30s is still starting");
    assert_eq!(rows[0].reason, "Unschedulable");
    assert!(rows[0]
        .message
        .contains("didn't match Pod's node affinity/selector"));
    assert_eq!(rows[0].target.as_ref().unwrap().name, "stuck");
}

#[test]
fn oom_killed_on_last_termination_is_a_warning() {
    let p = pod(
        "worker",
        3000,
        json!({
            "phase": "Running",
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": true, "restartCount": 1,
                "state": { "running": {} },
                "lastState": { "terminated": { "exitCode": 137, "reason": "OOMKilled", "finishedAt": at(100) } }
            }],
            "conditions": [{ "type": "Ready", "status": "True", "lastTransitionTime": at(90) }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);
    assert_eq!(reasons(&rows), ["OOMKilled"]);
    assert_eq!(rows[0].severity, Severity::Warning);
}

#[test]
fn restarts_count_only_above_the_threshold_and_only_while_recent() {
    let restarting = |name: &str, count: i32, finished_ago: i64| {
        pod(
            name,
            90_000,
            json!({
                "phase": "Running",
                "containerStatuses": [{
                    "name": "app", "image": "shop:1", "imageID": "", "ready": true, "restartCount": count,
                    "state": { "running": {} },
                    "lastState": { "terminated": { "exitCode": 2, "finishedAt": at(finished_ago) } }
                }],
                "conditions": [{ "type": "Ready", "status": "True", "lastTransitionTime": at(60) }]
            }),
        )
    };
    let flapping = restarting("flapping", 6, 120);
    let below = restarting("below", 4, 120);
    let old = restarting("long-ago", 50, 7200);
    let rows = run(|s| s.pods = vec![&flapping, &below, &old]);

    assert_eq!(reasons(&rows), ["Restarting"]);
    assert_eq!(rows[0].target.as_ref().unwrap().name, "flapping");
}

#[test]
fn a_running_pod_not_ready_past_the_grace_period_names_its_containers() {
    let p = pod(
        "slow",
        1000,
        json!({
            "phase": "Running",
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "running": {} }
            }],
            "conditions": [{ "type": "Ready", "status": "False", "lastTransitionTime": at(200) }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);
    assert_eq!(reasons(&rows), ["NotReady"]);
    assert!(
        rows[0].message.contains("`app` not ready"),
        "{}",
        rows[0].message
    );
}

#[test]
fn completed_and_terminating_pods_are_not_problems() {
    let done = pod("done", 5000, json!({ "phase": "Succeeded" }));
    let mut leaving = pod("leaving", 5000, json!({ "phase": "Pending" }));
    leaving.metadata.deletion_timestamp = Some(parse(json!(at(10))));
    assert!(run(|s| s.pods = vec![&done, &leaving]).is_empty());
}

// ----------------------------------------------------------- workloads

#[test]
fn a_deployment_short_of_replicas_uses_the_available_condition_for_its_age() {
    let d: Deployment = parse(json!({
        "metadata": { "name": "web", "namespace": "shop" },
        "spec": { "replicas": 3, "selector": {}, "template": {} },
        "status": {
            "availableReplicas": 0,
            "conditions": [{ "type": "Available", "status": "False", "lastTransitionTime": at(400) }]
        }
    }));
    let rows = run(|s| s.deployments = vec![&d]);
    assert_eq!(reasons(&rows), ["ReplicasUnavailable"]);
    assert_eq!(
        rows[0].severity,
        Severity::Critical,
        "none available is down, not degraded"
    );
    assert!(rows[0].message.starts_with("0 of 3 replicas available"));
}

#[test]
fn a_rollout_within_the_grace_period_is_not_a_problem() {
    let d: Deployment = parse(json!({
        "metadata": { "name": "web", "namespace": "shop" },
        "spec": { "replicas": 3, "selector": {}, "template": {} },
        "status": {
            "availableReplicas": 2,
            "conditions": [{ "type": "Available", "status": "False", "lastTransitionTime": at(30) }]
        }
    }));
    assert!(run(|s| s.deployments = vec![&d]).is_empty());
}

#[test]
fn a_stalled_rollout_is_critical_whatever_is_available() {
    let d: Deployment = parse(json!({
        "metadata": { "name": "web", "namespace": "shop" },
        "spec": { "replicas": 2, "selector": {}, "template": {} },
        "status": {
            "availableReplicas": 2,
            "conditions": [{
                "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded",
                "message": "ReplicaSet \"web-7d\" has timed out progressing.", "lastUpdateTime": at(900)
            }]
        }
    }));
    let rows = run(|s| s.deployments = vec![&d]);
    assert_eq!(reasons(&rows), ["ProgressDeadlineExceeded"]);
}

#[test]
fn a_statefulset_waits_on_the_remembered_first_sighting() {
    let s: StatefulSet = parse(json!({
        "metadata": { "name": "db", "namespace": "shop" },
        "spec": { "replicas": 3, "selector": {}, "template": {}, "serviceName": "db" },
        "status": { "replicas": 3, "availableReplicas": 1 }
    }));
    let mut degraded = HashMap::new();

    let snapshot = |degraded: &HashMap<String, i64>| {
        let snap = Snapshot {
            statefulsets: vec![&s],
            degraded_since: degraded,
            ..Default::default()
        };
        evaluate(&snap, NOW, Thresholds::default())
    };

    // Never seen degraded before: nothing to measure the grace period from.
    assert!(snapshot(&degraded).is_empty());

    degraded.insert("StatefulSet/shop/db".to_string(), NOW - 10);
    assert!(
        snapshot(&degraded).is_empty(),
        "degraded for 10s is a rollout"
    );

    degraded.insert("StatefulSet/shop/db".to_string(), NOW - 600);
    let rows = snapshot(&degraded);
    assert_eq!(reasons(&rows), ["ReplicasUnavailable"]);
    assert_eq!(
        rows[0].severity,
        Severity::Warning,
        "one of three is degraded, not down"
    );
}

#[test]
fn a_failed_job_and_the_cronjob_whose_last_run_it_was() {
    let cj: CronJob = parse(json!({
        "metadata": { "name": "nightly", "namespace": "ops", "uid": "cj-uid" },
        "spec": { "schedule": "0 0 * * *", "jobTemplate": {} }
    }));
    let job = |name: &str, created_ago: i64, failed: bool| -> Job {
        parse(json!({
            "metadata": {
                "name": name, "namespace": "ops", "creationTimestamp": at(created_ago),
                "ownerReferences": [{ "apiVersion": "batch/v1", "kind": "CronJob", "name": "nightly", "uid": "cj-uid" }]
            },
            "spec": { "template": {} },
            "status": { "conditions": if failed {
                json!([{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded", "lastTransitionTime": at(created_ago - 60) }])
            } else {
                json!([{ "type": "Complete", "status": "True" }])
            }}
        }))
    };

    // The older run failed; the newer succeeded. The CronJob is healthy.
    let old_failed = job("nightly-1", 90_000, true);
    let new_ok = job("nightly-2", 3_600, false);
    let rows = run(|s| {
        s.cronjobs = vec![&cj];
        s.jobs = vec![&old_failed, &new_ok];
    });
    assert_eq!(
        reasons(&rows),
        ["JobFailed"],
        "the old Job is still failed; the CronJob is not"
    );

    // The newest run failed.
    let new_failed = job("nightly-3", 600, true);
    let rows = run(|s| {
        s.cronjobs = vec![&cj];
        s.jobs = vec![&new_ok, &new_failed];
    });
    assert!(reasons(&rows).contains(&"LastRunFailed"));
    let cron = rows.iter().find(|r| r.reason == "LastRunFailed").unwrap();
    assert!(cron.message.contains("nightly-3"));
    assert!(cron.message.contains("BackoffLimitExceeded"));
}

// --------------------------------------------------------------- nodes

fn node(name: &str, extra: serde_json::Value) -> Node {
    let mut base = json!({ "metadata": { "name": name, "labels": { "zone": "a" } }, "spec": {}, "status": {} });
    merge(&mut base, extra);
    parse(base)
}

fn merge(a: &mut serde_json::Value, b: serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b,
    }
}

#[test]
fn node_readiness_pressure_and_cordon() {
    let n = node(
        "worker-1",
        json!({
            "spec": { "unschedulable": true },
            "status": { "conditions": [
                { "type": "Ready", "status": "Unknown", "message": "Kubelet stopped posting node status.", "lastTransitionTime": at(500) },
                { "type": "DiskPressure", "status": "True", "lastTransitionTime": at(800) },
                { "type": "MemoryPressure", "status": "False" }
            ]}
        }),
    );
    let rows = run(|s| s.nodes = vec![&n]);
    let mut got = reasons(&rows);
    got.sort();
    assert_eq!(got, ["DiskPressure", "NotReady", "Unschedulable"]);
    let ready = rows.iter().find(|r| r.reason == "NotReady").unwrap();
    assert_eq!(ready.severity, Severity::Critical);
    assert!(ready.message.contains("Kubelet stopped posting"));
}

#[test]
fn a_taint_is_blamed_only_for_the_pending_pods_it_actually_blocks() {
    let tainted = node(
        "gpu-1",
        json!({ "spec": { "taints": [{ "key": "gpu", "value": "true", "effect": "NoSchedule" }] } }),
    );
    let unschedulable = |name: &str, spec: serde_json::Value| -> Pod {
        let mut p = json!({
            "metadata": { "name": name, "namespace": "ml", "creationTimestamp": at(10) },
            "spec": { "containers": [{ "name": "app" }] },
            "status": { "phase": "Pending", "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable" }] }
        });
        merge(&mut p, json!({ "spec": spec }));
        parse(p)
    };
    let blocked_a = unschedulable("a", json!({}));
    let blocked_b = unschedulable("b", json!({}));
    let tolerating = unschedulable(
        "c",
        json!({ "tolerations": [{ "key": "gpu", "operator": "Exists" }] }),
    );
    let elsewhere = unschedulable("d", json!({ "nodeSelector": { "zone": "b" } }));

    let rows = run(|s| {
        s.nodes = vec![&tainted];
        s.pods = vec![&blocked_a, &blocked_b, &tolerating, &elsewhere];
    });
    let taint = rows
        .iter()
        .find(|r| r.reason == "TaintBlocksPods")
        .expect("a taint row");
    assert_eq!(
        taint.count,
        Some(2),
        "not c (tolerates), not d (selector excludes the node)"
    );
    assert!(taint.message.contains("gpu=true:NoSchedule"));
}

#[test]
fn toleration_matching_follows_kubernetes() {
    let taint = Taint {
        key: "dedicated".into(),
        value: Some("db".into()),
        effect: "NoSchedule".into(),
        time_added: None,
    };
    let tol = |v: serde_json::Value| -> Toleration { parse(v) };

    assert!(
        tolerates(&tol(json!({ "operator": "Exists" })), &taint),
        "empty key + Exists tolerates all"
    );
    assert!(tolerates(
        &tol(json!({ "key": "dedicated", "operator": "Exists" })),
        &taint
    ));
    assert!(
        tolerates(&tol(json!({ "key": "dedicated", "value": "db" })), &taint),
        "Equal is the default"
    );
    assert!(!tolerates(
        &tol(json!({ "key": "dedicated", "value": "web" })),
        &taint
    ));
    assert!(!tolerates(
        &tol(json!({ "key": "dedicated", "operator": "Exists", "effect": "NoExecute" })),
        &taint
    ));
    assert!(!tolerates(
        &tol(json!({ "key": "other", "operator": "Exists" })),
        &taint
    ));
    assert!(
        !tolerates(&tol(json!({})), &taint),
        "an empty key with Equal tolerates nothing"
    );
}

// -------------------------------------------------------------- events

fn warning(name: &str, reason: &str, ago: i64, count: i32) -> Event {
    parse(json!({
        "metadata": { "name": format!("{name}.{ago}"), "namespace": "shop" },
        "involvedObject": { "apiVersion": "v1", "kind": "Pod", "name": name, "namespace": "shop" },
        "type": "Warning",
        "reason": reason,
        "message": format!("{reason} message at {ago}"),
        "count": count,
        "lastTimestamp": at(ago)
    }))
}

#[test]
fn forty_identical_warning_events_are_one_row_with_a_count() {
    let events: Vec<Event> = (0..40)
        .map(|i| warning("api-1", "FailedScheduling", 60 + i, 1))
        .collect();
    let rows = run(|s| s.events = events.iter().collect());

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].count, Some(40));
    assert_eq!(rows[0].severity, Severity::Info);
    // The message and age come from the most recent occurrence.
    assert_eq!(rows[0].since, Some(NOW - 60));
    assert!(rows[0].message.contains("at 60"));
}

#[test]
fn event_counts_are_summed_and_old_or_normal_events_ignored() {
    let recent = warning("api-1", "BackOff", 120, 12);
    let another = warning("api-1", "BackOff", 200, 3);
    let different_reason = warning("api-1", "Unhealthy", 120, 1);
    let stale = warning("api-1", "Failed", 4000, 1);
    let mut normal = warning("api-1", "Pulled", 10, 1);
    normal.type_ = Some("Normal".into());

    let rows = run(|s| s.events = vec![&recent, &another, &different_reason, &stale, &normal]);
    let mut got: Vec<(&str, Option<u32>)> =
        rows.iter().map(|r| (r.reason.as_str(), r.count)).collect();
    got.sort();
    assert_eq!(got, [("BackOff", Some(15)), ("Unhealthy", Some(1))]);
}

#[test]
fn an_event_about_a_custom_resource_routes_to_its_group() {
    let mut e = warning("cert", "Failed", 30, 1);
    e.involved_object.api_version = Some("cert-manager.io/v1".into());
    e.involved_object.kind = Some("Certificate".into());
    let rows = run(|s| s.events = vec![&e]);
    let t = rows[0].target.as_ref().unwrap();
    assert_eq!(
        (t.group.as_str(), t.version.as_str(), t.kind.as_str()),
        ("cert-manager.io", "v1", "Certificate")
    );
}

// ------------------------------------------------------------- storage

#[test]
fn a_claim_pending_past_the_grace_period() {
    let claim = |name: &str, ago: i64| -> PersistentVolumeClaim {
        parse(json!({
            "metadata": { "name": name, "namespace": "shop", "creationTimestamp": at(ago) },
            "spec": { "storageClassName": "fast" },
            "status": { "phase": "Pending" }
        }))
    };
    let fresh = claim("fresh", 20);
    let stuck = claim("stuck", 400);
    let rows = run(|s| s.pvcs = vec![&fresh, &stuck]);
    assert_eq!(reasons(&rows), ["ClaimPending"]);
    assert!(rows[0].message.contains("`fast`"));
}

// ------------------------------------------------------------ ordering

#[test]
fn rows_are_worst_first_then_oldest_first() {
    let crash = pod(
        "crash",
        100,
        json!({
            "phase": "Running", "startTime": at(100),
            "containerStatuses": [{ "name": "app", "image": "x", "imageID": "", "ready": false, "restartCount": 3,
                "state": { "waiting": { "reason": "CrashLoopBackOff" } } }]
        }),
    );
    let old_warning = warning("x", "BackOff", 3000, 1);
    let new_warning = warning("y", "BackOff", 10, 1);
    let stuck: PersistentVolumeClaim = parse(json!({
        "metadata": { "name": "c", "namespace": "shop", "creationTimestamp": at(5000) },
        "status": { "phase": "Pending" }
    }));
    let rows = run(|s| {
        s.pods = vec![&crash];
        s.events = vec![&new_warning, &old_warning];
        s.pvcs = vec![&stuck];
    });
    let order: Vec<(Severity, &str)> = rows
        .iter()
        .map(|r| (r.severity, r.reason.as_str()))
        .collect();
    assert_eq!(
        order,
        [
            (Severity::Critical, "CrashLoopBackOff"),
            (Severity::Warning, "ClaimPending"),
            (Severity::Info, "BackOff"),
            (Severity::Info, "BackOff"),
        ]
    );
    assert_eq!(rows[2].since, Some(NOW - 3000), "the older event first");
}

#[test]
fn a_problem_serialises_as_the_frontend_reads_it() {
    let p = Problem {
        id: "Pod/shop/api/CrashLoopBackOff/app".into(),
        severity: Severity::Critical,
        category: Category::Pods,
        target: Some(Target {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            namespace: Some("shop".into()),
            name: "api".into(),
        }),
        reason: "CrashLoopBackOff".into(),
        message: "m".into(),
        since: Some(1),
        count: None,
    };
    let json = serde_json::to_value(&p).unwrap();
    assert_eq!(json["severity"], "critical");
    assert_eq!(json["category"], "pods");
    assert_eq!(json["target"]["kind"], "Pod");
    assert!(json["count"].is_null());
}

#[test]
fn messages_are_single_line_and_bounded() {
    assert_eq!(
        one_line("0/3 nodes\n  are available:\n\t3 Insufficient cpu."),
        "0/3 nodes are available: 3 Insufficient cpu."
    );
    let long = "x ".repeat(500);
    assert!(one_line(&long).chars().count() <= 301);
}

// ------------------------------------------------------ remaining paths

#[test]
fn a_container_that_cannot_start_names_the_missing_config() {
    let p = pod(
        "cfg",
        30,
        json!({
            "phase": "Pending",
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "waiting": { "reason": "CreateContainerConfigError", "message": "configmap \"settings\" not found" } }
            }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);
    assert_eq!(reasons(&rows), ["CreateContainerConfigError"]);
    assert_eq!(rows[0].severity, Severity::Critical);
    assert!(rows[0].message.contains("configmap \"settings\" not found"));
}

#[test]
fn a_crash_loop_with_no_recorded_termination_still_reads() {
    let p = pod(
        "fresh-crash",
        60,
        json!({
            "phase": "Running",
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": false, "restartCount": 1,
                "state": { "waiting": { "reason": "CrashLoopBackOff" } }
            }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);
    assert!(rows[0].message.contains("no termination recorded"));
    assert!(
        rows[0].message.contains("1 restart"),
        "singular: {}",
        rows[0].message
    );
    assert!(!rows[0].message.contains("1 restarts"));
}

#[test]
fn a_scheduled_pod_stuck_pending_says_what_it_is_waiting_on() {
    let waiting = pod(
        "creating",
        600,
        json!({
            "phase": "Pending",
            "conditions": [{ "type": "PodScheduled", "status": "True" }],
            "containerStatuses": [{
                "name": "app", "image": "shop:1", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "waiting": { "reason": "ContainerCreating" } }
            }]
        }),
    );
    let silent = pod("silent", 600, json!({ "phase": "Pending" }));
    let rows = run(|s| s.pods = vec![&waiting, &silent]);
    let messages: Vec<&str> = rows.iter().map(|r| r.message.as_str()).collect();
    assert!(
        messages.contains(&"Pending for 10m: ContainerCreating"),
        "{messages:?}"
    );
    assert!(messages.contains(&"Pending for 10m"), "{messages:?}");
}

#[test]
fn a_failed_pod_carries_its_reason() {
    let evicted = pod(
        "evicted",
        900,
        json!({ "phase": "Failed", "reason": "Evicted", "message": "The node was low on resource: memory." }),
    );
    let bare = pod("bare", 900, json!({ "phase": "Failed" }));
    let rows = run(|s| s.pods = vec![&evicted, &bare]);
    let by_name = |n: &str| {
        rows.iter()
            .find(|r| r.target.as_ref().unwrap().name == n)
            .unwrap()
    };
    assert_eq!(by_name("evicted").reason, "Evicted");
    assert!(by_name("evicted").message.contains("low on resource"));
    assert_eq!(by_name("bare").message, "Failed");
}

#[test]
fn a_running_pod_not_ready_without_container_detail() {
    let p = pod(
        "gate",
        1000,
        json!({
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "False", "lastTransitionTime": at(300) }]
        }),
    );
    let rows = run(|s| s.pods = vec![&p]);
    assert_eq!(rows[0].message, "Not ready for 5m");
}

#[test]
fn a_daemonset_short_of_its_nodes_after_the_grace_period() {
    let d: DaemonSet = parse(json!({
        "metadata": { "name": "agent", "namespace": "kube-system" },
        "spec": { "selector": {}, "template": {} },
        "status": { "desiredNumberScheduled": 3, "numberAvailable": 2, "currentNumberScheduled": 3, "numberMisscheduled": 0, "numberReady": 2 }
    }));
    let mut degraded = HashMap::new();
    degraded.insert("DaemonSet/kube-system/agent".to_string(), NOW - 300);
    let snap = Snapshot {
        daemonsets: vec![&d],
        degraded_since: &degraded,
        ..Default::default()
    };
    let rows = evaluate(&snap, NOW, Thresholds::default());
    assert_eq!(reasons(&rows), ["ReplicasUnavailable"]);
    assert!(rows[0].message.starts_with("2 of 3 replicas available"));
    assert_eq!(is_degraded(&snap), ["DaemonSet/kube-system/agent"]);
}

#[test]
fn a_deployment_without_an_available_condition_falls_back_to_first_sighting() {
    let d: Deployment = parse(json!({
        "metadata": { "name": "web", "namespace": "shop" },
        "spec": { "replicas": 1, "selector": {}, "template": {} },
        "status": {}
    }));
    let mut degraded = HashMap::new();
    let eval = |degraded: &HashMap<String, i64>| {
        let snap = Snapshot {
            deployments: vec![&d],
            degraded_since: degraded,
            ..Default::default()
        };
        (
            evaluate(&snap, NOW, Thresholds::default()),
            is_degraded(&snap),
        )
    };
    let (rows, keys) = eval(&degraded);
    assert!(rows.is_empty());
    assert_eq!(keys, ["Deployment/shop/web"]);

    degraded.insert("Deployment/shop/web".to_string(), NOW - 200);
    let (rows, _) = eval(&degraded);
    assert_eq!(rows[0].message, "0 of 1 replica available for 3m");
}

#[test]
fn a_suspended_cronjob_is_not_judged_by_its_last_run() {
    let cj: CronJob = parse(json!({
        "metadata": { "name": "paused", "namespace": "ops", "uid": "u" },
        "spec": { "schedule": "* * * * *", "suspend": true, "jobTemplate": {} }
    }));
    let job: Job = parse(json!({
        "metadata": { "name": "paused-1", "namespace": "ops",
            "ownerReferences": [{ "apiVersion": "batch/v1", "kind": "CronJob", "name": "paused", "uid": "u" }] },
        "spec": { "template": {} },
        "status": { "conditions": [{ "type": "Failed", "status": "True" }] }
    }));
    let rows = run(|s| {
        s.cronjobs = vec![&cj];
        s.jobs = vec![&job];
    });
    assert_eq!(
        reasons(&rows),
        ["JobFailed"],
        "the Job still failed; the suspended CronJob is not flagged"
    );
}

#[test]
fn memory_and_pid_pressure_read_differently() {
    let n = node(
        "worker-2",
        json!({ "status": { "conditions": [
            { "type": "Ready", "status": "True" },
            { "type": "MemoryPressure", "status": "True", "message": "kubelet has insufficient memory" },
            { "type": "PIDPressure", "status": "True" }
        ]}}),
    );
    let rows = run(|s| s.nodes = vec![&n]);
    let message = |r: &str| rows.iter().find(|p| p.reason == r).unwrap().message.clone();
    assert_eq!(
        message("MemoryPressure"),
        "Node is short of memory: kubelet has insufficient memory"
    );
    assert_eq!(message("PIDPressure"), "Node is short of process IDs");
}

#[test]
fn a_cordoned_node_is_not_also_blamed_for_its_cordon_taint() {
    let n = node(
        "cordoned",
        json!({ "spec": { "unschedulable": true, "taints": [
            { "key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule", "timeAdded": at(600) },
            { "key": "maintenance", "effect": "PreferNoSchedule" }
        ]}}),
    );
    let pending: Pod = parse(json!({
        "metadata": { "name": "p", "namespace": "x" },
        "spec": { "containers": [{ "name": "c" }] },
        "status": { "phase": "Pending", "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable" }] }
    }));
    let rows = run(|s| {
        s.nodes = vec![&n];
        s.pods = vec![&pending];
    });
    assert!(
        !rows.iter().any(|r| r.reason == "TaintBlocksPods"),
        "{:?}",
        reasons(&rows)
    );
    let cordon = rows
        .iter()
        .find(|r| r.reason == "Unschedulable" && r.category == Category::Nodes)
        .unwrap();
    assert_eq!(cordon.since, Some(NOW - 600));
}

#[test]
fn a_taint_without_a_value_prints_without_one() {
    let n = node(
        "n",
        json!({ "spec": { "taints": [{ "key": "dedicated", "effect": "NoExecute" }] } }),
    );
    let pending: Pod = parse(json!({
        "metadata": { "name": "p", "namespace": "x" },
        "spec": { "containers": [{ "name": "c" }] },
        "status": { "phase": "Pending", "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable" }] }
    }));
    let rows = run(|s| {
        s.nodes = vec![&n];
        s.pods = vec![&pending];
    });
    let row = rows.iter().find(|r| r.reason == "TaintBlocksPods").unwrap();
    assert_eq!(
        row.message,
        "Taint `dedicated:NoExecute` is not tolerated by 1 pending pod"
    );
}

#[test]
fn an_event_with_no_subject_cannot_be_opened_and_uses_series_counts() {
    let e: Event = parse(json!({
        "metadata": { "name": "e", "namespace": "shop", "creationTimestamp": at(30) },
        "involvedObject": {},
        "type": "Warning",
        "reason": "Mystery",
        "series": { "count": 7, "lastObservedTime": format!("{}", at(20).replace('Z', ".000000Z")) }
    }));
    let rows = run(|s| s.events = vec![&e]);
    assert!(rows[0].target.is_none());
    assert_eq!(rows[0].count, Some(7));
    assert_eq!(
        rows[0].message, "Mystery",
        "the reason stands in for a missing message"
    );
    assert_eq!(rows[0].since, Some(NOW - 20));
}
