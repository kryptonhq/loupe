//! Port forwarding.
//!
//! One of the few Kubernetes workflows where the CLI is genuinely bad
//! and a desktop app is genuinely better. A terminal gives you one
//! forward per window, no memory of what you had open, and a connection
//! that dies on pod churn without telling you. That gap — a stateful,
//! long-lived thing the CLI handles poorly — is where a GUI earns its
//! place.
//!
//! Two decisions shape the implementation.
//!
//! The listener binds to loopback only. A forward is a hole into a
//! cluster, and binding it to every interface would put that hole on
//! whatever network the laptop is on.
//!
//! The target pod is resolved *per TCP connection*, not once when the
//! forward is created. That is what makes churn survivable without any
//! reconnection machinery: when a pod is replaced, the next connection
//! simply resolves to a live one. A forward aimed at a Service keeps
//! working across a rollout for the same reason.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{Api, ListParams, ResourceExt};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::cluster::Session;
use crate::error::{AppError, Result};

/// What a forward points at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ForwardTarget {
    /// A specific pod. Dies with the pod, by definition.
    Pod { namespace: String, name: String },
    /// A Service, resolved to one of its pods per connection. Survives
    /// a rollout, because the next connection picks a live pod.
    Service { namespace: String, name: String },
}

impl ForwardTarget {
    fn namespace(&self) -> &str {
        match self {
            ForwardTarget::Pod { namespace, .. } => namespace,
            ForwardTarget::Service { namespace, .. } => namespace,
        }
    }

    /// Used by the tests and by callers that log a target; kept next to
    /// `namespace` so the pair stays obviously symmetric.
    #[cfg_attr(not(test), allow(dead_code))]
    fn name(&self) -> &str {
        match self {
            ForwardTarget::Pod { name, .. } => name,
            ForwardTarget::Service { name, .. } => name,
        }
    }
}

/// A forward as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    pub id: u64,
    pub target: ForwardTarget,
    pub local_port: u16,
    pub remote_port: u16,
    /// Bytes moved in both directions, so a forward that is doing
    /// nothing is distinguishable from one that is broken.
    pub bytes: u64,
    /// Connections served since it started.
    pub connections: u64,
    /// The last thing that went wrong, if anything. Kept rather than
    /// cleared so a forward that failed an hour ago still says why.
    pub last_error: Option<String>,
}

struct Running {
    target: ForwardTarget,
    local_port: u16,
    remote_port: u16,
    bytes: Arc<AtomicU64>,
    connections: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
    task: AbortHandle,
}

#[derive(Default)]
pub struct Forwards {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, Running>>,
}

impl Forwards {
    fn allocate(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Everything currently forwarding, newest last.
    pub async fn list(&self) -> Vec<ForwardView> {
        let active = self.active.lock().await;
        let mut out = Vec::with_capacity(active.len());
        for (id, running) in active.iter() {
            out.push(ForwardView {
                id: *id,
                target: running.target.clone(),
                local_port: running.local_port,
                remote_port: running.remote_port,
                bytes: running.bytes.load(Ordering::Relaxed),
                connections: running.connections.load(Ordering::Relaxed),
                last_error: running.last_error.lock().await.clone(),
            });
        }
        out.sort_by_key(|f| f.id);
        out
    }

    /// Stops a forward, releasing the local port. False means it was
    /// already gone.
    pub async fn stop(&self, id: u64) -> bool {
        match self.active.lock().await.remove(&id) {
            Some(running) => {
                running.task.abort();
                true
            }
            None => false,
        }
    }

    /// Stops everything. Called on disconnect and on quit: a forward
    /// into a cluster the user thinks they left is exactly the kind of
    /// thing that should not outlive the session.
    pub async fn stop_all(&self) {
        let mut active = self.active.lock().await;
        for (_, running) in active.drain() {
            running.task.abort();
        }
    }
}

/// Binds the local port, failing before anything else if it is taken.
///
/// Bound before the forward is registered so "that port is already in
/// use" is an error the user sees immediately, rather than a forward
/// that appears in the list and never works.
async fn bind(local_port: u16) -> Result<TcpListener> {
    // Loopback only. A forward is a hole into a cluster; binding it to
    // 0.0.0.0 would put that hole on whatever network this laptop is on.
    TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => AppError::Kube(format!(
                "port {local_port} is already in use on this machine"
            )),
            std::io::ErrorKind::PermissionDenied => AppError::Kube(format!(
                "port {local_port} needs privileges this app does not have — pick one above 1024"
            )),
            _ => AppError::Kube(format!("cannot listen on port {local_port}: {e}")),
        })
}

