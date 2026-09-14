//! Cluster-wide search: find any object of any kind by a fragment of its
//! name.
//!
//! The palette's filter used to match only what a listing had already
//! loaded, which is not "find" — it is "find among the fifty rows you are
//! looking at". This keeps an index of every object's name, namespace and
//! one status word, per connected cluster, built in the background from
//! lists the API server prints anyway.
//!
//! What is indexed, and what is not:
//!
//! - Names, namespaces and kinds, for every kind discovery says can be
//!   listed. A CRD installed after connecting joins the next time
//!   discovery is refreshed, with no upgrade and no reconnect.
//! - One status word per object, taken from the printed table's Status,
//!   Phase, Ready or State column — the cell `kubectl get` would show.
//! - **Never a Secret's contents.** Secrets are indexed by name only, and
//!   the list that indexes them is parsed for name and namespace and
//!   nothing else.
//! - No Events: thousands of short-lived objects nobody searches for by
//!   name, and the churn would keep the index permanently stale.
//!
//! The index is a snapshot, not a watch. Kinds are re-listed when a
//! search finds them older than `STALE_AFTER`, so a result is at most a
//! few minutes behind — and opening one that has since gone says so in
//! the detail view, which is the right place to learn it.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use kube::api::ListParams;
use kube::core::ApiResource;
use serde::Serialize;

use crate::cluster::discovery::{list_api_resources, ApiResourceInfo};
use crate::cluster::table::{fetch_page, ResourceTable};
use crate::cluster::Session;
use crate::error::Result;

/// How many kinds are listed at once. Enough that a cluster with sixty
/// kinds warms in seconds; few enough that warming is not a burst the API
/// server's priority and fairness has to shed.
const CONCURRENCY: usize = 4;

/// Objects per page, for a continuation the server chose to send.
const PAGE: u32 = 500;

/// A kind indexed longer ago than this is listed again the next time a
/// search runs. The search answers from what it has meanwhile.
const STALE_AFTER: Duration = Duration::from_secs(5 * 60);

/// A kind that failed for a reason other than RBAC is retried after this.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// Results returned for one query. The palette shows fewer; the rest is
/// headroom for grouping by kind without a second round trip.
const MAX_HITS: usize = 60;
const MAX_PER_KIND: usize = 10;

/// Kinds indexed first, because they are what people search for. The
/// rest follow in discovery order.
const PRIORITY: [(&str, &str); 5] = [
    ("", "Pod"),
    ("apps", "Deployment"),
    ("", "Service"),
    ("", "ConfigMap"),
    ("", "Secret"),
];

/// Kinds never indexed. See the module comment.
fn excluded(group: &str, kind: &str) -> bool {
    kind == "Event" && (group.is_empty() || group == "events.k8s.io")
}

/// Kinds whose table is not read for a status. A Secret's printed table
/// holds only its type and key count, but the rule is simpler to trust
/// if nothing about a Secret beyond its name is kept.
fn name_only(group: &str, kind: &str) -> bool {
    group.is_empty() && kind == "Secret"
}

type KindKey = String;

fn key_of(info: &ApiResourceInfo) -> KindKey {
    format!("{}/{}/{}", info.group, info.version, info.kind)
}

/// One indexed object. Namespace and status are shared across objects
/// through the interner: a cluster has thousands of pods and a handful of
/// distinct namespaces and phases.
#[derive(Debug, Clone)]
struct Obj {
    name: Box<str>,
    namespace: Option<Arc<str>>,
    status: Option<Arc<str>>,
}

#[derive(Debug)]
struct Kind {
    info: Arc<ApiResourceInfo>,
    objects: Vec<Obj>,
    indexed_at: Instant,
}

#[derive(Default)]
struct Interner(HashMap<Box<str>, Arc<str>>);

impl Interner {
    fn get(&mut self, s: &str) -> Arc<str> {
        if let Some(found) = self.0.get(s) {
            return found.clone();
        }
        let shared: Arc<str> = Arc::from(s);
        self.0.insert(s.into(), shared.clone());
        shared
    }
}

