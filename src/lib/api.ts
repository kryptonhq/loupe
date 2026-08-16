// Typed wrappers over the Tauri commands in src-tauri/src/lib.rs.
//
// These interfaces mirror the Rust structs exactly; the Rust side
// serialises camelCase so the two stay aligned without a translation
// layer. When a command signature changes there, it changes here.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Theme } from "./theme";

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  isCurrent: boolean;
}

export interface ClusterInfo {
  context: string;
  server: string;
  version: string;
  platform: string;
}

export interface NamespaceSummary {
  name: string;
  phase: string;
  age: string | null;
}

export interface PodSummary {
  name: string;
  namespace: string;
  phase: string;
  node: string | null;
  ready: string;
  restarts: number;
  age: string | null;
}

export interface NodeSummary {
  name: string;
  ready: boolean;
  roles: string[];
  version: string;
  age: string | null;
}

/// The shape AppError serialises to. `kind` is stable; `message` is for
/// humans and should not be pattern-matched.
export interface ApiError {
  kind:
    | "kubeconfig"
    | "unknown_context"
    | "not_connected"
    | "unknown_resource"
    | "invalid_edit"
    | "conflict"
    | "settings"
    | "export"
    | "kubernetes";
  message: string;
}

/// True when an edit was rejected because the object moved on under it.
/// The only useful response is to reload, which the editor offers.
export function isConflict(e: unknown): boolean {
  return isApiError(e) && e.kind === "conflict";
}

/// What a context allows, as recorded in Loupe's own settings.
///
/// Emphatically not RBAC: `readOnly` means the request was never sent,
/// and the fix is in the user's preferences rather than in their
/// permissions.
export type Guard = "open" | "protected" | "readOnly";

export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e
  );
}

/// Normalises anything thrown across the IPC boundary into a message.
/// Tauri rejects with the serialised error object, but a panic on the
/// Rust side arrives as a bare string.
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "unexpected error";
}

export interface ContainerView {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  state: string;
  lastState: string | null;
}

export interface ConditionView {
  // serde emits "type", not "type_" — the trailing underscore is a Rust
  // keyword escape and does not survive camelCase renaming.
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
}

/// Identity fields every detail payload carries, so the YAML editor
/// knows what it is saving without each page hardcoding its own kind.
export interface Editable {
  apiVersion: string;
  kind: string;
}

export interface PodDetail extends Editable {
  name: string;
  namespace: string;
  phase: string;
  node: string | null;
  podIp: string | null;
  serviceAccount: string | null;
  qosClass: string | null;
  age: string | null;
  labels: [string, string][];
  annotations: [string, string][];
  containers: ContainerView[];
  initContainers: ContainerView[];
  conditions: ConditionView[];
  yaml: string;
}

export interface ResourceUsage {
  name: string;
  requests: string;
  requestsPercent: number | null;
  limits: string;
  limitsPercent: number | null;
  allocatable: string;
}

export interface NodeDetail extends Editable {
  name: string;
  ready: boolean;
  schedulable: boolean;
  roles: string[];
  version: string;
  age: string | null;
  addresses: [string, string][];
  osImage: string | null;
  kernelVersion: string | null;
  containerRuntime: string | null;
  architecture: string | null;
  operatingSystem: string | null;
  capacity: [string, string][];
  allocatable: [string, string][];
  allocated: ResourceUsage[];
  taints: string[];
  conditions: ConditionView[];
  labels: [string, string][];
  annotations: [string, string][];
  podCount: number;
  yaml: string;
}

export interface QuotaEntry {
  resource: string;
  used: string;
  hard: string;
}

export interface QuotaView {
  name: string;
  entries: QuotaEntry[];
}

export interface PodTally {
  phase: string;
  count: number;
}

export interface NamespaceDetail extends Editable {
  name: string;
  phase: string;
  age: string | null;
  labels: [string, string][];
  annotations: [string, string][];
  finalizers: string[];
  podCount: number;
  podsByPhase: PodTally[];
  quotas: QuotaView[];
  yaml: string;
}

/// A resource type the cluster serves, as reported by discovery.
export interface ApiResourceInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  apiVersion: string;
  namespaced: boolean;
  verbs: string[];
  custom: boolean;
}

/// Names a resource type for the generic list/get commands.
export interface GvkRef {
  group: string;
  version: string;
  kind: string;
}

/// A listing rendered by the API server itself — the same columns and
/// cells `kubectl get` prints, for whatever kind was asked for.
export interface TableColumn {
  name: string;
  /// 0 for columns kubectl shows by default; higher for the ones it
  /// holds back for `-o wide`.
  priority: number;
  description: string | null;
}

export interface TableRow {
  name: string;
  namespace: string | null;
  cells: string[];
}

