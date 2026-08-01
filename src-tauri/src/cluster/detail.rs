//! Detail views: the full picture of a single resource.
//!
//! List views summarise; this module does the opposite. It returns the
//! fields an operator reads when something is wrong — container states
//! with their termination reasons, conditions, the scheduling node — plus
//! the raw YAML, because eventually every investigation ends in the YAML.

use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::{resources::age, Session};
use crate::error::{AppError, Result};

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
pub struct ConditionView {
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodDetail {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub type_: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub age: Option<String>,
    pub source: Option<String>,
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

fn sorted_pairs(map: &std::collections::BTreeMap<String, String>) -> Vec<(String, String)> {
    map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Best available timestamp for an event, in epoch seconds.
///
/// `lastTimestamp` is what kubectl shows and is what changes when a
/// repeated event fires again, so it wins over `creationTimestamp` —
/// otherwise a CrashLoopBackOff event that has fired 400 times would
/// keep sorting to the bottom by its original creation time.
fn event_time(e: &Event) -> Option<i64> {
    // Time and MicroTime are distinct types but both wrap a
    // jiff::Timestamp, so each is read on its own terms.
    if let Some(t) = &e.last_timestamp {
        return Some(t.0.as_second());
    }
    if let Some(t) = &e.event_time {
        return Some(t.0.as_second());
    }
    e.creation_timestamp().map(|t| t.0.as_second())
}

pub async fn get_pod(session: &Session, namespace: &str, name: &str) -> Result<PodDetail> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let mut pod = api.get(name).await?;

    // managedFields is server-side bookkeeping: dozens of lines that
    // push the interesting spec off the screen and that nobody reads.
    pod.metadata.managed_fields = None;

    let yaml =
        serde_yaml::to_string(&pod).map_err(|e| AppError::Kube(format!("render yaml: {e}")))?;

    let status = pod.status.clone();
    let spec = pod.spec.clone();

    Ok(PodDetail {
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

/// Events for one object, newest first.
///
/// Filtered server-side with a field selector so a busy namespace does
/// not ship thousands of unrelated events across the IPC boundary.
pub async fn list_events(
    session: &Session,
    namespace: &str,
    object_name: &str,
) -> Result<Vec<EventView>> {
    let client = session.client().await?;
    let api: Api<Event> = Api::namespaced(client, namespace);
    let params = ListParams::default().fields(&format!("involvedObject.name={object_name}"));
    let list = api.list(&params).await?;

    // The API returns events in arbitrary order and operators want the
    // most recent first, so sort explicitly. Sorting on the rendered age
    // string would order "2m" before "10s" — the key has to be the
    // timestamp. An event with no timestamp sorts last rather than
    // pretending to be from the epoch.
    let mut events: Vec<(i64, EventView)> = list
        .into_iter()
        .map(|e| {
            let ts = event_time(&e).unwrap_or(i64::MIN);
            (
                ts,
                EventView {
                    age: age(&e),
                    type_: e.type_.clone().unwrap_or_else(|| "Normal".into()),
                    reason: e.reason.clone(),
                    message: e.message.clone(),
                    count: e.count,
                    source: e
                        .source
                        .as_ref()
                        .and_then(|s| s.component.clone())
                        .or_else(|| e.reporting_component.clone()),
                },
            )
        })
        .collect();

    // Reverse rather than a flipped comparator: newest first, said once.
    events.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
    Ok(events.into_iter().map(|(_, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    /// Fetches a real pod and its events.
    ///
    /// Ignored by default; run with:
    ///   LOUPE_TEST_CONTEXT=orbstack cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn reads_a_live_pod_detail_and_events() {
        let context = std::env::var("LOUPE_TEST_CONTEXT")
            .expect("set LOUPE_TEST_CONTEXT to a context in your kubeconfig");

        let session = Session::default();
        crate::cluster::connect(&session, &context)
            .await
            .expect("connect");

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

    #[test]
    fn condition_and_event_type_serialise_as_type() {
        // The frontend reads `type`; if serde emits anything else the
        // column renders as "undefined".
        let c = ConditionView {
            type_: "Ready".into(),
            status: "True".into(),
            reason: None,
            message: None,
        };
        let json = serde_json::to_string(&c).unwrap();
        println!("ConditionView -> {json}");
        assert!(json.contains("\"type\":\"Ready\""), "got {json}");
    }
}