#[derive(Default)]
struct Data {
    /// Which cluster this is an index of. A search against a different
    /// active context throws everything away rather than answering with
    /// another cluster's names.
    context: String,
    /// Bumped whenever the index is reset, so a warmer still listing the
    /// previous cluster cannot write its results into the new one.
    generation: u64,
    kinds: BTreeMap<KindKey, Kind>,
    forbidden: BTreeSet<KindKey>,
    failed: BTreeMap<KindKey, (String, Instant)>,
    queue: VecDeque<Arc<ApiResourceInfo>>,
    in_flight: BTreeSet<KindKey>,
    warming: bool,
    /// Kinds discovery offered at the last search, after exclusions.
    total: usize,
    interner: Interner,
}

#[derive(Default)]
pub struct SearchIndex {
    data: SyncMutex<Data>,
}

/// One match.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    /// The one-word read from the printed table, when the kind has one.
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<Hit>,
    /// Kinds indexed so far, of `total_kinds`.
    pub indexed_kinds: usize,
    pub total_kinds: usize,
    /// Kinds RBAC would not let this user list. Said once, as a count,
    /// rather than silently absent from results.
    pub forbidden_kinds: usize,
    pub failed_kinds: usize,
    pub objects: usize,
    /// True while kinds are still being listed, so an empty result can
    /// say "still indexing" rather than "nothing matches".
    pub warming: bool,
    /// Approximate memory held by the index, for the handoff's ceiling.
    pub approx_bytes: usize,
}

impl SearchIndex {
    /// Answers `query` from the index as it stands, and queues whatever
    /// the index is missing or holding stale.
    ///
    /// Never waits on the cluster. The first search after connecting may
    /// find little; it says so, and the next keystroke finds more.
    pub async fn search(&'static self, session: &Session, query: &str) -> Result<SearchResponse> {
        let context = session
            .info()
            .await
            .map(|i| i.context)
            .ok_or(crate::error::AppError::NotConnected)?;
        let kinds = list_api_resources(session).await?;

        let start_warmer = {
            let mut data = self.data.lock().expect("search index poisoned");
            if data.context != context {
                reset(&mut data, &context);
            }
            plan(&mut data, &kinds, Instant::now());
            let start = !data.warming && !data.queue.is_empty();
            if start {
                data.warming = true;
            }
            start.then_some(data.generation)
        };

        if let Some(generation) = start_warmer {
            let client = session.client().await?;
            tokio::spawn(warm(self, client, generation));
        }

        let data = self.data.lock().expect("search index poisoned");
        Ok(respond(&data, query))
    }

    /// Drops everything. Called on disconnect, so a closed cluster's
    /// names do not stay in memory.
    pub fn clear(&self) {
        let mut data = self.data.lock().expect("search index poisoned");
        let generation = data.generation + 1;
        *data = Data {
            generation,
            ..Data::default()
        };
    }
}

fn reset(data: &mut Data, context: &str) {
    let generation = data.generation + 1;
    *data = Data {
        context: context.to_string(),
        generation,
        ..Data::default()
    };
}

/// Decides which kinds need listing, in priority order.
fn plan(data: &mut Data, kinds: &[ApiResourceInfo], now: Instant) {
    let mut wanted: Vec<&ApiResourceInfo> = kinds
        .iter()
        .filter(|k| !excluded(&k.group, &k.kind))
        .collect();
    wanted.sort_by_key(|k| {
        PRIORITY
            .iter()
            .position(|(g, kind)| *g == k.group && *kind == k.kind)
            .unwrap_or(PRIORITY.len())
    });
    data.total = wanted.len();

    let queued: BTreeSet<KindKey> = data.queue.iter().map(|k| key_of(k)).collect();
    for info in wanted {
        let key = key_of(info);
        if data.in_flight.contains(&key) || queued.contains(&key) || data.forbidden.contains(&key) {
            continue;
        }
        if let Some((_, at)) = data.failed.get(&key) {
            if now.duration_since(*at) < RETRY_AFTER {
                continue;
            }
        }
        let needed = match data.kinds.get(&key) {
            None => true,
            Some(kind) => now.duration_since(kind.indexed_at) >= STALE_AFTER,
        };
        if needed {
            data.queue.push_back(Arc::new(info.clone()));
        }
    }

    // A kind discovery no longer serves — a CRD that was deleted — goes.
    let served: BTreeSet<KindKey> = kinds.iter().map(key_of).collect();
    data.kinds.retain(|k, _| served.contains(k));
}

