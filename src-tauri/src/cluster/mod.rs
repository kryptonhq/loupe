//! Kubeconfig discovery and the connected-cluster session.
//!
//! The desktop app is a client, not a controller: it authenticates as
//! whoever the user's kubeconfig says they are, and never holds
//! credentials of its own. Every request therefore carries the user's
//! identity, and the API server decides what they may see — the same
//! rule the in-cluster control plane follows, arrived at from the other
//! direction.

pub mod actions;
pub mod data;
pub mod detail;
pub mod discovery;
pub mod edit;
pub mod exec;
pub mod forward;
pub mod helm;
pub mod logs;
pub mod related;
pub mod resources;
pub mod table;
pub mod watch;

use std::collections::HashMap;
use std::sync::Arc;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::discovery::Discovery;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::error::{AppError, Result};

/// One entry from the kubeconfig's `contexts` list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    /// True for the kubeconfig's `current-context`, so the UI can
    /// preselect what `kubectl` would have used.
    pub is_current: bool,
}

/// Identity and version of the cluster we are connected to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub context: String,
    pub server: String,
    pub version: String,
    pub platform: String,
}

/// The active connection, plus the ones already established.
///
/// Switching cluster used to mean rebuilding everything: authenticate,
/// probe the version, then walk discovery — dozens of round trips on a
/// cluster with a few operators installed. Anyone running staging and
/// production switches constantly, and every switch cost several
/// seconds and all cached context.
///
/// So connections are retained rather than replaced. Coming back to a
/// cluster reuses its client *and* its discovery, which is the whole
/// difference between a switch that is instant and one that is a cold
/// start. A `kube::Client` is cheap to hold: it is a connection pool
/// that idles when nothing is using it.
///
/// `RwLock` rather than `Mutex` because reads (every resource listing)
/// vastly outnumber writes (switching context), and a listing that is
/// slow to return should not block other listings.
#[derive(Default)]
pub struct Session {
    inner: RwLock<Pool>,
}

#[derive(Default)]
struct Pool {
    /// Context name of the connection commands act on.
    active: Option<String>,
    /// Every connection established this session, by context.
    connections: HashMap<String, Connected>,
}

impl Pool {
    fn current(&self) -> Option<&Connected> {
        self.active.as_ref().and_then(|c| self.connections.get(c))
    }
}

struct Connected {
    client: kube::Client,
    info: ClusterInfo,
    /// Cached API discovery. Building it costs one request per group
    /// version — on a cluster with a dozen operators installed that is
    /// forty round trips, far too many to repeat per listing.
    discovery: Option<Arc<Discovery>>,
}

impl Session {
    /// Returns the active client, or `NotConnected` if `connect` has not
    /// run yet. Cloning a `kube::Client` is cheap — it shares one
    /// underlying connection pool.
    pub async fn client(&self) -> Result<kube::Client> {
        let guard = self.inner.read().await;
        guard
            .current()
            .map(|c| c.client.clone())
            .ok_or(AppError::NotConnected)
    }

    pub async fn info(&self) -> Option<ClusterInfo> {
        self.inner.read().await.current().map(|c| c.info.clone())
    }

    /// Every cluster connected to this session, active one first.
    ///
    /// What lets the UI offer an instant switch back, and say which
    /// clusters a switch will not have to re-establish.
    pub async fn connected(&self) -> Vec<ClusterInfo> {
        let guard = self.inner.read().await;
        let mut out: Vec<ClusterInfo> =
            guard.connections.values().map(|c| c.info.clone()).collect();
        out.sort_by(|a, b| {
            let active = |i: &ClusterInfo| Some(&i.context) != guard.active.as_ref();
            active(a).cmp(&active(b)).then(a.context.cmp(&b.context))
        });
        out
    }

