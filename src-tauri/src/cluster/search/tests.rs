use super::*;
use crate::cluster::table::{TableColumn, TableRow};

fn info(group: &str, kind: &str, namespaced: bool) -> ApiResourceInfo {
    ApiResourceInfo {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        plural: format!("{}s", kind.to_lowercase()),
        api_version: if group.is_empty() {
            "v1".into()
        } else {
            format!("{group}/v1")
        },
        namespaced,
        verbs: vec!["list".into()],
        custom: false,
    }
}

fn table(columns: &[&str], rows: &[(&str, Option<&str>, &[&str])]) -> ResourceTable {
    ResourceTable {
        columns: columns
            .iter()
            .map(|c| TableColumn {
                name: c.to_string(),
                priority: 0,
                description: None,
            })
            .collect(),
        rows: rows
            .iter()
            .map(|(name, ns, cells)| TableRow {
                name: name.to_string(),
                namespace: ns.map(str::to_string),
                cells: cells.iter().map(|c| c.to_string()).collect(),
            })
            .collect(),
        namespaced: true,
        continue_token: None,
        remaining: None,
    }
}

fn api_error(code: u16) -> kube::Error {
    kube::Error::Api(Box::new(
        serde_json::from_value(serde_json::json!({
            "status": "Failure", "code": code, "reason": "x", "message": "m"
        }))
        .unwrap(),
    ))
}

/// An index with some kinds already recorded.
fn indexed(context: &str, entries: Vec<(ApiResourceInfo, ResourceTable)>) -> Data {
    let mut data = Data {
        context: context.into(),
        ..Data::default()
    };
    let now = Instant::now();
    for (i, t) in entries {
        data.total += 1;
        record(&mut data, Arc::new(i), Ok(vec![t]), now);
    }
    data
}

fn names(r: &SearchResponse) -> Vec<String> {
    r.hits
        .iter()
        .map(|h| format!("{}/{}", h.kind, h.name))
        .collect()
}

// ---------------------------------------------------------------- plan

#[test]
fn the_everyday_kinds_are_indexed_first_and_events_never() {
    let mut data = Data::default();
    let kinds = vec![
        info("cert-manager.io", "Certificate", true),
        info("", "Event", true),
        info("events.k8s.io", "Event", true),
        info("", "Secret", true),
        info("apps", "Deployment", true),
        info("", "Pod", true),
        info("", "Node", false),
    ];
    plan(&mut data, &kinds, Instant::now());

    let order: Vec<&str> = data.queue.iter().map(|k| k.kind.as_str()).collect();
    assert_eq!(
        order,
        ["Pod", "Deployment", "Secret", "Certificate", "Node"]
    );
    assert_eq!(data.total, 5, "events are not counted as kinds to index");
}

#[test]
fn planning_twice_does_not_queue_a_kind_twice() {
    let mut data = Data::default();
    let kinds = vec![info("", "Pod", true)];
    plan(&mut data, &kinds, Instant::now());
    plan(&mut data, &kinds, Instant::now());
    assert_eq!(data.queue.len(), 1);

    // Nor while it is being listed.
    let taken = data.queue.pop_front().unwrap();
    data.in_flight.insert(key_of(&taken));
    plan(&mut data, &kinds, Instant::now());
    assert!(data.queue.is_empty());
}

#[test]
fn a_forbidden_kind_is_not_retried_and_a_failed_one_is_after_a_while() {
    let mut data = Data::default();
    let secret = info("", "Secret", true);
    let flaky = info("metrics.k8s.io", "PodMetrics", true);
    let t0 = Instant::now();

    record(&mut data, Arc::new(secret.clone()), Err(api_error(403)), t0);
    record(&mut data, Arc::new(flaky.clone()), Err(api_error(503)), t0);
    assert_eq!(data.forbidden.len(), 1);
    assert_eq!(data.failed.len(), 1);

    let kinds = vec![secret, flaky];
    plan(&mut data, &kinds, t0 + Duration::from_secs(5));
    assert!(data.queue.is_empty(), "neither retried straight away");

    plan(&mut data, &kinds, t0 + RETRY_AFTER);
    let queued: Vec<&str> = data.queue.iter().map(|k| k.kind.as_str()).collect();
    assert_eq!(
        queued,
        ["PodMetrics"],
        "only the failure is retried; a 403 will be refused again"
    );
}