/// Lists queued kinds until the queue is empty, then stops.
async fn warm(index: &'static SearchIndex, client: kube::Client, generation: u64) {
    let next = move || {
        let mut data = index.data.lock().expect("search index poisoned");
        if data.generation != generation {
            return None;
        }
        let info = data.queue.pop_front()?;
        data.in_flight.insert(key_of(&info));
        Some(info)
    };

    loop {
        let batch: Vec<Arc<ApiResourceInfo>> = std::iter::from_fn(next).take(CONCURRENCY).collect();
        if batch.is_empty() {
            break;
        }
        let results: Vec<_> = stream::iter(batch)
            .map(|info| {
                let client = client.clone();
                async move {
                    let result = list_kind(&client, &info).await;
                    (info, result)
                }
            })
            .buffer_unordered(CONCURRENCY)
            .collect()
            .await;

        let mut data = index.data.lock().expect("search index poisoned");
        if data.generation != generation {
            return;
        }
        for (info, result) in results {
            record(&mut data, info, result, Instant::now());
        }
    }

    let mut data = index.data.lock().expect("search index poisoned");
    if data.generation == generation {
        data.warming = false;
    }
}

/// Stores one kind's listing, or the reason there is none.
fn record(
    data: &mut Data,
    info: Arc<ApiResourceInfo>,
    result: std::result::Result<Vec<ResourceTable>, kube::Error>,
    now: Instant,
) {
    let key = key_of(&info);
    data.in_flight.remove(&key);
    match result {
        Ok(pages) => {
            data.failed.remove(&key);
            let objects = objects_from(&info, pages, &mut data.interner);
            data.kinds.insert(
                key,
                Kind {
                    info,
                    objects,
                    indexed_at: now,
                },
            );
        }
        Err(kube::Error::Api(status)) if status.code == 403 => {
            data.kinds.remove(&key);
            data.forbidden.insert(key);
        }
        Err(e) => {
            data.failed.insert(key, (e.to_string(), now));
        }
    }
}

/// Every page of one kind, across all namespaces.
async fn list_kind(
    client: &kube::Client,
    info: &ApiResourceInfo,
) -> std::result::Result<Vec<ResourceTable>, kube::Error> {
    let resource = ApiResource {
        group: info.group.clone(),
        version: info.version.clone(),
        api_version: info.api_version.clone(),
        kind: info.kind.clone(),
        plural: info.plural.clone(),
    };
    let mut pages = Vec::new();
    // From the API server's watch cache (`resourceVersion=0`), which is
    // the read that costs it least — no trip to etcd.
    //
    // Unpaged, deliberately. A limit alongside `resourceVersion=0` is not
    // honoured consistently across server versions, so kube drops the
    // resource version whenever a limit is set, and the read would go to
    // etcd instead. A cache read of one kind's names is the cheaper of the
    // two. If the server pages anyway, the continuation is followed.
    let mut params = ListParams::default().match_any();
    loop {
        let page = fetch_page(client, &resource, info.namespaced, None, &params).await?;
        let next = page.continue_token.clone();
        pages.push(page);
        match next {
            Some(token) => {
                params = ListParams::default().limit(PAGE);
                params.continue_token = Some(token);
            }
            None => return Ok(pages),
        }
    }
}

/// The printed column that reads as a status, if the kind has one.
fn status_column(table: &ResourceTable) -> Option<usize> {
    const NAMES: [&str; 4] = ["status", "phase", "ready", "state"];
    NAMES.iter().find_map(|wanted| {
        table
            .columns
            .iter()
            .position(|c| c.priority == 0 && c.name.eq_ignore_ascii_case(wanted))
    })
}

fn objects_from(
    info: &ApiResourceInfo,
    pages: Vec<ResourceTable>,
    interner: &mut Interner,
) -> Vec<Obj> {
    let with_status = !name_only(&info.group, &info.kind);
    let mut out = Vec::new();
    for page in pages {
        let column = if with_status {
            status_column(&page)
        } else {
            None
        };
        for row in page.rows {
            let status = column
                .and_then(|i| row.cells.get(i))
                .filter(|s| !s.is_empty() && s.as_str() != "<none>")
                .map(|s| interner.get(s));
            out.push(Obj {
                name: row.name.into_boxed_str(),
                namespace: row.namespace.as_deref().map(|n| interner.get(n)),
                status,
            });
        }
    }
    out.shrink_to_fit();
    out
}

