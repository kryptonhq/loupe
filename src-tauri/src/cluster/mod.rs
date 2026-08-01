//! Kubeconfig discovery and the connected-cluster session.
//!
//! The desktop app is a client, not a controller: it authenticates as
//! whoever the user's kubeconfig says they are, and never holds
//! credentials of its own. Every request therefore carries the user's
//! identity, and the API server decides what they may see — the same
//! rule the in-cluster control plane follows, arrived at from the other
//! direction.

pub mod detail;
pub mod discovery;
pub mod edit;
pub mod helm;
pub mod logs;
pub mod resources;

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

/// The active connection, shared across commands.
///
/// `RwLock` rather than `Mutex` because reads (every resource listing)
/// vastly outnumber writes (switching context), and a listing that is
/// slow to return should not block other listings.
#[derive(Default)]
pub struct Session {
    inner: RwLock<Option<Connected>>,
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
            .as_ref()
            .map(|c| c.client.clone())
            .ok_or(AppError::NotConnected)
    }

    pub async fn info(&self) -> Option<ClusterInfo> {
        self.inner.read().await.as_ref().map(|c| c.info.clone())
    }

    /// The cluster's API surface, built once and reused.
    pub async fn discovery(&self) -> Result<Arc<Discovery>> {
        if let Some(cached) = self.inner.read().await.as_ref().and_then(|c| c.discovery.clone()) {
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

        if let Some(connected) = self.inner.write().await.as_mut() {
            connected.discovery = Some(discovered.clone());
        }
        Ok(discovered)
    }

    async fn set(&self, client: kube::Client, info: ClusterInfo) {
        *self.inner.write().await = Some(Connected {
            client,
            info,
            discovery: None,
        });
    }

    pub async fn clear(&self) {
        *self.inner.write().await = None;
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

    #[tokio::test]
    async fn session_starts_disconnected() {
        let session = Session::default();
        assert!(session.info().await.is_none());
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