#[test]
fn a_stale_kind_is_listed_again_and_a_deleted_crd_is_dropped() {
    let t0 = Instant::now();
    let mut data = indexed(
        "prod",
        vec![
            (
                info("", "Pod", true),
                table(&["Name"], &[("api", Some("shop"), &["api"])]),
            ),
            (
                info("example.com", "Widget", true),
                table(&["Name"], &[("w", Some("shop"), &["w"])]),
            ),
        ],
    );

    plan(
        &mut data,
        &[info("", "Pod", true)],
        t0 + Duration::from_secs(10),
    );
    assert!(data.queue.is_empty(), "fresh kinds are not re-listed");
    assert!(
        !data.kinds.contains_key("example.com/v1/Widget"),
        "a kind discovery no longer serves goes"
    );

    plan(
        &mut data,
        &[info("", "Pod", true)],
        t0 + STALE_AFTER + Duration::from_secs(1),
    );
    assert_eq!(data.queue.len(), 1);
}

#[test]
fn a_new_crd_is_queued_as_soon_as_discovery_offers_it() {
    let mut data = indexed("prod", vec![(info("", "Pod", true), table(&["Name"], &[]))]);
    plan(
        &mut data,
        &[info("", "Pod", true), info("example.com", "Widget", true)],
        Instant::now(),
    );
    assert_eq!(data.queue.front().unwrap().kind, "Widget");
}

// ------------------------------------------------------------- record

#[test]
fn status_comes_from_the_printed_status_column() {
    let data = indexed(
        "prod",
        vec![
            (
                info("", "Pod", true),
                table(
                    &["Name", "Ready", "Status", "Restarts"],
                    &[(
                        "api-1",
                        Some("shop"),
                        &["api-1", "0/1", "CrashLoopBackOff", "7"],
                    )],
                ),
            ),
            (
                info("apps", "Deployment", true),
                table(
                    &["Name", "Ready", "Up-to-date"],
                    &[("api", Some("shop"), &["api", "2/3", "3"])],
                ),
            ),
            (
                info("", "Service", true),
                table(
                    &["Name", "Type"],
                    &[("api", Some("shop"), &["api", "ClusterIP"])],
                ),
            ),
        ],
    );
    let r = respond(&data, "api");
    let status = |kind: &str| {
        r.hits
            .iter()
            .find(|h| h.kind == kind)
            .unwrap()
            .status
            .clone()
    };
    assert_eq!(
        status("Pod").as_deref(),
        Some("CrashLoopBackOff"),
        "Status wins over Ready"
    );
    assert_eq!(status("Deployment").as_deref(), Some("2/3"));
    assert_eq!(
        status("Service"),
        None,
        "no status column, no invented status"
    );
}

#[test]
fn a_secret_is_indexed_by_name_and_nothing_else() {
    let data = indexed(
        "prod",
        vec![(
            info("", "Secret", true),
            // Were a value ever to arrive in a cell, it must not be kept.
            table(
                &["Name", "Status"],
                &[("db-password", Some("shop"), &["db-password", "hunter2"])],
            ),
        )],
    );
    let r = respond(&data, "db-pass");
    assert_eq!(r.hits[0].status, None);
    assert!(
        respond(&data, "hunter2").hits.is_empty(),
        "cell text is not searchable"
    );
    let held = format!("{:?}", data.kinds.values().next().unwrap().objects);
    assert!(!held.contains("hunter2"));
}

#[test]
fn an_empty_or_none_cell_is_no_status() {
    let data = indexed(
        "prod",
        vec![(
            info("example.com", "Widget", true),
            table(
                &["Name", "State"],
                &[
                    ("a", Some("x"), &["a", "<none>"]),
                    ("ab", Some("x"), &["ab", ""]),
                ],
            ),
        )],
    );
    assert!(
        respond(&data, "a").hits.is_empty(),
        "one character searches nothing"
    );
    assert!(respond(&data, "ab").hits.iter().all(|h| h.status.is_none()));
}

