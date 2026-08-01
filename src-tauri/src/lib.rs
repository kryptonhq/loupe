//! Loupe — an open-source Kubernetes client.
//!
//! The Rust side owns all cluster access. The webview never sees a
//! kubeconfig, a token, or a raw API server URL it could exfiltrate; it
//! calls the commands below and receives summarised, already-shaped
//! data. That keeps the attack surface of a bundled browser engine away
//! from the user's credentials.

mod cluster;
mod error;

use cluster::{ClusterInfo, ContextInfo, SharedSession};
use error::Result;
use tauri::Manager;

#[tauri::command]
fn list_contexts() -> Result<Vec<ContextInfo>> {
    cluster::list_contexts()
}

#[tauri::command]
async fn connect(session: tauri::State<'_, SharedSession>, context: String) -> Result<ClusterInfo> {
    cluster::connect(session.inner(), &context).await
}

#[tauri::command]
async fn current_cluster(session: tauri::State<'_, SharedSession>) -> Result<Option<ClusterInfo>> {
    Ok(session.inner().info().await)
}

#[tauri::command]
async fn disconnect(session: tauri::State<'_, SharedSession>) -> Result<()> {
    // Followed log streams hold open connections to the cluster we are
    // leaving. Dropping the session alone would leave them running
    // against a cluster the user believes they disconnected from.
    log_streams().cancel_all().await;
    session.inner().clear().await;
    Ok(())
}

#[tauri::command]
async fn list_namespaces(
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<cluster::resources::NamespaceSummary>> {
    cluster::resources::list_namespaces(session.inner()).await
}

#[tauri::command]
async fn list_pods(
    session: tauri::State<'_, SharedSession>,
    namespace: Option<String>,
) -> Result<Vec<cluster::resources::PodSummary>> {
    cluster::resources::list_pods(session.inner(), namespace).await
}

#[tauri::command]
async fn list_nodes(
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<cluster::resources::NodeSummary>> {
    cluster::resources::list_nodes(session.inner()).await
}

#[tauri::command]
async fn get_pod(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<cluster::detail::PodDetail> {
    cluster::detail::get_pod(session.inner(), &namespace, &name).await
}

#[tauri::command]
async fn list_events(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<Vec<cluster::detail::EventView>> {
    cluster::detail::list_events(session.inner(), &namespace, &name).await
}

/// Starts a log stream and returns its id. Lines arrive on `channel`.
#[tauri::command]
async fn start_pod_logs(
    session: tauri::State<'_, SharedSession>,
    options: cluster::logs::LogOptions,
    channel: tauri::ipc::Channel<cluster::logs::LogEvent>,
) -> Result<u64> {
    cluster::logs::stream(session.inner(), log_streams(), options, channel).await
}

/// Cancels a stream. False means it had already ended by itself.
#[tauri::command]
async fn stop_pod_logs(id: u64) -> Result<bool> {
    Ok(log_streams().cancel(id).await)
}

/// The stream registry outlives any single command, and abort handles
/// must stay reachable to cancel a followed stream, so it is a process
/// singleton rather than Tauri-managed state.
fn log_streams() -> &'static cluster::logs::LogStreams {
    static STREAMS: std::sync::OnceLock<cluster::logs::LogStreams> = std::sync::OnceLock::new();
    STREAMS.get_or_init(cluster::logs::LogStreams::default)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(SharedSession::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            connect,
            current_cluster,
            disconnect,
            list_namespaces,
            list_pods,
            list_nodes,
            get_pod,
            list_events,
            start_pod_logs,
            stop_pod_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loupe");
}