export interface ResourceTable {
  columns: TableColumn[];
  rows: TableRow[];
  namespaced: boolean;
  /// The API server's opaque cursor, when more objects remain. Handed
  /// straight back on the next request; never parsed or built.
  continueToken: string | null;
  /// How many objects the server says are still to come. Advisory — the
  /// server need not send it — but when present it is what lets the UI
  /// say "500 of 20,000" instead of implying it has everything.
  remaining: number | null;
}

/// One key of a ConfigMap or Secret.
export interface DataKey {
  key: string;
  bytes: number;
  /// Null when the value is withheld (an unrevealed Secret key) or not
  /// renderable (binary).
  value: string | null;
  binary: boolean;
}

export interface ResourceData {
  keys: DataKey[];
  /// A Secret's type. Null for a ConfigMap.
  type: string | null;
  /// True when values are held back until asked for by name.
  redacted: boolean;
}

export interface ObjectSummary {
  name: string;
  namespace: string | null;
  age: string | null;
  status: string | null;
}

export interface ObjectDetail extends Editable {
  name: string;
  namespace: string | null;
  age: string | null;
  status: string | null;
  labels: [string, string][];
  annotations: [string, string][];
  conditions: ConditionView[];
  editable: boolean;
  yaml: string;
}

/// Why two objects are related. Doubles as the section heading.
export type Relation =
  | "ownedBy"
  | "owns"
  | "selects"
  | "selectedBy"
  | "uses"
  | "routes";

export interface RelatedObject {
  relation: Relation;
  group: string;
  version: string;
  kind: string;
  name: string;
  namespace: string | null;
  /// False when the object is referenced but could not be read. Shown
  /// rather than dropped — a dangling owner reference is usually the
  /// explanation for whatever you are looking at.
  reachable: boolean;
  /// Extra wording for the row, such as which volume mounts it.
  detail: string | null;
}

/// Persisted user preferences. Stored as JSON in the app's config
/// directory by the Rust side, not in the webview — a preference should
/// survive a cache clear and be a file the user can read or delete.
export interface Settings {
  theme: Theme;
  /// Contexts connected to, most recent first. Recorded by the backend
  /// on a successful connect.
  recentContexts: string[];
  /// Contexts the user pinned, in their own order.
  pinnedContexts: string[];
}

/// Identifies the object an editor is open on. Sent back with the edit
/// so the backend can refuse one that has been retargeted.
export interface EditTarget {
  apiVersion: string;
  kind: string;
  namespace: string | null;
  name: string;
}

export interface ApplyResult {
  yaml: string;
  resourceVersion: string | null;
}

export interface ReleaseSummary {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  appVersion: string | null;
  updated: string | null;
  description: string | null;
}

export interface ReleaseRevision {
  revision: number;
  status: string;
  chart: string;
  appVersion: string | null;
  updated: string | null;
  description: string | null;
}

export interface ReleaseDetail {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chartName: string;
  chartVersion: string | null;
  appVersion: string | null;
  updated: string | null;
  firstDeployed: string | null;
  description: string | null;
  chartDescription: string | null;
  home: string | null;
  notes: string | null;
  values: string;
  manifest: string;
  history: ReleaseRevision[];
}

export interface EventView {
  type: string;
  reason: string | null;
  message: string | null;
  count: number | null;
  age: string | null;
  source: string | null;
  object: string | null;
}

export interface LogOptions {
  namespace: string;
  pod: string;
  container?: string | null;
  follow: boolean;
  tailLines?: number | null;
  timestamps: boolean;
  previous: boolean;
}

/// Messages pushed over the log channel. `ended` and `failed` are
/// distinct because a stream that stops silently is indistinguishable
/// from a pod that simply has nothing to say.
///
/// Lines arrive in batches rather than one per message. A pod emitting
/// thousands of lines a second would otherwise be thousands of IPC
/// round-trips a second, which costs more than rendering them.
export type LogEvent =
  | { kind: "lines"; texts: string[] }
  | { kind: "ended" }
  | { kind: "failed"; message: string };

