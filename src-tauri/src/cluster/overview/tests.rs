use super::*;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::PersistentVolumeClaim;
use serde::de::DeserializeOwned;
use serde_json::json;

fn parse<T: DeserializeOwned>(v: serde_json::Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn node(name: &str, ready: bool, cordoned: bool, cpu: &str, memory: &str) -> Node {
    parse(json!({
        "metadata": { "name": name },
        "spec": { "unschedulable": cordoned },
        "status": {
            "allocatable": { "cpu": cpu, "memory": memory, "pods": "110" },
            "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }]
        }
    }))
}

fn pod(ns: &str, name: &str, phase: &str, node: Option<&str>, cpu: &str, memory: &str) -> Pod {
    parse(json!({
        "metadata": { "name": name, "namespace": ns },
        "spec": {
            "nodeName": node,
            "containers": [{
                "name": "app",
                "resources": { "requests": { "cpu": cpu, "memory": memory } }
            }]
        },
        "status": { "phase": phase }
    }))
}

fn restarting(ns: &str, name: &str, restarts: i32, waiting: Option<&str>) -> Pod {
    parse(json!({
        "metadata": { "name": name, "namespace": ns },
        "spec": { "containers": [{ "name": "app" }] },
        "status": {
            "phase": "Running",
            "containerStatuses": [{
                "name": "app",
                "image": "x",
                "imageID": "",
                "ready": false,
                "restartCount": restarts,
                "state": waiting.map_or(json!({ "running": {} }), |r| json!({ "waiting": { "reason": r } })),
                "lastState": { "terminated": { "exitCode": 137, "reason": "OOMKilled" } }
            }]
        }
    }))
}

#[test]
fn an_empty_store_is_all_zeroes() {
    let o = summarise(&Snapshot::default());
    assert_eq!(o.nodes, NodeCounts::default());
    assert_eq!(o.pods, PodCounts::default());
    assert_eq!(o.capacity, Capacity::default());
    assert!(o.restarts.is_empty() && o.namespaces.is_empty() && o.node_rows.is_empty());
    // Every kind is still listed, at zero, so the widget's rows do not
    // appear and disappear as a cluster gains its first CronJob.
    let kinds: Vec<_> = o.workloads.iter().map(|w| w.kind.as_str()).collect();
    assert_eq!(
        kinds,
        ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]
    );
}

#[test]
fn nodes_are_counted_by_readiness_and_cordon() {
    let a = node("a", true, false, "4", "8Gi");
    let b = node("b", true, true, "4", "8Gi");
    let c = node("c", false, false, "4", "8Gi");
    let o = summarise(&Snapshot {
        nodes: vec![&a, &b, &c],
        ..Default::default()
    });
    assert_eq!(
        o.nodes,
        NodeCounts {
            total: 3,
            ready: 2,
            cordoned: 1
        }
    );
}

#[test]
fn pods_are_counted_by_phase_and_a_crash_loop_is_called_out() {
    let running = pod("a", "r", "Running", Some("n"), "0", "0");
    let pending = pod("a", "p", "Pending", None, "0", "0");
    let done = pod("a", "s", "Succeeded", Some("n"), "0", "0");
    let failed = pod("a", "f", "Failed", Some("n"), "0", "0");
    let looping = restarting("a", "l", 9, Some("CrashLoopBackOff"));
    let o = summarise(&Snapshot {
        pods: vec![&running, &pending, &done, &failed, &looping],
        ..Default::default()
    });
    assert_eq!(o.pods.total, 5);
    // The crash loop is Running by phase — which is exactly why it is
    // counted separately.
    assert_eq!(o.pods.running, 2);
    assert_eq!(o.pods.pending, 1);
    assert_eq!(o.pods.succeeded, 1);
    assert_eq!(o.pods.failed, 1);
    assert_eq!(o.pods.crash_looping, 1);
}

