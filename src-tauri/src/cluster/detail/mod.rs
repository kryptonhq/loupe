//! Detail views: the full picture of a single resource.
//!
//! List views summarise; this module does the opposite. It returns the
//! fields an operator reads when something is wrong — container states
//! with their termination reasons, node pressure conditions, quota
//! headroom — plus the raw YAML, because eventually every investigation
//! ends in the YAML.
//!
//! What lives here is what more than one kind needs: conditions, events,
//! label maps and YAML rendering. The per-kind modules hold the rest.

pub mod namespace;
pub mod node;
pub mod pod;

use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::{resources::age, Session};
use crate::error::{AppError, Result};

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
pub struct EventView {
    pub type_: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub count: Option<i32>,
    pub age: Option<String>,
    pub source: Option<String>,
    /// Which object the event is about. Redundant on a pod's own event
    /// list, but the namespace view shows every event in the namespace
    /// and there the subject is the first thing you need.
    pub object: Option<String>,
}

/// Renders an object as YAML for the editor and the YAML tab.
pub(crate) fn to_yaml<T: Serialize>(value: &T) -> Result<String> {
    serde_yaml::to_string(value).map_err(|e| AppError::Kube(format!("render yaml: {e}")))
}

pub(crate) fn sorted_pairs(map: &std::collections::BTreeMap<String, String>) -> Vec<(String, String)> {
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

fn event_view(e: &Event) -> EventView {
    EventView {
        age: age(e),
        type_: e.type_.clone().unwrap_or_else(|| "Normal".into()),
        reason: e.reason.clone(),
        message: e.message.clone(),
        count: e.count,
        source: e
            .source
            .as_ref()
            .and_then(|s| s.component.clone())
            .or_else(|| e.reporting_component.clone()),
        object: e.involved_object.name.as_ref().map(|n| match &e.involved_object.kind {
            Some(k) => format!("{k}/{n}"),
            None => n.clone(),
        }),
    }
}

/// Sorts newest first and drops the sort key.
///
/// Sorting on the rendered age string would order "2m" before "10s" —
/// the key has to be the timestamp. An event with no timestamp sorts
/// last rather than pretending to be from the epoch.
fn newest_first(mut events: Vec<(i64, EventView)>) -> Vec<EventView> {
    // Reverse rather than a flipped comparator: newest first, said once.
    events.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
    events.into_iter().map(|(_, v)| v).collect()
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
    // A cluster-scoped object's events (a node's, say) live in the
    // "default" namespace by convention, which is why the caller passes
    // a namespace even for something that has none of its own.
    let api: Api<Event> = Api::namespaced(client, namespace);
    let params = ListParams::default().fields(&format!("involvedObject.name={object_name}"));
    let list = api.list(&params).await?;

    Ok(newest_first(
        list.iter()
            .map(|e| (event_time(e).unwrap_or(i64::MIN), event_view(e)))
            .collect(),
    ))
}

/// Every event in a namespace, newest first.
///
/// The namespace object itself almost never has events of its own, so
/// filtering by involvedObject there would render an empty tab. What an
/// operator actually wants from a namespace is what is going wrong
/// inside it.
pub async fn list_namespace_events(session: &Session, namespace: &str) -> Result<Vec<EventView>> {
    let client = session.client().await?;
    let api: Api<Event> = Api::namespaced(client, namespace);
    let list = api.list(&ListParams::default()).await?;

    Ok(newest_first(
        list.iter()
            .map(|e| (event_time(e).unwrap_or(i64::MIN), event_view(e)))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::ObjectReference;

    fn event(name: &str, kind: &str) -> Event {
        Event {
            involved_object: ObjectReference {
                name: Some(name.into()),
                kind: Some(kind.into()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn newest_first_orders_by_timestamp_not_rendered_age() {
        // "2m" sorts before "10s" as a string; the timestamps must win.
        let ordered = newest_first(vec![
            (100, event_view(&event("old", "Pod"))),
            (300, event_view(&event("new", "Pod"))),
            (200, event_view(&event("mid", "Pod"))),
        ]);
        let subjects: Vec<_> = ordered.iter().map(|e| e.object.clone().unwrap()).collect();
        assert_eq!(subjects, vec!["Pod/new", "Pod/mid", "Pod/old"]);
    }

    #[test]
    fn an_undated_event_sorts_last_rather_than_first() {
        let ordered = newest_first(vec![
            (i64::MIN, event_view(&event("undated", "Pod"))),
            (1, event_view(&event("dated", "Pod"))),
        ]);
        assert_eq!(ordered[0].object.as_deref(), Some("Pod/dated"));
    }

    #[test]
    fn event_time_prefers_last_timestamp_over_creation() {
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
        let ts = |s: i64| Time(k8s_openapi::jiff::Timestamp::from_second(s).unwrap());

        let mut e = event("repeating", "Pod");
        e.metadata.creation_timestamp = Some(ts(100));
        e.last_timestamp = Some(ts(900));

        // A CrashLoopBackOff event created an hour ago but fired a second
        // ago belongs at the top of the list.
        assert_eq!(event_time(&e), Some(900));
    }

    #[test]
    fn event_subject_carries_its_kind() {
        assert_eq!(
            event_view(&event("coredns-abc", "Pod")).object.as_deref(),
            Some("Pod/coredns-abc")
        );
    }

    #[test]
    fn condition_serialises_as_type_not_type_underscore() {
        // The frontend reads `type`; if serde emits anything else the
        // column renders as "undefined".
        let c = ConditionView {
            type_: "Ready".into(),
            status: "True".into(),
            reason: None,
            message: None,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"type\":\"Ready\""), "got {json}");
    }
}