    /// True when this context already has a connection, so switching to
    /// it costs nothing.
    ///
    /// The UI asks `connected()` instead, which it needs anyway to badge
    /// the picker; this is the direct form the tests use.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn is_connected(&self, context: &str) -> bool {
        self.inner.read().await.connections.contains_key(context)
    }

    /// Makes an already-established connection the active one.
    ///
    /// Returns None when there is nothing to switch to, so the caller
    /// can fall back to connecting properly.
    pub async fn activate(&self, context: &str) -> Option<ClusterInfo> {
        let mut guard = self.inner.write().await;
        let info = guard.connections.get(context).map(|c| c.info.clone())?;
        guard.active = Some(context.to_string());
        Some(info)
    }

    /// The cluster's API surface, built once and reused.
    pub async fn discovery(&self) -> Result<Arc<Discovery>> {
        if let Some(cached) = self
            .inner
            .read()
            .await
            .current()
            .and_then(|c| c.discovery.clone())
        {
            return Ok(cached);
        }
        self.refresh_discovery().await
    }

    /// Rebuilds discovery from the cluster.
    ///
    /// Needed because a CRD installed after connecting is invisible to a
    /// cached discovery, and "I just applied it and Loupe cannot see it"
    /// is the first thing an operator would hit.
    pub async fn refresh_discovery(&self) -> Result<Arc<Discovery>> {
        // Run the discovery walk without holding the lock: it is dozens
        // of round trips, and blocking every listing behind it would
        // freeze the UI on a slow cluster.
        let client = self.client().await?;
        let discovered = Arc::new(Discovery::new(client).run().await?);

        let mut guard = self.inner.write().await;
        if let Some(context) = guard.active.clone() {
            if let Some(connected) = guard.connections.get_mut(&context) {
                connected.discovery = Some(discovered.clone());
            }
        }
        Ok(discovered)
    }

    async fn set(&self, client: kube::Client, info: ClusterInfo) {
        let mut guard = self.inner.write().await;
        let context = info.context.clone();
        guard.connections.insert(
            context.clone(),
            Connected {
                client,
                info,
                discovery: None,
            },
        );
        guard.active = Some(context);
    }

    /// Drops one connection. When it was the active one, the session is
    /// left with nothing active rather than silently switching to
    /// another cluster the user did not ask for.
    pub async fn drop_context(&self, context: &str) {
        let mut guard = self.inner.write().await;
        guard.connections.remove(context);
        if guard.active.as_deref() == Some(context) {
            guard.active = None;
        }
    }

    /// Drops every connection.
    pub async fn clear(&self) {
        *self.inner.write().await = Pool::default();
    }
}

/// Shared handle stored in Tauri's managed state.
pub type SharedSession = Arc<Session>;

/// Reads the kubeconfig and lists its contexts.
///
/// This deliberately does not touch the network: enumerating contexts
/// must work while every cluster in the file is unreachable, otherwise
/// the app cannot start on a plane.
pub fn list_contexts() -> Result<Vec<ContextInfo>> {
    Ok(contexts_from(Kubeconfig::read()?))
}

/// Maps a parsed kubeconfig onto the UI's shape.
///
/// Split from `list_contexts` so the mapping can be tested without
/// touching the developer's real kubeconfig or fighting over the
/// KUBECONFIG environment variable.
fn contexts_from(cfg: Kubeconfig) -> Vec<ContextInfo> {
    let current = cfg.current_context.clone().unwrap_or_default();

    cfg.contexts
        .into_iter()
        .map(|ctx| {
            let c = ctx.context.unwrap_or_default();
            ContextInfo {
                is_current: ctx.name == current,
                name: ctx.name,
                cluster: c.cluster,
                // user is optional in the kubeconfig schema; a context
                // without one is unusual but should still be listed
                // rather than break the picker.
                user: c.user.unwrap_or_default(),
                namespace: c.namespace,
            }
        })
        .collect()
}