#[test]
fn requests_are_summed_per_node_against_allocatable() {
    let n1 = node("n1", true, false, "4", "8Gi");
    let n2 = node("n2", true, false, "2", "4Gi");
    let a = pod("x", "a", "Running", Some("n1"), "500m", "1Gi");
    let b = pod("x", "b", "Running", Some("n1"), "1", "1Gi");
    let c = pod("x", "c", "Pending", Some("n2"), "250m", "512Mi");
    let o = summarise(&Snapshot {
        nodes: vec![&n1, &n2],
        pods: vec![&a, &b, &c],
        ..Default::default()
    });

    assert_eq!(o.capacity.cpu_allocatable, 6.0);
    assert_eq!(o.capacity.cpu_requested, 1.75);
    assert_eq!(o.capacity.memory_allocatable, 12.0 * 1024f64.powi(3));
    assert_eq!(o.capacity.memory_requested, 2.5 * 1024f64.powi(3));
    assert_eq!(o.capacity.pods_allocatable, 220);
    assert_eq!(o.capacity.pods_scheduled, 3);

    let n1_row = o.node_rows.iter().find(|r| r.name == "n1").unwrap();
    assert_eq!(n1_row.cpu_requested, 1.5);
    assert_eq!(n1_row.pods, 2);
}

#[test]
fn finished_and_unscheduled_pods_claim_nothing() {
    // A Succeeded pod still names its node, but holds no reservation;
    // counting it would show a node as full when it is empty.
    let n = node("n", true, false, "4", "8Gi");
    let done = pod("x", "done", "Succeeded", Some("n"), "2", "4Gi");
    let failed = pod("x", "failed", "Failed", Some("n"), "2", "4Gi");
    let waiting = pod("x", "waiting", "Pending", None, "2", "4Gi");
    let o = summarise(&Snapshot {
        nodes: vec![&n],
        pods: vec![&done, &failed, &waiting],
        ..Default::default()
    });
    assert_eq!(o.capacity.cpu_requested, 0.0);
    assert_eq!(o.capacity.pods_scheduled, 0);
}

#[test]
fn a_pod_on_a_node_not_in_the_store_still_counts_toward_nothing_visible() {
    // Nodes may be forbidden while pods are not. The pod's claim has no
    // row to land on, and the totals are only over rows that exist, so
    // the percentage is not a claim against zero allocatable.
    let a = pod("x", "a", "Running", Some("gone"), "1", "1Gi");
    let o = summarise(&Snapshot {
        pods: vec![&a],
        ..Default::default()
    });
    assert_eq!(o.capacity.cpu_requested, 0.0);
    assert!(o.node_rows.is_empty());
}

#[test]
fn workloads_count_healthy_by_what_each_kind_promises() {
    let ok: Deployment = parse(json!({
        "metadata": { "name": "ok", "namespace": "a" },
        "spec": { "replicas": 2, "selector": {}, "template": {} },
        "status": { "availableReplicas": 2 }
    }));
    let short: Deployment = parse(json!({
        "metadata": { "name": "short", "namespace": "a" },
        "spec": { "replicas": 3, "selector": {}, "template": {} },
        "status": { "availableReplicas": 1 }
    }));
    let scaled_to_zero: Deployment = parse(json!({
        "metadata": { "name": "zero", "namespace": "a" },
        "spec": { "replicas": 0, "selector": {}, "template": {} },
        "status": {}
    }));
    let sts: StatefulSet = parse(json!({
        "metadata": { "name": "db", "namespace": "a" },
        "spec": { "replicas": 1, "selector": {}, "template": {}, "serviceName": "db" },
        "status": { "replicas": 1, "availableReplicas": 0 }
    }));
    let ds: DaemonSet = parse(json!({
        "metadata": { "name": "agent", "namespace": "a" },
        "spec": { "selector": {}, "template": {} },
        "status": {
            "desiredNumberScheduled": 3, "numberAvailable": 3,
            "currentNumberScheduled": 3, "numberMisscheduled": 0, "numberReady": 3
        }
    }));
    let failed_job: Job = parse(json!({
        "metadata": { "name": "migrate", "namespace": "a" },
        "spec": { "template": {} },
        "status": { "conditions": [{ "type": "Failed", "status": "True" }] }
    }));
    let ok_job: Job = parse(json!({
        "metadata": { "name": "seed", "namespace": "a" },
        "spec": { "template": {} },
        "status": { "succeeded": 1 }
    }));
    let suspended: CronJob = parse(json!({
        "metadata": { "name": "nightly", "namespace": "a" },
        "spec": { "schedule": "0 0 * * *", "suspend": true, "jobTemplate": {} }
    }));

    let o = summarise(&Snapshot {
        deployments: vec![&ok, &short, &scaled_to_zero],
        statefulsets: vec![&sts],
        daemonsets: vec![&ds],
        jobs: vec![&failed_job, &ok_job],
        cronjobs: vec![&suspended],
        ..Default::default()
    });
    let get = |kind: &str| o.workloads.iter().find(|w| w.kind == kind).unwrap();

    // Scaled to zero is doing what it was asked.
    assert_eq!((get("Deployment").healthy, get("Deployment").total), (2, 3));
    assert_eq!(
        (get("StatefulSet").healthy, get("StatefulSet").total),
        (0, 1)
    );
    assert_eq!((get("DaemonSet").healthy, get("DaemonSet").total), (1, 1));
    assert_eq!((get("Job").healthy, get("Job").total), (1, 2));
    assert_eq!((get("CronJob").healthy, get("CronJob").total), (0, 1));
}

