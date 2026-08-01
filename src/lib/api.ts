// Typed wrappers over the Tauri commands in src-tauri/src/lib.rs.
//
// These interfaces mirror the Rust structs exactly; the Rust side
// serialises camelCase so the two stay aligned without a translation
// layer. When a command signature changes there, it changes here.
import { Channel, invoke } from "@tauri-apps/api/core";

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
    | "kubernetes";
  message: string;
}

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

export interface PodDetail {
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

export interface EventView {
  type: string;
  reason: string | null;
  message: string | null;
  count: number | null;
  age: string | null;
  source: string | null;
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
export type LogEvent =
  | { kind: "line"; text: string }
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
  listNodes: () => invoke<NodeSummary[]>("list_nodes"),

  getPod: (namespace: string, name: string) =>
    invoke<PodDetail>("get_pod", { namespace, name }),
  listEvents: (namespace: string, name: string) =>
    invoke<EventView[]>("list_events", { namespace, name }),

  /// Starts streaming and resolves with the stream id used to stop it.
  /// Rejects if the stream cannot be opened at all — a missing container
  /// or an RBAC denial surfaces here rather than as silence.
  startPodLogs: (options: LogOptions, channel: Channel<LogEvent>) =>
    invoke<number>("start_pod_logs", { options, channel }),
  stopPodLogs: (id: number) => invoke<boolean>("stop_pod_logs", { id }),
};

export { Channel };