export const api = {
  listContexts: () => invoke<ContextInfo[]>("list_contexts"),
  connect: (context: string) => invoke<ClusterInfo>("connect", { context }),
  currentCluster: () => invoke<ClusterInfo | null>("current_cluster"),
  disconnect: () => invoke<void>("disconnect"),
  listNamespaces: () => invoke<NamespaceSummary[]>("list_namespaces"),
  listPods: (namespace?: string) =>
    invoke<PodSummary[]>("list_pods", { namespace: namespace ?? null }),
  listPodsOnNode: (node: string) =>
    invoke<PodSummary[]>("list_pods_on_node", { node }),
  listNodes: () => invoke<NodeSummary[]>("list_nodes"),

  getPod: (namespace: string, name: string) =>
    invoke<PodDetail>("get_pod", { namespace, name }),
  getNode: (name: string) => invoke<NodeDetail>("get_node", { name }),
  getNamespace: (name: string) =>
    invoke<NamespaceDetail>("get_namespace", { name }),

  listEvents: (namespace: string, name: string) =>
    invoke<EventView[]>("list_events", { namespace, name }),
  /// Everything happening in a namespace, rather than to it — a
  /// namespace object almost never has events of its own.
  listNamespaceEvents: (namespace: string) =>
    invoke<EventView[]>("list_namespace_events", { namespace }),

  /// Every kind the cluster serves, from API discovery. Cached in the
  /// Rust session; `refreshApiResources` is what picks up a CRD
  /// installed since connecting.
  listApiResources: () => invoke<ApiResourceInfo[]>("list_api_resources"),
  refreshApiResources: () =>
    invoke<ApiResourceInfo[]>("refresh_api_resources"),
  listObjects: (resource: GvkRef, namespace?: string) =>
    invoke<ObjectSummary[]>("list_objects", {
      resource,
      namespace: namespace ?? null,
    }),
  getObject: (resource: GvkRef, namespace: string | null, name: string) =>
    invoke<ObjectDetail>("get_object", { resource, namespace, name }),

  /// Everything connected to an object: what owns it, what it owns,
  /// what selects it, and what it names in its own spec.
  listRelated: (resource: GvkRef, namespace: string | null, name: string) =>
    invoke<RelatedObject[]>("list_related", { resource, namespace, name }),

  /// One page of a listing with kubectl's own columns. Works for every
  /// kind, including CRDs, because the API server does the printing.
  ///
  /// `continueToken` comes from the previous page and is opaque — it is
  /// passed back exactly as received.
  listTable: (
    resource: GvkRef,
    namespace?: string,
    limit?: number,
    continueToken?: string | null,
  ) =>
    invoke<ResourceTable>("list_table", {
      resource,
      namespace: namespace ?? null,
      limit: limit ?? null,
      continueToken: continueToken ?? null,
    }),

  getConfigMapData: (namespace: string, name: string) =>
    invoke<ResourceData>("get_config_map_data", { namespace, name }),

  /// A Secret's keys. Values come back only for the keys named in
  /// `reveal`, so checking one does not put the rest on screen.
  getSecretData: (namespace: string, name: string, reveal: string[] = []) =>
    invoke<ResourceData>("get_secret_data", { namespace, name, reveal }),

  /// Writes an edited object back as a full replace. Rejects an edit
  /// whose identity no longer matches `target`, and one based on a
  /// resourceVersion the cluster has moved past.
  applyYaml: (target: EditTarget, yaml: string) =>
    invoke<ApplyResult>("apply_yaml", { target, yaml }),

  listHelmReleases: (namespace?: string) =>
    invoke<ReleaseSummary[]>("list_helm_releases", {
      namespace: namespace ?? null,
    }),
  getHelmRelease: (namespace: string, name: string) =>
    invoke<ReleaseDetail>("get_helm_release", { namespace, name }),

  /// Starts streaming and resolves with the stream id used to stop it.
  /// Rejects if the stream cannot be opened at all — a missing container
  /// or an RBAC denial surfaces here rather than as silence.
  startPodLogs: (options: LogOptions, channel: Channel<LogEvent>) =>
    invoke<number>("start_pod_logs", { options, channel }),
  stopPodLogs: (id: number) => invoke<boolean>("stop_pod_logs", { id }),

  /// Writes text to a file the user picks. Resolves with the path
  /// written, or null if they cancelled — an ordinary outcome, not an
  /// error. The path is chosen in the native dialog; the webview never
  /// names one.
  saveText: (suggestedName: string, contents: string) =>
    invoke<string | null>("save_text", { suggestedName, contents }),

  getSettings: () => invoke<Settings>("get_settings"),
  setTheme: (theme: Theme) => invoke<Settings>("set_theme", { theme }),
  /// Pins or unpins a context in the picker, returning the settings as
  /// stored.
  setContextPinned: (context: string, pinned: boolean) =>
    invoke<Settings>("set_context_pinned", { context, pinned }),
  /// The safeguard in force for a context, so the UI can mark it and
  /// confirm before a write rather than only reporting the refusal.
  contextGuard: (context: string) => invoke<Guard>("context_guard", { context }),
  setContextGuard: (context: string, guard: Guard) =>
    invoke<Settings>("set_context_guard", { context, guard }),

  /// Whether native window vibrancy actually took effect. Asked rather
  /// than inferred from the platform: support depends on OS build and,
  /// on Linux, the compositor — and a translucent stylesheet over an
  /// opaque window looks broken in a very specific way.
  vibrancyEnabled: () => invoke<boolean>("vibrancy_enabled"),
};

export { Channel };
