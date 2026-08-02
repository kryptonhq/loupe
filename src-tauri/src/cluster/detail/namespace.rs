//! Namespace detail: what is running inside it and what is capping it.
//!
//! A Namespace object is almost empty — a phase and some finalizers. The
//! questions people actually open one to answer are about its contents:
//! how many pods are unhealthy, and whether a ResourceQuota is the
//! reason nothing new will start.

use k8s_openapi::api::core::v1::{Namespace, Pod, ResourceQuota};
use kube::api::{Api, ListParams, ResourceExt};
use serde::Serialize;

use crate::cluster::detail::{sorted_pairs, to_yaml};
use crate::cluster::{resources::age, Session};
use crate::error::Result;

/// One line of a ResourceQuota: what is capped, and how close it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaEntry {
    pub resource: String,
    pub used: String,
    pub hard: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaView {
    pub name: String,
    pub entries: Vec<QuotaEntry>,
}

/// Pod counts by phase, in the order an operator scans them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodTally {
    pub phase: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceDetail {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub phase: String,
    pub age: Option<String>,
    pub labels: Vec<(String, String)>,
    pub annotations: Vec<(String, String)>,
    /// Why a Terminating namespace is stuck. A namespace that will not
    /// go away is always a finalizer nobody is answering for.
    pub finalizers: Vec<String>,
    pub pod_count: usize,
    pub pods_by_phase: Vec<PodTally>,
    pub quotas: Vec<QuotaView>,
    pub yaml: String,
}

/// Counts pods by phase, most-troubling first.
///
/// Ordered deliberately rather than alphabetically: Failed and Pending
/// are what you opened the namespace to find, so they lead. Phases with
/// no pods are dropped — a row of zeroes is noise.
fn tally(pods: &[Pod]) -> Vec<PodTally> {
    const ORDER: [&str; 5] = ["Failed", "Pending", "Running", "Succeeded", "Unknown"];

    let phase_of = |p: &Pod| {
        p.status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into())
    };

    let mut tallies: Vec<PodTally> = ORDER
        .iter()
        .filter_map(|phase| {
            let count = pods.iter().filter(|p| phase_of(p) == *phase).count();
            (count > 0).then(|| PodTally {
                phase: (*phase).to_string(),
                count,
            })
        })
        .collect();

    // A phase we do not know about — the API can grow new ones — still
    // has to be counted, or the totals stop adding up.
    let known: usize = tallies.iter().map(|t| t.count).sum();
    if pods.len() > known {
        tallies.push(PodTally {
            phase: "Other".into(),
            count: pods.len() - known,
        });
    }
    tallies
}

fn quota_views(quotas: Vec<ResourceQuota>) -> Vec<QuotaView> {
    quotas
        .into_iter()
        .map(|q| {
            let name = q.name_any();
            let status = q.status.unwrap_or_default();
            let hard = status.hard.unwrap_or_default();
            let used = status.used.unwrap_or_default();

            QuotaView {
                name,
                // Driven by `hard`: a quota with no limit on a resource
                // is not a constraint worth a row, however much is used.
                entries: hard
                    .iter()
                    .map(|(resource, limit)| QuotaEntry {
                        resource: resource.clone(),
                        used: used
                            .get(resource)
                            .map(|q| q.0.clone())
                            .unwrap_or_else(|| "0".into()),
                        hard: limit.0.clone(),
                    })
                    .collect(),
            }
        })
        .collect()
}

pub async fn get_namespace(session: &Session, name: &str) -> Result<NamespaceDetail> {
    let client = session.client().await?;
    let api: Api<Namespace> = Api::all(client.clone());
    let ns = api.get(name).await?;

    let pods: Api<Pod> = Api::namespaced(client.clone(), name);
    let pod_list = pods.list(&ListParams::default()).await?.items;

    // A namespace with no quota is the common case, and RBAC may forbid
    // listing them even where the namespace itself is readable. Neither
    // should turn the whole detail view into an error page.
    let quotas: Api<ResourceQuota> = Api::namespaced(client, name);
    let quotas = quotas
        .list(&ListParams::default())
        .await
        .map(|l| l.items)
        .unwrap_or_default();

    namespace_detail_from(ns, &pod_list, quotas)
}