/// Connects to the named context and records it as the active session.
///
/// The version call doubles as a reachability and authentication probe,
/// so a context that resolves but cannot be talked to fails here rather
/// than on the first resource listing.
pub async fn connect(session: &Session, context: &str) -> Result<ClusterInfo> {
    // Already connected: make it active and return. This is the switch
    // that used to cost several seconds of re-authenticating and
    // re-walking discovery, and now costs nothing.
    if let Some(info) = session.activate(context).await {
        return Ok(info);
    }

    let kubeconfig = Kubeconfig::read()?;
    if !kubeconfig.contexts.iter().any(|c| c.name == context) {
        return Err(AppError::UnknownContext(context.to_string()));
    }

    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| AppError::Kubeconfig(e.to_string()))?;

    let server = config.cluster_url.to_string();
    let client = kube::Client::try_from(config)?;
    let version = client.apiserver_version().await?;

    let info = ClusterInfo {
        context: context.to_string(),
        server,
        version: version.git_version.clone(),
        platform: version.platform.clone(),
    };
    session.set(client, info.clone()).await;
    Ok(info)
}

/// Shared setup for the live-cluster tests spread across this module.
///
/// They are ignored by default because they need a reachable cluster,
/// which neither CI nor a fresh checkout has. Run them against a local
/// cluster with:
///
///   LOUPE_TEST_CONTEXT=orbstack cargo test -- --ignored --nocapture
#[cfg(test)]
pub(crate) mod live {
    use super::*;

    pub(crate) async fn session() -> Session {
        let context = std::env::var("LOUPE_TEST_CONTEXT")
            .expect("set LOUPE_TEST_CONTEXT to a context in your kubeconfig");
        let session = Session::default();
        connect(&session, &context)
            .await
            .unwrap_or_else(|e| panic!("connect to {context}: {e}"));
        session
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kubeconfig(yaml: &str) -> Kubeconfig {
        serde_yaml::from_str(yaml).expect("parse test kubeconfig")
    }

    #[test]
    fn maps_contexts_and_marks_the_current_one() {
        let cfg = kubeconfig(
            r#"
apiVersion: v1
kind: Config
current-context: staging
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
      namespace: payments
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
"#,
        );

        let got = contexts_from(cfg);
        assert_eq!(got.len(), 2);

        assert_eq!(got[0].name, "prod");
        assert_eq!(got[0].cluster, "prod-cluster");
        assert_eq!(got[0].namespace.as_deref(), Some("payments"));
        assert!(!got[0].is_current);

        assert_eq!(got[1].name, "staging");
        assert!(got[1].is_current, "current-context should be flagged");
        assert_eq!(got[1].namespace, None);
    }

    // A context missing its user is malformed, but refusing to list it
    // would hide every other context in the file behind one bad entry.
    #[test]
    fn tolerates_a_context_without_a_user() {
        let cfg = kubeconfig(
            r#"
apiVersion: v1
kind: Config
contexts:
  - name: broken
    context:
      cluster: some-cluster
"#,
        );

        let got = contexts_from(cfg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].user, "");
        assert_eq!(got[0].cluster, "some-cluster");
    }

    #[test]
    fn no_current_context_marks_nothing_current() {
        let cfg = kubeconfig(
            r#"
apiVersion: v1
kind: Config
contexts:
  - name: only
    context:
      cluster: c
      user: u
"#,
        );

        assert!(contexts_from(cfg).iter().all(|c| !c.is_current));
    }

    /// A connection without a cluster behind it, for exercising the
    /// pool's bookkeeping. Everything asserted below is about which
    /// connection is active and which are retained, none of which needs
    /// a reachable API server.
    async fn pooled(session: &Session, context: &str) {
        let info = ClusterInfo {
            context: context.to_string(),
            server: format!("https://{context}:6443"),
            version: "v1.33.1".into(),
            platform: "linux/arm64".into(),
        };
        let mut guard = session.inner.write().await;
        guard.connections.insert(
            context.to_string(),
            Connected {
                // Never used: no test here makes a request.
                client: kube::Client::try_from(kube::Config::new(
                    "https://127.0.0.1:6443".parse().unwrap(),
                ))
                .expect("build a client"),
                info,
                discovery: None,
            },
        );
        guard.active = Some(context.to_string());
    }

