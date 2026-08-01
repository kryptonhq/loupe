//! Loupe — an open-source Kubernetes client.
//!
//! The Rust side owns all cluster access. The webview never sees a
//! kubeconfig, a token, or a raw API server URL it could exfiltrate; it
//! calls the commands below and receives summarised, already-shaped
//! data. That keeps the attack surface of a bundled browser engine away
//! from the user's credentials.

mod cluster;
mod error;
mod settings;
mod vibrancy;

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
async fn list_pods_on_node(
    session: tauri::State<'_, SharedSession>,
    node: String,
) -> Result<Vec<cluster::resources::PodSummary>> {
    cluster::resources::list_pods_on_node(session.inner(), &node).await
}

#[tauri::command]
async fn get_pod(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<cluster::detail::pod::PodDetail> {
    cluster::detail::pod::get_pod(session.inner(), &namespace, &name).await
}

#[tauri::command]
async fn get_node(
    session: tauri::State<'_, SharedSession>,
    name: String,
) -> Result<cluster::detail::node::NodeDetail> {
    cluster::detail::node::get_node(session.inner(), &name).await
}

#[tauri::command]
async fn get_namespace(
    session: tauri::State<'_, SharedSession>,
    name: String,
) -> Result<cluster::detail::namespace::NamespaceDetail> {
    cluster::detail::namespace::get_namespace(session.inner(), &name).await
}

#[tauri::command]
async fn list_events(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<Vec<cluster::detail::EventView>> {
    cluster::detail::list_events(session.inner(), &namespace, &name).await
}

/// Everything happening in a namespace, rather than to it.
#[tauri::command]
async fn list_namespace_events(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
) -> Result<Vec<cluster::detail::EventView>> {
    cluster::detail::list_namespace_events(session.inner(), &namespace).await
}

#[tauri::command]
async fn list_api_resources(
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<cluster::discovery::ApiResourceInfo>> {
    cluster::discovery::list_api_resources(session.inner()).await
}

/// Discards the cached API surface, so a CRD installed since connecting
/// becomes visible without reconnecting.
#[tauri::command]
async fn refresh_api_resources(
    session: tauri::State<'_, SharedSession>,
) -> Result<Vec<cluster::discovery::ApiResourceInfo>> {
    session.inner().refresh_discovery().await?;
    cluster::discovery::list_api_resources(session.inner()).await
}

#[tauri::command]
async fn list_objects(
    session: tauri::State<'_, SharedSession>,
    resource: cluster::discovery::GvkRef,
    namespace: Option<String>,
) -> Result<Vec<cluster::discovery::ObjectSummary>> {
    cluster::discovery::list_objects(session.inner(), resource, namespace).await
}

/// A listing with the columns `kubectl get` would print, for any kind.
#[tauri::command]
async fn list_table(
    session: tauri::State<'_, SharedSession>,
    resource: cluster::discovery::GvkRef,
    namespace: Option<String>,
) -> Result<cluster::table::ResourceTable> {
    cluster::table::list_table(session.inner(), resource, namespace).await
}

#[tauri::command]
async fn get_config_map_data(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<cluster::data::ResourceData> {
    cluster::data::get_config_map_data(session.inner(), &namespace, &name).await
}

/// A Secret's keys, with values withheld unless `reveal` names them.
///
/// Revealing is per key rather than all-or-nothing so checking one value
/// does not put every credential in the object on screen.
#[tauri::command]
async fn get_secret_data(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
    reveal: Vec<String>,
) -> Result<cluster::data::ResourceData> {
    cluster::data::get_secret_data(session.inner(), &namespace, &name, reveal).await
}

#[tauri::command]
async fn get_object(
    session: tauri::State<'_, SharedSession>,
    resource: cluster::discovery::GvkRef,
    namespace: Option<String>,
    name: String,
) -> Result<cluster::discovery::ObjectDetail> {
    cluster::discovery::get_object(session.inner(), resource, namespace, &name).await
}

/// Writes an edited object back, as a full replace.
///
/// The target is carried alongside the text so the apply can refuse an
/// edit that has been retargeted at a different object — see
/// `cluster::edit` for why that matters.
#[tauri::command]
async fn apply_yaml(
    session: tauri::State<'_, SharedSession>,
    target: cluster::edit::EditTarget,
    yaml: String,
) -> Result<cluster::edit::ApplyResult> {
    cluster::edit::apply_yaml(session.inner(), target, &yaml).await
}

#[tauri::command]
async fn list_helm_releases(
    session: tauri::State<'_, SharedSession>,
    namespace: Option<String>,
) -> Result<Vec<cluster::helm::ReleaseSummary>> {
    cluster::helm::list_releases(session.inner(), namespace).await
}

#[tauri::command]
async fn get_helm_release(
    session: tauri::State<'_, SharedSession>,
    namespace: String,
    name: String,
) -> Result<cluster::helm::ReleaseDetail> {
    cluster::helm::get_release(session.inner(), &namespace, &name).await
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

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> settings::Settings {
    settings::load(&app)
}

/// Records the chosen appearance and returns the settings as stored.
#[tauri::command]
fn set_theme(app: tauri::AppHandle, theme: settings::Theme) -> Result<settings::Settings> {
    let mut current = settings::load(&app);
    current.theme = theme;
    settings::save(&app, &current)?;
    Ok(current)
}

/// Whether native window vibrancy is actually active.
///
/// The frontend asks at startup rather than guessing from the platform:
/// a translucent stylesheet over an opaque window looks broken, and
/// support depends on OS build and (on Linux) the compositor.
#[tauri::command]
fn vibrancy_enabled(state: tauri::State<'_, VibrancyState>) -> bool {
    state.0
}

struct VibrancyState(bool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(SharedSession::default());
            app.manage(VibrancyState(vibrancy::setup(app)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            connect,
            current_cluster,
            disconnect,
            list_namespaces,
            list_pods,
            list_pods_on_node,
            list_nodes,
            get_pod,
            get_node,
            get_namespace,
            list_events,
            list_namespace_events,
            list_api_resources,
            refresh_api_resources,
            list_objects,
            list_table,
            get_object,
            get_config_map_data,
            get_secret_data,
            apply_yaml,
            list_helm_releases,
            get_helm_release,
            start_pod_logs,
            stop_pod_logs,
            get_settings,
            set_theme,
            vibrancy_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loupe");
}