/// Starts forwarding, returning the id needed to stop it.
pub async fn start(
    session: &Session,
    forwards: &'static Forwards,
    target: ForwardTarget,
    local_port: u16,
    remote_port: u16,
) -> Result<ForwardView> {
    let client = session.client().await?;
    let listener = bind(local_port).await?;
    // The port the OS actually gave us, which matters when 0 was asked
    // for and the OS picked one.
    let bound = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(local_port);

    // Resolved once here so a target that does not exist fails now
    // rather than on the first connection, when nobody is watching.
    resolve_pod(&client, &target).await?;

    let id = forwards.allocate();
    let bytes = Arc::new(AtomicU64::new(0));
    let connections = Arc::new(AtomicU64::new(0));
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let task = {
        let target = target.clone();
        let bytes = bytes.clone();
        let connections = connections.clone();
        let last_error = last_error.clone();

        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    continue;
                };
                connections.fetch_add(1, Ordering::Relaxed);

                // Per connection: resolving here rather than once is
                // what makes pod churn survivable with no reconnection
                // machinery at all.
                let client = client.clone();
                let target = target.clone();
                let bytes = bytes.clone();
                let last_error = last_error.clone();

                tokio::spawn(async move {
                    if let Err(e) = serve(client, target, remote_port, socket, bytes).await {
                        *last_error.lock().await = Some(e.to_string());
                    }
                });
            }
        })
    };

    forwards.active.lock().await.insert(
        id,
        Running {
            target: target.clone(),
            local_port: bound,
            remote_port,
            bytes: bytes.clone(),
            connections: connections.clone(),
            last_error: last_error.clone(),
            task: task.abort_handle(),
        },
    );

    Ok(ForwardView {
        id,
        target,
        local_port: bound,
        remote_port,
        bytes: 0,
        connections: 0,
        last_error: None,
    })
}

/// Pipes one accepted connection through to the cluster.
async fn serve(
    client: kube::Client,
    target: ForwardTarget,
    remote_port: u16,
    mut socket: tokio::net::TcpStream,
    bytes: Arc<AtomicU64>,
) -> Result<()> {
    let pod = resolve_pod(&client, &target).await?;
    let api: Api<Pod> = Api::namespaced(client, target.namespace());

    let mut forwarder = api.portforward(&pod, &[remote_port]).await?;
    let mut upstream = forwarder
        .take_stream(remote_port)
        .ok_or_else(|| AppError::Kube(format!("the pod is not listening on {remote_port}")))?;

    let moved = splice(&mut socket, &mut upstream).await;
    bytes.fetch_add(moved, Ordering::Relaxed);

    // Joining lets kube close the websocket rather than leaving it
    // half-shut, which the API server eventually reaps but noisily.
    let _ = forwarder.join().await;
    Ok(())
}

/// Copies bytes both ways until either side closes, returning the total
/// moved.
///
/// Split from `serve` and written against any pair of streams so it can
/// be tested without a cluster or a socket. Both directions run at once
/// and the connection is over when either finishes — a half-open forward
/// reads to the user as a hang rather than as a closed connection.
pub(crate) async fn splice(
    local: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
    remote: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
) -> u64 {
    let (mut local_read, mut local_write) = tokio::io::split(local);
    let (mut remote_read, mut remote_write) = tokio::io::split(remote);

    let to_remote = async {
        let moved = tokio::io::copy(&mut local_read, &mut remote_write).await;
        // Shut down rather than just stopping: the far side needs to see
        // end-of-stream, or a protocol that waits for it hangs.
        let _ = remote_write.shutdown().await;
        moved
    };
    let to_local = async {
        let moved = tokio::io::copy(&mut remote_read, &mut local_write).await;
        let _ = local_write.shutdown().await;
        moved
    };

    let (sent, received) = tokio::join!(to_remote, to_local);
    sent.unwrap_or(0) + received.unwrap_or(0)
}