#[test]
fn namespaces_and_statuses_are_shared_not_copied() {
    let rows: Vec<(String, &[&str])> = (0..100)
        .map(|i| (format!("pod-{i}"), &["x", "Running"][..]))
        .collect();
    let rows: Vec<(&str, Option<&str>, &[&str])> = rows
        .iter()
        .map(|(n, c)| (n.as_str(), Some("shop"), *c))
        .collect();
    let data = indexed(
        "prod",
        vec![(info("", "Pod", true), table(&["Name", "Status"], &rows))],
    );
    assert_eq!(
        data.interner.0.len(),
        2,
        "one `shop` and one `Running` for a hundred pods"
    );
}

// ------------------------------------------------------------- ranking

#[test]
fn a_prefix_beats_a_substring_beats_a_namespace_match() {
    let data = indexed(
        "prod",
        vec![(
            info("", "Pod", true),
            table(
                &["Name"],
                &[
                    ("payments-api", Some("shop"), &[""]),
                    ("api-7d9", Some("shop"), &[""]),
                    ("worker", Some("api-gateway"), &[""]),
                    ("unrelated", Some("shop"), &[""]),
                ],
            ),
        )],
    );
    assert_eq!(
        names(&respond(&data, "api")),
        ["Pod/api-7d9", "Pod/payments-api", "Pod/worker"]
    );
}

#[test]
fn every_term_must_match_somewhere() {
    let data = indexed(
        "prod",
        vec![(
            info("", "Pod", true),
            table(
                &["Name"],
                &[
                    ("api-1", Some("prod"), &[""]),
                    ("api-2", Some("staging"), &[""]),
                ],
            ),
        )],
    );
    assert_eq!(names(&respond(&data, "api prod")), ["Pod/api-1"]);
    assert_eq!(
        names(&respond(&data, "API")),
        ["Pod/api-1", "Pod/api-2"],
        "case-insensitive"
    );
}

#[test]
fn the_kind_narrows_too() {
    let data = indexed(
        "prod",
        vec![
            (
                info("", "Pod", true),
                table(&["Name"], &[("api-1", Some("shop"), &[""])]),
            ),
            (
                info("", "Service", true),
                table(&["Name"], &[("api", Some("shop"), &[""])]),
            ),
        ],
    );
    assert_eq!(names(&respond(&data, "api service")), ["Service/api"]);
}

#[test]
fn results_are_capped_per_kind_so_one_kind_cannot_crowd_out_the_rest() {
    let pods: Vec<String> = (0..40).map(|i| format!("api-{i:02}")).collect();
    let rows: Vec<(&str, Option<&str>, &[&str])> = pods
        .iter()
        .map(|n| (n.as_str(), Some("shop"), &[""][..]))
        .collect();
    let data = indexed(
        "prod",
        vec![
            (info("", "Pod", true), table(&["Name"], &rows)),
            (
                info("", "Service", true),
                table(&["Name"], &[("api-zzz-service", Some("shop"), &[""])]),
            ),
        ],
    );
    let r = respond(&data, "api");
    assert_eq!(
        r.hits.iter().filter(|h| h.kind == "Pod").count(),
        MAX_PER_KIND
    );
    assert!(r.hits.iter().any(|h| h.kind == "Service"));
}

#[test]
fn the_response_says_how_complete_the_index_is() {
    let mut data = indexed(
        "prod",
        vec![(
            info("", "Pod", true),
            table(&["Name"], &[("a", Some("x"), &[""])]),
        )],
    );
    record(
        &mut data,
        Arc::new(info("", "Secret", true)),
        Err(api_error(403)),
        Instant::now(),
    );
    record(
        &mut data,
        Arc::new(info("", "Node", false)),
        Err(api_error(403)),
        Instant::now(),
    );
    data.total = 5;
    data.warming = true;

    let r = respond(&data, "");
    assert_eq!(
        (r.indexed_kinds, r.total_kinds, r.forbidden_kinds),
        (1, 5, 2)
    );
    assert_eq!(r.objects, 1);
    assert!(r.warming);
    assert!(r.hits.is_empty(), "an empty query searches nothing");
}