/// Builds the namespace detail from the namespace and its contents.
///
/// Split from the fetch so the two things this page exists to answer —
/// what is unhealthy inside, and what is capping it — can be tested
/// without a cluster.
pub(crate) fn namespace_detail_from(
    mut ns: Namespace,
    pod_list: &[Pod],
    quotas: Vec<ResourceQuota>,
) -> Result<NamespaceDetail> {
    ns.metadata.managed_fields = None;

    let yaml = to_yaml(&ns)?;
    let quotas = quota_views(quotas);

    Ok(NamespaceDetail {
        api_version: "v1".into(),
        kind: "Namespace".into(),
        age: age(&ns),
        phase: ns
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        labels: sorted_pairs(ns.labels()),
        annotations: sorted_pairs(ns.annotations()),
        finalizers: ns.finalizers().to_vec(),
        pod_count: pod_list.len(),
        pods_by_phase: tally(pod_list),
        quotas,
        name: ns.name_any(),
        yaml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{PodStatus, ResourceQuotaStatus};
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn pod(phase: Option<&str>) -> Pod {
        Pod {
            status: Some(PodStatus {
                phase: phase.map(str::to_string),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn tally_leads_with_the_phases_that_need_attention() {
        let pods = vec![
            pod(Some("Running")),
            pod(Some("Running")),
            pod(Some("Pending")),
            pod(Some("Failed")),
        ];
        let got = tally(&pods);
        let order: Vec<_> = got.iter().map(|t| t.phase.as_str()).collect();
        assert_eq!(order, vec!["Failed", "Pending", "Running"]);
        assert_eq!(got[2].count, 2);
    }

    #[test]
    fn tally_omits_phases_with_nothing_in_them() {
        let got = tally(&[pod(Some("Running"))]);
        assert_eq!(got.len(), 1, "a row of zeroes is noise: {got:?}");
    }

    #[test]
    fn a_pod_with_no_phase_counts_as_unknown() {
        let got = tally(&[pod(None)]);
        assert_eq!(got[0].phase, "Unknown");
        assert_eq!(got[0].count, 1);
    }

    #[test]
    fn an_unrecognised_phase_still_reaches_the_total() {
        // The API can grow phases we have not heard of. Dropping them
        // would make the tally disagree with the pod count beside it.
        let pods = vec![pod(Some("Running")), pod(Some("Sideways"))];
        let got = tally(&pods);
        assert_eq!(got.iter().map(|t| t.count).sum::<usize>(), 2);
        assert!(got.iter().any(|t| t.phase == "Other"));
    }

    #[test]
    fn quota_rows_come_from_hard_limits_and_default_used_to_zero() {
        let mut hard = std::collections::BTreeMap::new();
        hard.insert("limits.cpu".to_string(), Quantity("4".into()));
        hard.insert("pods".to_string(), Quantity("10".into()));

        let mut used = std::collections::BTreeMap::new();
        used.insert("pods".to_string(), Quantity("3".into()));

        let views = quota_views(vec![ResourceQuota {
            metadata: kube::api::ObjectMeta {
                name: Some("compute".into()),
                ..Default::default()
            },
            status: Some(ResourceQuotaStatus {
                hard: Some(hard),
                used: Some(used),
            }),
            ..Default::default()
        }]);

        assert_eq!(views[0].name, "compute");
        let cpu = views[0]
            .entries
            .iter()
            .find(|e| e.resource == "limits.cpu")
            .expect("a hard limit always gets a row");
        // Nothing reported as used means none is used, not "unknown".
        assert_eq!(cpu.used, "0");
        assert_eq!(cpu.hard, "4");

        let pods = views[0]
            .entries
            .iter()
            .find(|e| e.resource == "pods")
            .unwrap();
        assert_eq!(pods.used, "3");
    }

    fn namespace(name: &str, phase: Option<&str>) -> Namespace {
        Namespace {
            metadata: kube::core::ObjectMeta {
                name: Some(name.into()),
                ..Default::default()
            },
            status: Some(k8s_openapi::api::core::v1::NamespaceStatus {
                phase: phase.map(str::to_string),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_stuck_terminating_namespace_shows_the_finalizer_holding_it() {
        // A namespace that will not go away is always a finalizer nobody
        // is answering for, and naming it is the entire diagnosis.
        let mut ns = namespace("doomed", Some("Terminating"));
        ns.spec = Some(k8s_openapi::api::core::v1::NamespaceSpec {
            finalizers: Some(vec!["kubernetes".into()]),
        });
        ns.metadata.finalizers = Some(vec!["custom.io/cleanup".into()]);

        let detail = namespace_detail_from(ns, &[], Vec::new()).expect("build detail");
        assert_eq!(detail.phase, "Terminating");
        assert_eq!(detail.finalizers, vec!["custom.io/cleanup"]);
    }

    #[test]
    fn the_tally_always_adds_up_to_the_count_beside_it() {
        // These two numbers sit next to each other on the page. If they
        // disagree the page is visibly wrong, whichever one is right.
        let pods = vec![
            pod(Some("Running")),
            pod(Some("Running")),
            pod(Some("Failed")),
            pod(None),
            pod(Some("SomethingNew")),
        ];

        let detail = namespace_detail_from(namespace("prod", Some("Active")), &pods, Vec::new())
            .expect("build detail");

        assert_eq!(detail.pod_count, 5);
        assert_eq!(
            detail.pods_by_phase.iter().map(|t| t.count).sum::<usize>(),
            detail.pod_count
        );
        // Failed leads: it is what the namespace was opened to find.
        assert_eq!(detail.pods_by_phase[0].phase, "Failed");
    }

    #[test]
    fn an_empty_namespace_reports_no_pods_and_no_quotas() {
        let detail = namespace_detail_from(namespace("empty", Some("Active")), &[], Vec::new())
            .expect("build detail");
        assert_eq!(detail.pod_count, 0);
        assert!(detail.pods_by_phase.is_empty(), "no rows of zeroes");
        assert!(detail.quotas.is_empty());
        assert!(detail.finalizers.is_empty());
    }

    #[test]
    fn namespace_detail_carries_its_identity_and_strips_managed_fields() {
        let mut ns = namespace("prod", Some("Active"));
        ns.metadata.managed_fields = Some(vec![
            k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry {
                manager: Some("kube-apiserver".into()),
                ..Default::default()
            },
        ]);

        let detail = namespace_detail_from(ns, &[], Vec::new()).expect("build detail");
        assert_eq!(detail.api_version, "v1");
        assert_eq!(detail.kind, "Namespace");
        assert_eq!(detail.name, "prod");
        assert!(detail.yaml.contains("kind: Namespace"));
        assert!(!detail.yaml.contains("managedFields"));
    }

    #[test]
    fn a_namespace_with_no_status_reads_as_unknown() {
        let detail =
            namespace_detail_from(namespace("odd", None), &[], Vec::new()).expect("build detail");
        assert_eq!(detail.phase, "Unknown");
    }

    #[test]
    fn a_quota_with_no_status_yields_no_rows_rather_than_panicking() {
        let views = quota_views(vec![ResourceQuota::default()]);
        assert!(views[0].entries.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn reads_a_live_namespace_detail() {
        let session = crate::cluster::live::session().await;

        let detail = get_namespace(&session, "kube-system")
            .await
            .expect("get namespace");
        println!(
            "kube-system: {} pod(s), {:?}, {} quota(s)",
            detail.pod_count,
            detail.pods_by_phase,
            detail.quotas.len()
        );

        assert_eq!(detail.name, "kube-system");
        assert_eq!(detail.kind, "Namespace");
        assert_eq!(detail.phase, "Active");
        assert!(detail.pod_count > 0, "kube-system runs pods");
        assert_eq!(
            detail.pods_by_phase.iter().map(|t| t.count).sum::<usize>(),
            detail.pod_count,
            "the tally must agree with the count beside it"
        );
        assert!(detail.yaml.contains("kind: Namespace"));

        let events = crate::cluster::detail::list_namespace_events(&session, "kube-system")
            .await
            .expect("list namespace events");
        println!("{} event(s) in kube-system", events.len());
    }
}