    #[tokio::test]
    async fn a_second_cluster_does_not_replace_the_first() {
        // The point of the pool: coming back to a cluster reuses its
        // client and its discovery rather than starting cold.
        let session = Session::default();
        pooled(&session, "staging").await;
        pooled(&session, "prod").await;

        assert!(session.is_connected("staging").await);
        assert!(session.is_connected("prod").await);
        assert_eq!(
            session.info().await.map(|i| i.context).as_deref(),
            Some("prod")
        );
    }

    #[tokio::test]
    async fn switching_back_is_instant_and_needs_no_kubeconfig() {
        let session = Session::default();
        pooled(&session, "staging").await;
        pooled(&session, "prod").await;

        let switched = session.activate("staging").await;
        assert_eq!(switched.map(|i| i.context).as_deref(), Some("staging"));
        assert_eq!(
            session.info().await.map(|i| i.context).as_deref(),
            Some("staging")
        );
    }

    #[tokio::test]
    async fn activating_an_unconnected_context_says_so() {
        // The caller falls back to connecting properly; answering with
        // some other cluster would be much worse than answering nothing.
        let session = Session::default();
        pooled(&session, "staging").await;
        assert!(session.activate("never-seen").await.is_none());
    }

    #[tokio::test]
    async fn the_active_cluster_is_listed_first() {
        // It is the one the user is looking at, so it leads.
        let session = Session::default();
        pooled(&session, "zeta").await;
        pooled(&session, "alpha").await;

        let names: Vec<String> = session
            .connected()
            .await
            .into_iter()
            .map(|i| i.context)
            .collect();
        assert_eq!(names, ["alpha", "zeta"]);
    }

    #[tokio::test]
    async fn dropping_the_active_cluster_leaves_nothing_active() {
        // Silently switching to another cluster the user did not ask for
        // is how a command lands somewhere unexpected.
        let session = Session::default();
        pooled(&session, "staging").await;
        pooled(&session, "prod").await;

        session.drop_context("prod").await;

        assert!(session.info().await.is_none());
        assert!(matches!(
            session.client().await,
            Err(AppError::NotConnected)
        ));
        // The other connection survives.
        assert!(session.is_connected("staging").await);
    }

    #[tokio::test]
    async fn dropping_an_inactive_cluster_leaves_the_active_one_alone() {
        let session = Session::default();
        pooled(&session, "staging").await;
        pooled(&session, "prod").await;

        session.drop_context("staging").await;

        assert_eq!(
            session.info().await.map(|i| i.context).as_deref(),
            Some("prod")
        );
        assert!(!session.is_connected("staging").await);
    }

    #[tokio::test]
    async fn clearing_drops_every_connection() {
        let session = Session::default();
        pooled(&session, "staging").await;
        pooled(&session, "prod").await;

        session.clear().await;

        assert!(session.connected().await.is_empty());
        assert!(session.info().await.is_none());
    }

    #[tokio::test]
    async fn session_starts_disconnected() {
        let session = Session::default();
        assert!(session.info().await.is_none());
        assert!(session.connected().await.is_empty());
        // Commands must fail loudly rather than fall back to some
        // ambient default cluster.
        assert!(matches!(
            session.client().await,
            Err(AppError::NotConnected)
        ));
    }

    /// End-to-end against a real cluster: connect, then read.
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn connects_to_a_live_cluster_and_lists_resources() {
        let session = live::session().await;
        let info = session.info().await.expect("connected");
        println!("connected to {} ({})", info.context, info.version);
        assert!(!info.version.is_empty(), "apiserver reported no version");

        let nodes = resources::list_nodes(&session).await.expect("list nodes");
        println!("{} node(s)", nodes.len());
        assert!(!nodes.is_empty(), "a live cluster should have a node");

        let namespaces = resources::list_namespaces(&session)
            .await
            .expect("list namespaces");
        println!("{} namespace(s)", namespaces.len());
        // Every cluster has kube-system; its absence means we parsed
        // the response wrong rather than that the cluster is empty.
        assert!(namespaces.iter().any(|n| n.name == "kube-system"));

        let pods = resources::list_pods(&session, None)
            .await
            .expect("list pods");
        println!("{} pod(s) across all namespaces", pods.len());

        session.clear().await;
        assert!(session.info().await.is_none());
    }
}