#[test]
fn a_forbidden_kind_drops_what_it_held() {
    let mut data = indexed(
        "prod",
        vec![(
            info("", "Secret", true),
            table(&["Name"], &[("s", Some("x"), &[""])]),
        )],
    );
    record(
        &mut data,
        Arc::new(info("", "Secret", true)),
        Err(api_error(403)),
        Instant::now(),
    );
    assert!(data.kinds.is_empty());
}

#[test]
fn switching_cluster_starts_a_fresh_index_that_old_warmers_cannot_write_into() {
    let mut data = indexed(
        "prod",
        vec![(
            info("", "Pod", true),
            table(&["Name"], &[("api", Some("x"), &[""])]),
        )],
    );
    let old = data.generation;
    reset(&mut data, "staging");
    assert!(data.kinds.is_empty());
    assert_eq!(data.context, "staging");
    assert_ne!(data.generation, old);
}

#[test]
fn find_ci_is_ascii_case_insensitive() {
    assert_eq!(find_ci("Payments-API", "api"), Some(9));
    assert_eq!(find_ci("abc", "abcd"), None);
    assert_eq!(find_ci("abc", ""), Some(0));
}

#[test]
fn a_response_serialises_as_the_frontend_reads_it() {
    let data = indexed(
        "prod",
        vec![(
            info("", "Pod", true),
            table(&["Name"], &[("api", Some("x"), &[""])]),
        )],
    );
    let json = serde_json::to_value(respond(&data, "api")).unwrap();
    assert_eq!(json["hits"][0]["kind"], "Pod");
    assert_eq!(json["hits"][0]["namespace"], "x");
    assert!(json["hits"][0]["status"].is_null());
    assert_eq!(json["indexedKinds"], 1);
    assert!(json["approxBytes"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn searching_requires_a_connection() {
    let index: &'static SearchIndex = Box::leak(Box::default());
    assert!(matches!(
        index.search(&Session::default(), "api").await,
        Err(crate::error::AppError::NotConnected)
    ));
}

// ----------------------------------------------------- size and speed

/// A cluster-shaped index: 10,000 objects over 40 kinds, most of them
/// pods and replica sets, with realistic name lengths.
fn large() -> Data {
    let mut entries = Vec::new();
    let namespaces: Vec<String> = (0..60).map(|i| format!("team-{i:02}-production")).collect();
    let mut remaining = 10_000usize;
    for k in 0..40 {
        let count = if k < 2 {
            3_000
        } else {
            remaining.clamp(1, 4_000 / 38)
        };
        remaining = remaining.saturating_sub(count);
        let kind = format!("Kind{k:02}");
        let names: Vec<String> = (0..count)
            .map(|i| format!("service-{k:02}-deployment-{i:05}-7d9f8b6c5d-x2k9p"))
            .collect();
        let rows: Vec<(&str, Option<&str>, &[&str])> = names
            .iter()
            .enumerate()
            .map(|(i, n)| {
                (
                    n.as_str(),
                    Some(namespaces[i % namespaces.len()].as_str()),
                    &["n", "Running"][..],
                )
            })
            .collect();
        entries.push((
            info("example.com", &kind, true),
            table(&["Name", "Status"], &rows),
        ));
    }
    let mut data = indexed("large", entries);
    // Top up to exactly 10,000 so the figure is for the stated size.
    let have: usize = data.kinds.values().map(|k| k.objects.len()).sum();
    if have < 10_000 {
        let extra: Vec<String> = (0..10_000 - have)
            .map(|i| format!("extra-configmap-{i:05}"))
            .collect();
        let rows: Vec<(&str, Option<&str>, &[&str])> = extra
            .iter()
            .map(|n| {
                (
                    n.as_str(),
                    Some("team-00-production"),
                    &["n", "Running"][..],
                )
            })
            .collect();
        record(
            &mut data,
            Arc::new(info("", "ConfigMap", true)),
            Ok(vec![table(&["Name", "Status"], &rows)]),
            Instant::now(),
        );
    }
    data
}

#[test]
fn ten_thousand_objects_fit_well_under_fifty_megabytes() {
    let data = large();
    let r = respond(&data, "");
    assert!(r.objects >= 10_000, "{}", r.objects);
    println!(
        "index: {} objects over {} kinds ≈ {:.2} MB",
        r.objects,
        r.indexed_kinds,
        r.approx_bytes as f64 / 1_048_576.0
    );
    assert!(r.approx_bytes < 50 * 1_048_576);
}

#[test]
fn a_three_character_query_over_ten_thousand_objects_is_fast() {
    let data = large();
    // Warm the allocator and caches once, then take the slowest of a few.
    respond(&data, "dep");
    let slowest = (0..5)
        .map(|_| {
            let t = Instant::now();
            let r = respond(&data, "x2k");
            assert!(!r.hits.is_empty());
            t.elapsed()
        })
        .max()
        .unwrap();
    println!("3-character query over 10,000 objects: {slowest:?}");
    // The criterion is 300 ms end to end. This is an unoptimised test
    // build, so the bound here is the criterion itself; release builds
    // are an order of magnitude faster.
    assert!(slowest < Duration::from_millis(300), "{slowest:?}");
}

// ------------------------------------------------- through the client

mod wire {
    use super::*;
    use crate::fake_api::{self, Seen};
    use http::StatusCode;
    use serde_json::{json, Value};

    fn table_page(names: &[&str], cont: Option<&str>) -> (StatusCode, Value) {
        (
            StatusCode::OK,
            json!({
                "kind": "Table", "apiVersion": "meta.k8s.io/v1",
                "metadata": { "continue": cont.unwrap_or("") },
                "columnDefinitions": [{ "name": "Name", "priority": 0 }, { "name": "Status", "priority": 0 }],
                "rows": names.iter().map(|n| json!({
                    "cells": [n, "Running"],
                    "object": { "metadata": { "name": n, "namespace": "shop" } }
                })).collect::<Vec<_>>()
            }),
        )
    }

    /// Pods over two pages, Secrets refused, ConfigMaps empty.
    fn cluster(seen: &Seen) -> (StatusCode, Value) {
        match seen.path.as_str() {
            "/api/v1/pods" if seen.query.contains("continue=page2") => table_page(&["api-2"], None),
            "/api/v1/pods" => table_page(&["api-1"], Some("page2")),
            "/api/v1/secrets" => fake_api::status(403, "Forbidden"),
            "/api/v1/configmaps" => (
                StatusCode::OK,
                json!({ "kind": "Table", "columnDefinitions": [], "rows": null }),
            ),
            // Discovery, for the end-to-end test.
            "/api" => (
                StatusCode::OK,
                json!({ "kind": "APIVersions", "versions": ["v1"], "serverAddressByClientCIDRs": [] }),
            ),
            "/apis" => (
                StatusCode::OK,
                json!({ "kind": "APIGroupList", "apiVersion": "v1", "groups": [] }),
            ),
            "/api/v1" => (
                StatusCode::OK,
                json!({
                    "kind": "APIResourceList", "groupVersion": "v1",
                    "resources": [
                        { "name": "pods", "singularName": "pod", "namespaced": true, "kind": "Pod", "verbs": ["get", "list", "watch"] },
                        { "name": "secrets", "singularName": "secret", "namespaced": true, "kind": "Secret", "verbs": ["get", "list"] },
                        { "name": "configmaps", "singularName": "configmap", "namespaced": true, "kind": "ConfigMap", "verbs": ["list"] },
                        { "name": "events", "singularName": "event", "namespaced": true, "kind": "Event", "verbs": ["list"] }
                    ]
                }),
            ),
            other => panic!("unexpected request to {other}?{}", seen.query),
        }
    }

    #[tokio::test]
    async fn a_kind_is_read_from_the_watch_cache_and_continuations_are_followed() {
        let (client, log) = fake_api::client(cluster);
        let pages = list_kind(&client, &info("", "Pod", true)).await.unwrap();

        let names: Vec<&str> = pages
            .iter()
            .flat_map(|p| p.rows.iter().map(|r| r.name.as_str()))
            .collect();
        assert_eq!(names, ["api-1", "api-2"]);

        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert!(
            log[0].query.contains("resourceVersion=0"),
            "read from the watch cache: {}",
            log[0].query
        );
        assert!(
            !log[0].query.contains("limit="),
            "a limit would make kube drop the resource version"
        );
        assert!(log[1].query.contains("continue=page2"));
        assert!(
            !log[1].query.contains("resourceVersion"),
            "a continuation cannot carry one: {}",
            log[1].query
        );
        assert!(
            log.iter().all(|s| s.accept.contains("as=Table")),
            "asks the server to print"
        );
    }

    #[tokio::test]
    async fn warming_lists_every_queued_kind_and_records_refusals() {
        let (client, log) = fake_api::client(cluster);
        let index: &'static SearchIndex = Box::leak(Box::default());
        let generation = {
            let mut data = index.data.lock().unwrap();
            reset(&mut data, "fake");
            plan(
                &mut data,
                &[
                    info("", "Pod", true),
                    info("", "Secret", true),
                    info("", "ConfigMap", true),
                ],
                Instant::now(),
            );
            data.warming = true;
            data.generation
        };

        warm(index, client, generation).await;

        let data = index.data.lock().unwrap();
        assert!(!data.warming, "the warmer says when it is done");
        assert!(data.queue.is_empty() && data.in_flight.is_empty());
        assert_eq!(data.kinds["/v1/Pod"].objects.len(), 2);
        assert!(
            data.kinds["/v1/ConfigMap"].objects.is_empty(),
            "an empty kind is indexed, not failed"
        );
        assert!(data.forbidden.contains("/v1/Secret"));
        assert!(log
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.path.contains("events")));
    }

    #[tokio::test]
    async fn a_warmer_for_a_cluster_that_was_left_writes_nothing() {
        let (client, _) = fake_api::client(cluster);
        let index: &'static SearchIndex = Box::leak(Box::default());
        let stale = {
            let mut data = index.data.lock().unwrap();
            reset(&mut data, "old");
            plan(&mut data, &[info("", "Pod", true)], Instant::now());
            let g = data.generation;
            // The user switches cluster before the warmer runs.
            reset(&mut data, "new");
            g
        };
        warm(index, client, stale).await;
        let data = index.data.lock().unwrap();
        assert!(data.kinds.is_empty());
        assert_eq!(data.context, "new");
    }

    #[tokio::test]
    async fn searching_indexes_in_the_background_and_disconnecting_forgets() {
        let (client, _) = fake_api::client(cluster);
        let session = Session::default();
        session
            .set(
                client,
                crate::cluster::ClusterInfo {
                    context: "fake".into(),
                    server: String::new(),
                    version: String::new(),
                    platform: String::new(),
                },
            )
            .await;
        let index: &'static SearchIndex = Box::leak(Box::default());

        let first = index.search(&session, "api").await.unwrap();
        assert_eq!(first.total_kinds, 3, "events are not a kind to index");

        let deadline = Instant::now() + Duration::from_secs(5);
        let found = loop {
            let r = index.search(&session, "api").await.unwrap();
            if !r.warming && r.indexed_kinds == 2 {
                break r;
            }
            assert!(Instant::now() < deadline, "never finished warming");
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(names(&found), ["Pod/api-1", "Pod/api-2"]);
        assert_eq!(found.forbidden_kinds, 1);
        assert_eq!(found.hits[0].status.as_deref(), Some("Running"));

        index.clear();
        let data = index.data.lock().unwrap();
        assert!(data.kinds.is_empty() && data.context.is_empty());
    }
}
