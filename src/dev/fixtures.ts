// Demo data for running the UI in a plain browser.
//
// Loupe normally talks to Rust over Tauri's IPC. Opening the Vite dev
// server directly in a browser has no IPC bridge, so every command
// throws and no screen past the context picker can be reached. That
// makes it impossible to iterate on layout without a cluster, and
// impossible to capture the README screenshots reproducibly.
//
// This module installs a stand-in for the IPC bridge. It is guarded
// three ways and can never affect a real session:
//
//   1. `import.meta.env.DEV` — stripped entirely from production builds
//   2. `window.__TAURI_INTERNALS__` already set — inside the desktop app
//      the real bridge exists and we leave it alone
//   3. it is only imported from main.tsx behind both checks
//
// The shapes here mirror the Rust structs in src-tauri/src/cluster/. If
// a command's response changes there, this needs the same change — the
// compiler will not catch it, because the bridge is untyped by nature.

const YAML = `apiVersion: v1
kind: Pod
metadata:
  name: coredns-58db975755-wbhbz
  namespace: kube-system
  labels:
    k8s-app: kube-dns
    pod-template-hash: 58db975755
  annotations: {}
spec:
  serviceAccountName: coredns
  containers:
    - name: coredns
      image: registry.k8s.io/coredns/coredns:v1.12.4
      ports:
        - containerPort: 53
          protocol: UDP
      resources:
        limits:
          memory: 170Mi
        requests:
          cpu: 100m
      livenessProbe:
        httpGet:
          path: /health
          port: 8080
        initialDelaySeconds: 60
        failureThreshold: 5
  startupScript: |
    echo "not: a yaml key"
    # not a comment either
status:
  phase: Running
  podIP: 192.168.194.12
  qosClass: Burstable
  ready: true
  restartCount: 0
  reason: null`;

const POD_NAMES: [string, string, string][] = [
  ["coredns-58db975755-wbhbz", "kube-system", "Running"],
  ["coredns-58db975755-k2xqv", "kube-system", "Running"],
  ["local-path-provisioner-6b9c7f8d4-nq7lz", "local-path-storage", "Running"],
  ["krypton-control-plane-7d4f9c8b5-2xmpq", "krypton-system", "Running"],
  ["krypton-gateway-5f8b7d6c9-vkt4n", "krypton-system", "Running"],
  ["krypton-manager-6c9d8f7b4-hs3wl", "krypton-system", "Running"],
  ["krypton-postgres-0", "krypton-system", "Running"],
  ["mcp-hello-6b7cddd5c7-jvwmg", "agents", "Running"],
  ["echo-agent-7f9d8c6b5-mn2kd", "agents", "Running"],
  ["qwen2-0-5b-model-5d7c8f9b6-xp4tv", "agents", "Pending"],
  ["batch-import-28471-h9wnc", "default", "Succeeded"],
  ["batch-import-28470-q3fkp", "default", "Succeeded"],
  ["legacy-adapter-6f8d9c7b5-tz8xm", "default", "Failed"],
];

const pods = POD_NAMES.map(([name, namespace, phase], i) => ({
  name,
  namespace,
  phase,
  node: "orbstack",
  ready: phase === "Running" ? (i === 7 ? "2/2" : "1/1") : "0/1",
  restarts: i === 9 ? 7 : i === 12 ? 2 : 0,
  age: ["65d", "65d", "65d", "12d", "12d", "12d", "12d", "44m", "3d", "8m", "1h", "2h", "6d"][i],
}));

const FIXTURES: Record<string, unknown> = {
  list_contexts: [
    { name: "orbstack", cluster: "orbstack", user: "orbstack", namespace: null, isCurrent: true },
    { name: "staging-eks", cluster: "staging-eks", user: "staging", namespace: "apps", isCurrent: false },
    { name: "minikube", cluster: "minikube", user: "minikube", namespace: null, isCurrent: false },
  ],
  current_cluster: {
    context: "orbstack",
    server: "https://127.0.0.1:26443",
    version: "v1.34.8+orb1",
    platform: "darwin/arm64",
  },
  connect: {
    context: "orbstack",
    server: "https://127.0.0.1:26443",
    version: "v1.34.8+orb1",
    platform: "darwin/arm64",
  },
  list_nodes: [
    {
      name: "orbstack",
      ready: true,
      roles: ["control-plane", "master", "etcd"],
      version: "v1.34.8+orb1",
      age: "65d",
    },
  ],
  list_namespaces: [
    "agents",
    "default",
    "krypton-system",
    "kube-node-lease",
    "kube-public",
    "kube-system",
    "local-path-storage",
  ].map((name) => ({ name, phase: "Active", age: "65d" })),
  list_pods: pods,
  get_pod: {
    name: "coredns-58db975755-wbhbz",
    namespace: "kube-system",
    phase: "Running",
    node: "orbstack",
    podIp: "192.168.194.12",
    serviceAccount: "coredns",
    qosClass: "Burstable",
    age: "65d",
    labels: [
      ["k8s-app", "kube-dns"],
      ["pod-template-hash", "58db975755"],
    ],
    annotations: [],
    containers: [
      {
        name: "coredns",
        image: "registry.k8s.io/coredns/coredns:v1.12.4",
        ready: true,
        restarts: 0,
        state: "Running",
        lastState: null,
      },
    ],
    initContainers: [],
    conditions: [
      { type: "PodReadyToStartContainers", status: "True", reason: null, message: null },
      { type: "Initialized", status: "True", reason: null, message: null },
      { type: "Ready", status: "True", reason: null, message: null },
      { type: "ContainersReady", status: "True", reason: null, message: null },
      { type: "PodScheduled", status: "True", reason: null, message: null },
    ],
    yaml: YAML,
  },
  list_events: [
    {
      type: "Normal",
      reason: "Scheduled",
      message: "Successfully assigned kube-system/coredns-58db975755-wbhbz to orbstack",
      count: 1,
      age: "65d",
      source: "default-scheduler",
    },
    {
      type: "Normal",
      reason: "Pulled",
      message: 'Container image "registry.k8s.io/coredns/coredns:v1.12.4" already present on machine',
      count: 1,
      age: "65d",
      source: "kubelet",
    },
    {
      type: "Normal",
      reason: "Created",
      message: "Created container: coredns",
      count: 1,
      age: "65d",
      source: "kubelet",
    },
    {
      type: "Warning",
      reason: "Unhealthy",
      message: "Readiness probe failed: HTTP probe failed with statuscode: 503",
      count: 3,
      age: "64d",
      source: "kubelet",
    },
  ],
  disconnect: null,
  stop_pod_logs: true,
  start_pod_logs: 1,
};

export function installDemoBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_INTERNALS__ = {
    invoke: (cmd: string) =>
      Promise.resolve(cmd in FIXTURES ? FIXTURES[cmd] : []),
    transformCallback: (cb: unknown) => cb,
  };
  // Loud on purpose: nothing on screen is real, and it should be
  // impossible to mistake this for a live cluster.
  console.warn(
    "[loupe] No Tauri bridge — running with demo fixtures. " +
      "This is dev-only and never reaches a production build.",
  );
}