/// Whether `needle` (already lowercase) occurs in `hay`, ignoring ASCII
/// case, and where. Names are DNS labels in practice, so ASCII folding
/// is enough and avoids holding a lowercase copy of every name.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    if n.is_empty() || n.len() > h.len() {
        return if n.is_empty() { Some(0) } else { None };
    }
    h.windows(n.len()).position(|w| w.eq_ignore_ascii_case(n))
}

/// How well one object matches. Zero means it does not.
///
/// Every term must match somewhere. A term matching the start of the
/// name ranks above one inside it, which ranks above a term that only
/// matches the namespace or kind — so "api prod" finds `api-7d9` in
/// `prod` first, not everything in `prod` with an "api" somewhere.
fn score(obj: &Obj, kind: &str, terms: &[String]) -> u32 {
    let mut total = 0;
    for term in terms {
        let s = match find_ci(&obj.name, term) {
            Some(0) => 3_000 - (obj.name.len() as u32).min(999),
            Some(at) => 2_000 - (at as u32).min(999),
            None => {
                let elsewhere = obj
                    .namespace
                    .as_deref()
                    .is_some_and(|n| find_ci(n, term).is_some())
                    || find_ci(kind, term).is_some();
                if elsewhere {
                    500
                } else {
                    return 0;
                }
            }
        };
        total += s;
    }
    total
}

fn respond(data: &Data, query: &str) -> SearchResponse {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.to_ascii_lowercase())
        .collect();

    let mut scored: Vec<(u32, &Kind, &Obj)> = Vec::new();
    // Two characters is where a name fragment starts to mean something;
    // one would match most of the cluster.
    if terms.iter().map(|t| t.len()).sum::<usize>() >= 2 {
        for kind in data.kinds.values() {
            for obj in &kind.objects {
                let s = score(obj, &kind.info.kind, &terms);
                if s > 0 {
                    scored.push((s, kind, obj));
                }
            }
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.2.name.cmp(&b.2.name))
            .then_with(|| a.1.info.kind.cmp(&b.1.info.kind))
    });

    let mut per_kind: HashMap<&str, usize> = HashMap::new();
    let hits = scored
        .into_iter()
        .filter(|(_, kind, _)| {
            let n = per_kind.entry(kind.info.kind.as_str()).or_default();
            *n += 1;
            *n <= MAX_PER_KIND
        })
        .take(MAX_HITS)
        .map(|(_, kind, obj)| Hit {
            group: kind.info.group.clone(),
            version: kind.info.version.clone(),
            kind: kind.info.kind.clone(),
            namespace: obj.namespace.as_deref().map(str::to_string),
            name: obj.name.to_string(),
            status: obj.status.as_deref().map(str::to_string),
        })
        .collect();

    SearchResponse {
        hits,
        indexed_kinds: data.kinds.len(),
        total_kinds: data.total,
        forbidden_kinds: data.forbidden.len(),
        failed_kinds: data.failed.len(),
        objects: data.kinds.values().map(|k| k.objects.len()).sum(),
        warming: data.warming,
        approx_bytes: approx_bytes(data),
    }
}

/// What the index holds, in bytes, counted rather than guessed: every
/// allocation the index owns, including the interner's shared strings
/// once each.
fn approx_bytes(data: &Data) -> usize {
    use std::mem::size_of;
    let mut total = 0;
    for (key, kind) in &data.kinds {
        total += key.capacity() + size_of::<(KindKey, Kind)>();
        total += size_of::<ApiResourceInfo>()
            + kind.info.group.capacity()
            + kind.info.version.capacity()
            + kind.info.kind.capacity()
            + kind.info.plural.capacity()
            + kind.info.api_version.capacity()
            + kind
                .info
                .verbs
                .iter()
                .map(|v| v.capacity() + size_of::<String>())
                .sum::<usize>();
        total += kind.objects.capacity() * size_of::<Obj>();
        total += kind.objects.iter().map(|o| o.name.len()).sum::<usize>();
    }
    for (k, v) in &data.interner.0 {
        // The key and the shared value are separate allocations; the Arc
        // header is two counters.
        total += k.len() + v.len() + 2 * size_of::<usize>() + size_of::<(Box<str>, Arc<str>)>();
    }
    total
}

#[cfg(test)]
mod live_tests;

#[cfg(test)]
mod tests;