#[test]
fn restarts_rank_worst_first_and_keep_the_last_reason() {
    let pods: Vec<Pod> = (1..=7)
        .map(|i| restarting("shop", &format!("p{i}"), i * 3, None))
        .collect();
    let calm = restarting("shop", "calm", 0, None);
    let mut refs: Vec<&Pod> = pods.iter().collect();
    refs.push(&calm);

    let o = summarise(&Snapshot {
        pods: refs,
        ..Default::default()
    });
    assert_eq!(o.restarts.len(), TOP);
    assert_eq!(o.restarts[0].pod, "p7");
    assert_eq!(o.restarts[0].restarts, 21);
    assert_eq!(o.restarts[0].last_reason.as_deref(), Some("OOMKilled"));
    assert!(o.restarts.iter().all(|r| r.pod != "calm"));
}

#[test]
fn namespaces_rank_by_pod_count_and_count_all_of_them() {
    let pods: Vec<Pod> = [
        ("big", 4),
        ("mid", 2),
        ("a", 1),
        ("b", 1),
        ("c", 1),
        ("d", 1),
    ]
    .iter()
    .flat_map(|(ns, n)| (0..*n).map(move |i| pod(ns, &format!("p{i}"), "Running", None, "0", "0")))
    .collect();
    let o = summarise(&Snapshot {
        pods: pods.iter().collect(),
        ..Default::default()
    });
    assert_eq!(o.namespace_count, 6);
    assert_eq!(o.namespaces.len(), TOP);
    assert_eq!(o.namespaces[0].namespace, "big");
    assert_eq!(o.namespaces[0].pods, 4);
    // Ties break by name, so a quiet cluster's list does not reshuffle.
    let tail: Vec<_> = o.namespaces[2..]
        .iter()
        .map(|r| r.namespace.as_str())
        .collect();
    assert_eq!(tail, ["a", "b", "c"]);
}

#[test]
fn claims_are_counted_by_phase() {
    let claim = |name: &str, phase: Option<&str>| -> PersistentVolumeClaim {
        parse(json!({
            "metadata": { "name": name, "namespace": "a" },
            "spec": {},
            "status": phase.map_or(json!({}), |p| json!({ "phase": p }))
        }))
    };
    let (a, b, c, d) = (
        claim("a", Some("Bound")),
        claim("b", Some("Pending")),
        claim("c", Some("Lost")),
        claim("d", None),
    );
    let o = summarise(&Snapshot {
        pvcs: vec![&a, &b, &c, &d],
        ..Default::default()
    });
    assert_eq!(
        o.claims,
        ClaimCounts {
            total: 4,
            bound: 1,
            pending: 2,
            lost: 1
        }
    );
}

#[test]
fn serialises_the_way_the_frontend_reads_it() {
    // A contract with src/lib/api.ts.
    let n = node("n", true, false, "4", "8Gi");
    let json = serde_json::to_value(summarise(&Snapshot {
        nodes: vec![&n],
        ..Default::default()
    }))
    .unwrap();
    assert_eq!(json["nodes"]["total"], 1);
    assert_eq!(json["capacity"]["cpuAllocatable"], 4.0);
    assert_eq!(
        json["nodeRows"][0]["memoryAllocatable"],
        8.0 * 1024f64.powi(3)
    );
    assert_eq!(json["pods"]["crashLooping"], 0);
    assert_eq!(json["namespaceCount"], 0);
}
