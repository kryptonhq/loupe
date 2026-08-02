//! Pod detail: container states, conditions, and the rendered YAML.

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ResourceExt};
use serde::Serialize;

use crate::cluster::detail::{sorted_pairs, to_yaml, ConditionView};
use crate::cluster::{resources::age, Session};
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerView {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub restarts: i32,
    /// "Running", "Waiting: ImagePullBackOff", "Terminated: OOMKilled" —
    /// flattened here because the reason is the whole point and it is
    /// buried three levels down in the API type.
    pub state: String,
    /// Set when the container terminated, including on a previous run.
    /// A CrashLoopBackOff pod is Waiting now but was OOMKilled a second
    /// ago, and that earlier reason is what explains the crash.
    pub last_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodDetail {
    /// Identity for the YAML editor. Carried on the payload rather than
    /// hardcoded in the frontend so every detail view saves the same way.
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub phase: String,
    pub node: Option<String>,
    pub pod_ip: Option<String>,
    pub service_account: Option<String>,
    pub qos_class: Option<String>,
    pub age: Option<String>,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    pub containers: Vec<ContainerView>,
    pub init_containers: Vec<ContainerView>,
    pub conditions: Vec<ConditionView>,
    /// Rendered server-side so the webview never needs a YAML library.
    pub yaml: String,
}

/// Flattens a container status into one readable line.
fn container_state(state: &k8s_openapi::api::core::v1::ContainerState) -> String {
    if state.running.is_some() {
        return "Running".into();
    }
    if let Some(w) = &state.waiting {
        return match &w.reason {
            Some(r) => format!("Waiting: {r}"),
            None => "Waiting".into(),
        };
    }
    if let Some(t) = &state.terminated {
        let reason = t.reason.clone().unwrap_or_else(|| "Terminated".into());
        return format!("Terminated: {reason} (exit {})", t.exit_code);
    }
    "Unknown".into()
}

fn containers_from(
    statuses: Option<&Vec<k8s_openapi::api::core::v1::ContainerStatus>>,
) -> Vec<ContainerView> {
    statuses
        .map(|list| {
            list.iter()
                .map(|c| ContainerView {
                    name: c.name.clone(),
                    image: c.image.clone(),
                    ready: c.ready,
                    restarts: c.restart_count,
                    state: c
                        .state
                        .as_ref()
                        .map(container_state)
                        .unwrap_or_else(|| "Unknown".into()),
                    last_state: c.last_state.as_ref().and_then(|s| {
                        // Only meaningful if it actually ran before; an
                        // empty ContainerState means "no previous run".
                        if s.running.is_some() || s.waiting.is_some() || s.terminated.is_some() {
                            Some(container_state(s))
                        } else {
                            None
                        }
                    }),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Builds the detail payload from a fetched pod.
///
/// Split from `get_pod` so the flattening — which is where the fields an
/// operator reads during an incident are decided — can be tested against
/// constructed pods rather than only whatever a live cluster happens to
/// be running.
pub(crate) fn pod_detail_from(mut pod: Pod) -> Result<PodDetail> {
    // managedFields is server-side bookkeeping: dozens of lines that
    // push the interesting spec off the screen and that nobody reads.
    pod.metadata.managed_fields = None;

    let yaml = to_yaml(&pod)?;

    let status = pod.status.clone();
    let spec = pod.spec.clone();

    Ok(PodDetail {
        api_version: "v1".into(),
        kind: "Pod".into(),
        age: age(&pod),
        name: pod.name_any(),
        namespace: pod.namespace().unwrap_or_default(),
        phase: status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        node: spec.as_ref().and_then(|s| s.node_name.clone()),
        pod_ip: status.as_ref().and_then(|s| s.pod_ip.clone()),
        service_account: spec.as_ref().and_then(|s| s.service_account_name.clone()),
        qos_class: status.as_ref().and_then(|s| s.qos_class.clone()),
        labels: sorted_pairs(pod.labels()),
        annotations: sorted_pairs(pod.annotations()),
        containers: containers_from(status.as_ref().and_then(|s| s.container_statuses.as_ref())),
        init_containers: containers_from(
            status
                .as_ref()
                .and_then(|s| s.init_container_statuses.as_ref()),
        ),
        conditions: status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| {
                cs.iter()
                    .map(|c| ConditionView {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        yaml,
    })
}

pub async fn get_pod(session: &Session, namespace: &str, name: &str) -> Result<PodDetail> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::namespaced(client, namespace);
    pod_detail_from(api.get(name).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::detail::list_events;
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateTerminated, ContainerStateWaiting,
    };

    #[test]
    fn flattens_waiting_state_with_its_reason() {
        // The reason is the whole diagnostic value — "Waiting" alone
        // tells an operator nothing.
        let state = ContainerState {
            waiting: Some(ContainerStateWaiting {
                reason: Some("ImagePullBackOff".into()),
                message: None,
            }),
            ..Default::default()
        };
        assert_eq!(container_state(&state), "Waiting: ImagePullBackOff");
    }

    #[test]
    fn flattens_terminated_state_with_exit_code() {
        let state = ContainerState {
            terminated: Some(ContainerStateTerminated {
                reason: Some("OOMKilled".into()),
                exit_code: 137,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(container_state(&state), "Terminated: OOMKilled (exit 137)");
    }

    #[test]
    fn empty_container_state_is_unknown_not_a_panic() {
        assert_eq!(container_state(&ContainerState::default()), "Unknown");
    }

    #[test]
    fn a_waiting_container_with_no_reason_still_renders() {
        // The API may report Waiting before it knows why. "Waiting:"
        // with nothing after it would read as a truncated string.
        let state = ContainerState {
            waiting: Some(ContainerStateWaiting::default()),
            ..Default::default()
        };
        assert_eq!(container_state(&state), "Waiting");
    }

    #[test]
    fn a_terminated_container_with_no_reason_keeps_its_exit_code() {
        // The exit code is the diagnostic when the reason is missing;
        // dropping it would leave nothing to go on.
        let state = ContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code: 1,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(container_state(&state), "Terminated: Terminated (exit 1)");
    }

    #[test]
    fn running_wins_over_a_stale_waiting_block() {
        // The API can carry more than one populated block. Running is
        // checked first because it is the current truth.
        let state = ContainerState {
            running: Some(k8s_openapi::api::core::v1::ContainerStateRunning::default()),
            waiting: Some(ContainerStateWaiting {
                reason: Some("ContainerCreating".into()),
                message: None,
            }),
            ..Default::default()
        };
        assert_eq!(container_state(&state), "Running");
    }

    /// A container status shaped like a crash-looping container: waiting
    /// to restart now, OOMKilled a moment ago.
    fn crashlooping() -> k8s_openapi::api::core::v1::ContainerStatus {
        k8s_openapi::api::core::v1::ContainerStatus {
            name: "app".into(),
            image: "app:1.0".into(),
            ready: false,
            restart_count: 7,
            state: Some(ContainerState {
                waiting: Some(ContainerStateWaiting {
                    reason: Some("CrashLoopBackOff".into()),
                    message: None,
                }),
                ..Default::default()
            }),
            last_state: Some(ContainerState {
                terminated: Some(ContainerStateTerminated {
                    reason: Some("OOMKilled".into()),
                    exit_code: 137,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_crashlooping_container_reports_both_why_it_waits_and_why_it_died() {
        // This pairing is the entire diagnosis. CrashLoopBackOff alone
        // says the container keeps dying; the previous OOMKilled says
        // why, and without it the next step is guesswork.
        let views = containers_from(Some(&vec![crashlooping()]));
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].state, "Waiting: CrashLoopBackOff");
        assert_eq!(
            views[0].last_state.as_deref(),
            Some("Terminated: OOMKilled (exit 137)")
        );
        assert_eq!(views[0].restarts, 7);
        assert!(!views[0].ready);
    }

    #[test]
    fn a_container_on_its_first_run_reports_no_previous_state() {
        // An empty ContainerState means "never ran before". Rendering it
        // as "Unknown" would suggest a previous run that failed
        // mysteriously, which is a worse lie than saying nothing.
        let status = k8s_openapi::api::core::v1::ContainerStatus {
            name: "app".into(),
            image: "app:1.0".into(),
            ready: true,
            restart_count: 0,
            state: Some(ContainerState {
                running: Some(Default::default()),
                ..Default::default()
            }),
            last_state: Some(ContainerState::default()),
            ..Default::default()
        };
        assert_eq!(containers_from(Some(&vec![status]))[0].last_state, None);
    }

    #[test]
    fn a_pod_with_no_container_statuses_yields_no_container_rows() {
        assert!(containers_from(None).is_empty());
    }

    #[test]
    fn detail_separates_init_containers_from_app_containers() {
        // An init container stuck pulling its image is a common reason a
        // pod never starts, and merging the two lists would hide which
        // phase the pod is actually stuck in.
        let pod = Pod {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some("web".into()),
                namespace: Some("prod".into()),
                ..Default::default()
            },
            status: Some(k8s_openapi::api::core::v1::PodStatus {
                phase: Some("Pending".into()),
                init_container_statuses: Some(vec![k8s_openapi::api::core::v1::ContainerStatus {
                    name: "migrate".into(),
                    image: "migrate:1.0".into(),
                    ready: false,
                    restart_count: 0,
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some("ImagePullBackOff".into()),
                            message: None,
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]),
                container_statuses: Some(vec![crashlooping()]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let detail = pod_detail_from(pod).expect("build detail");
        assert_eq!(detail.init_containers.len(), 1);
        assert_eq!(detail.init_containers[0].name, "migrate");
        assert_eq!(detail.init_containers[0].state, "Waiting: ImagePullBackOff");
        assert_eq!(detail.containers.len(), 1);
        assert_eq!(detail.containers[0].name, "app");
    }

    #[test]
    fn detail_carries_the_identity_the_yaml_editor_saves_against() {
        // The editor reads apiVersion/kind off the payload rather than
        // hardcoding them, so every detail view saves the same way. If
        // these are wrong the save targets the wrong endpoint.
        let pod = Pod {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some("web".into()),
                namespace: Some("prod".into()),
                ..Default::default()
            },
            ..Default::default()
        };

        let detail = pod_detail_from(pod).expect("build detail");
        assert_eq!(detail.api_version, "v1");
        assert_eq!(detail.kind, "Pod");
        assert_eq!(detail.name, "web");
        assert_eq!(detail.namespace, "prod");
        // No status at all, which is a pod between creation and
        // scheduling — not a reason to fail the whole view.
        assert_eq!(detail.phase, "Unknown");
        assert!(detail.containers.is_empty());
    }

    #[test]
    fn managed_fields_are_stripped_from_the_rendered_yaml() {
        // Dozens of lines of server-side bookkeeping that push the spec
        // off the screen. This is the assertion the live test makes too,
        // pinned here so it holds without a cluster.
        let pod = Pod {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some("web".into()),
                managed_fields: Some(vec![
                    k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry {
                        manager: Some("kubectl-client-side-apply".into()),
                        operation: Some("Update".into()),
                        ..Default::default()
                    },
                ]),
                ..Default::default()
            },
            ..Default::default()
        };

        let detail = pod_detail_from(pod).expect("build detail");
        assert!(!detail.yaml.contains("managedFields"));
        assert!(!detail.yaml.contains("kubectl-client-side-apply"));
        assert!(detail.yaml.contains("name: web"));
    }

    #[test]
    fn labels_and_annotations_are_ordered_so_the_view_does_not_shuffle() {
        // Both come off a BTreeMap, so the order is already stable — this
        // pins it, because a HashMap here would make the detail page
        // reorder itself on every refresh.
        let pod = Pod {
            metadata: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta {
                name: Some("web".into()),
                labels: Some(
                    [("zone", "b"), ("app", "web"), ("tier", "front")]
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let detail = pod_detail_from(pod).expect("build detail");
        let keys: Vec<&str> = detail.labels.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["app", "tier", "zone"]);
    }

    /// Fetches a real pod and its events.
    ///
    /// Ignored by default; run with:
    ///   LOUPE_TEST_CONTEXT=orbstack cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn reads_a_live_pod_detail_and_events() {
        let session = crate::cluster::live::session().await;

        let pods = crate::cluster::resources::list_pods(&session, Some("kube-system".into()))
            .await
            .expect("list pods");
        let target = pods.first().expect("kube-system should have a pod");

        let detail = get_pod(&session, "kube-system", &target.name)
            .await
            .expect("get pod");
        println!(
            "{} on {:?}, {} container(s)",
            detail.name,
            detail.node,
            detail.containers.len()
        );

        assert_eq!(detail.name, target.name);
        assert_eq!(detail.kind, "Pod");
        assert!(!detail.containers.is_empty(), "a pod has containers");
        assert!(detail.yaml.contains("apiVersion:"), "yaml should render");
        // managedFields is stripped for readability; if it reappears the
        // YAML tab becomes unreadable noise.
        assert!(
            !detail.yaml.contains("managedFields"),
            "managedFields should be stripped from the rendered yaml"
        );

        // Events expire after roughly an hour, so an empty list is a
        // legitimate result — this asserts the call works, not that a
        // long-running cluster still has events to show.
        let events = list_events(&session, "kube-system", &target.name)
            .await
            .expect("list events");
        println!("{} event(s) for {}", events.len(), target.name);
    }
}