/// The selector a Service's pods carry, in the API server's own syntax.
///
/// Split out because it is the part with a decision in it: a Service
/// with no selector is backed by manually managed Endpoints and has no
/// pods to forward to, which is a real answer rather than an error to
/// paper over.
pub(crate) fn service_selector(service: &Service, name: &str) -> Result<String> {
    let selector = service
        .spec
        .as_ref()
        .and_then(|s| s.selector.as_ref())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Kube(format!(
                "{name} has no selector, so it has no pods to forward to — \
                 it is backed by manually managed Endpoints"
            ))
        })?;

    let mut pairs: Vec<String> = selector.iter().map(|(k, v)| format!("{k}={v}")).collect();
    // Sorted so the same Service always produces the same expression,
    // which keeps it comparable in logs and in tests.
    pairs.sort();
    Ok(pairs.join(","))
}

/// The pod a forward should reach right now.
///
/// For a Service this picks a running pod matching its selector, so a
/// forward keeps working across a rollout. "Running" rather than "any"
/// because forwarding to a Pending pod produces a connection that hangs
/// rather than one that fails.
async fn resolve_pod(client: &kube::Client, target: &ForwardTarget) -> Result<String> {
    match target {
        ForwardTarget::Pod { name, .. } => Ok(name.clone()),
        ForwardTarget::Service { namespace, name } => {
            let services: Api<Service> = Api::namespaced(client.clone(), namespace);
            let service = services.get(name).await?;

            let expression = service_selector(&service, name)?;

            let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
            let matching = pods
                .list(&ListParams::default().labels(&expression))
                .await?;

            matching
                .items
                .iter()
                .find(|p| {
                    p.status
                        .as_ref()
                        .and_then(|s| s.phase.as_deref())
                        .is_some_and(|phase| phase == "Running")
                })
                .map(|p| p.name_any())
                .ok_or_else(|| AppError::Kube(format!("{name} has no running pods to forward to")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_forward_binds_loopback_only() {
        // A forward is a hole into a cluster. On 0.0.0.0 that hole is on
        // whatever network the laptop happens to be on.
        let listener = bind(0).await.expect("bind an ephemeral port");
        let addr = listener.local_addr().expect("addr");
        assert!(addr.ip().is_loopback(), "bound to {addr}");
    }

    #[tokio::test]
    async fn a_port_already_in_use_says_so_before_anything_else() {
        // Reported as an error the user sees rather than as a forward
        // that appears in the list and never works.
        let held = bind(0).await.expect("bind");
        let port = held.local_addr().unwrap().port();

        let err = bind(port).await.unwrap_err();
        assert!(err.to_string().contains("already in use"), "got {err}");
    }

    #[tokio::test]
    async fn a_privileged_port_suggests_what_to_do() {
        // Only meaningful unprivileged; skipped when running as root,
        // where the bind would succeed.
        let Err(err) = bind(80).await else {
            return;
        };
        let message = err.to_string();
        assert!(
            message.contains("above 1024") || message.contains("already in use"),
            "got {message}"
        );
    }

    #[tokio::test]
    async fn starting_a_forward_requires_a_connection() {
        let session = Session::default();
        let forwards: &'static Forwards = Box::leak(Box::new(Forwards::default()));

        let result = start(
            &session,
            forwards,
            ForwardTarget::Pod {
                namespace: "default".into(),
                name: "api".into(),
            },
            0,
            8080,
        )
        .await;

        assert!(matches!(result, Err(AppError::NotConnected)));
    }

    fn service_with(selector: &[(&str, &str)]) -> Service {
        Service {
            spec: Some(k8s_openapi::api::core::v1::ServiceSpec {
                selector: if selector.is_empty() {
                    None
                } else {
                    Some(
                        selector
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect(),
                    )
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_services_selector_becomes_a_label_expression() {
        let expression = service_selector(&service_with(&[("app", "api"), ("tier", "web")]), "api")
            .expect("a selector");
        assert_eq!(expression, "app=api,tier=web");
    }

    #[test]
    fn the_expression_is_stable_for_the_same_service() {
        // Sorted, so it is comparable in a log line and in a test rather
        // than depending on map iteration order.
        let a = service_selector(&service_with(&[("b", "2"), ("a", "1")]), "x").unwrap();
        let b = service_selector(&service_with(&[("a", "1"), ("b", "2")]), "x").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_service_with_no_selector_says_why_it_cannot_be_forwarded() {
        // Backed by manually managed Endpoints. A real answer, and one
        // the user can act on — not a hang while nothing resolves.
        let err = service_selector(&service_with(&[]), "legacy").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("no selector"), "got {message}");
        assert!(message.contains("Endpoints"), "got {message}");
    }

    #[tokio::test]
    async fn bytes_move_in_both_directions() {
        // The forward's whole job. Both halves at once, because a
        // request and its response overlap on any real connection.
        let (mut client, mut local) = tokio::io::duplex(1024);
        let (mut remote, mut server) = tokio::io::duplex(1024);

        let client_side = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
            client.shutdown().await.unwrap();
            let mut got = Vec::new();
            client.read_to_end(&mut got).await.unwrap();
            got
        });

        let server_side = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut got = Vec::new();
            server.read_to_end(&mut got).await.unwrap();
            server.write_all(b"HTTP/1.1 200 OK").await.unwrap();
            server.shutdown().await.unwrap();
            got
        });

        let moved = splice(&mut local, &mut remote).await;

        let received_by_server = server_side.await.unwrap();
        let received_by_client = client_side.await.unwrap();

        assert_eq!(received_by_server, b"GET / HTTP/1.1\r\n\r\n");
        assert_eq!(received_by_client, b"HTTP/1.1 200 OK");
        // Counted both ways, which is what makes an idle forward
        // distinguishable from a broken one in the panel.
        assert_eq!(
            moved as usize,
            received_by_server.len() + received_by_client.len()
        );
    }

    #[tokio::test]
    async fn a_connection_that_sends_nothing_still_completes() {
        // A port scan, or a client that connects and gives up. It must
        // not leave the forward holding a half-open connection.
        let (client, mut local) = tokio::io::duplex(64);
        let (mut remote, server) = tokio::io::duplex(64);
        drop(client);
        drop(server);

        assert_eq!(splice(&mut local, &mut remote).await, 0);
    }

    #[tokio::test]
    async fn stopping_an_unknown_forward_is_not_an_error() {
        // The UI can stop one that ended on its own; that race is normal.
        let forwards = Forwards::default();
        assert!(!forwards.stop(4242).await);
    }

    #[tokio::test]
    async fn an_empty_registry_lists_nothing() {
        assert!(Forwards::default().list().await.is_empty());
    }

    #[tokio::test]
    async fn forward_ids_are_unique() {
        let forwards = Forwards::default();
        assert_ne!(forwards.allocate(), forwards.allocate());
    }

    #[test]
    fn a_target_knows_its_own_namespace_and_name() {
        let pod = ForwardTarget::Pod {
            namespace: "payments".into(),
            name: "api-7d9".into(),
        };
        assert_eq!(pod.namespace(), "payments");
        assert_eq!(pod.name(), "api-7d9");

        let service = ForwardTarget::Service {
            namespace: "payments".into(),
            name: "api".into(),
        };
        assert_eq!(service.namespace(), "payments");
        assert_eq!(service.name(), "api");
    }

    #[test]
    fn a_target_round_trips_across_the_ipc_boundary() {
        // The frontend sends these back to stop and restart forwards;
        // a tag mismatch would silently produce a different target.
        let target = ForwardTarget::Service {
            namespace: "payments".into(),
            name: "api".into(),
        };
        let json = serde_json::to_string(&target).unwrap();
        assert!(json.contains(r#""kind":"service""#), "got {json}");
        assert_eq!(
            serde_json::from_str::<ForwardTarget>(&json).unwrap(),
            target
        );
    }
}
