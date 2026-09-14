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

const NODE_YAML = `apiVersion: v1
kind: Node
metadata:
  name: orbstack
  labels:
    kubernetes.io/arch: arm64
    node-role.kubernetes.io/control-plane: "true"
  resourceVersion: "184203"
spec:
  podCIDR: 192.168.194.0/24
status:
  allocatable:
    cpu: "12"
    memory: 8146356Ki
    pods: "110"
  nodeInfo:
    architecture: arm64
    kubeletVersion: v1.34.8+orb1
    osImage: OrbStack 1.13.1`;

const NAMESPACE_YAML = `apiVersion: v1
kind: Namespace
metadata:
  name: krypton-system
  labels:
    kubernetes.io/metadata.name: krypton-system
  resourceVersion: "9021"
spec:
  finalizers:
    - kubernetes
status:
  phase: Active`;

const AGENT_YAML = `apiVersion: krypton.ai/v1alpha1
kind: Agent
metadata:
  name: mcp-hello
  namespace: agents
  resourceVersion: "77412"
spec:
  mode: always-on
  replicas: 1
  model: qwen2-0-5b
status:
  phase: Ready
  replicas: 1
  conditions:
    - type: Ready
      status: "True"
      reason: RolloutComplete`;

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
  list_pods_on_node: pods,
  get_pod: {
    apiVersion: "v1",
    kind: "Pod",
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
      object: "Pod/coredns-58db975755-wbhbz",
    },
    {
      type: "Normal",
      reason: "Pulled",
      message: 'Container image "registry.k8s.io/coredns/coredns:v1.12.4" already present on machine',
      count: 1,
      age: "65d",
      source: "kubelet",
      object: "Pod/coredns-58db975755-wbhbz",
    },
    {
      type: "Normal",
      reason: "Created",
      message: "Created container: coredns",
      count: 1,
      age: "65d",
      source: "kubelet",
      object: "Pod/coredns-58db975755-wbhbz",
    },
    {
      type: "Warning",
      reason: "Unhealthy",
      message: "Readiness probe failed: HTTP probe failed with statuscode: 503",
      count: 3,
      age: "64d",
      source: "kubelet",
      object: "Pod/coredns-58db975755-wbhbz",
    },
  ],
  get_node: {
    apiVersion: "v1",
    kind: "Node",
    name: "orbstack",
    ready: true,
    schedulable: true,
    roles: ["control-plane", "master", "etcd"],
    version: "v1.34.8+orb1",
    age: "65d",
    addresses: [
      ["InternalIP", "198.19.249.2"],
      ["Hostname", "orbstack"],
    ],
    osImage: "OrbStack 1.13.1",
    kernelVersion: "6.19.2-orbstack",
    containerRuntime: "containerd://2.1.6",
    architecture: "arm64",
    operatingSystem: "linux",
    capacity: [
      ["cpu", "12"],
      ["ephemeral-storage", "460479488Ki"],
      ["memory", "8146356Ki"],
      ["pods", "110"],
    ],
    allocatable: [
      ["cpu", "12"],
      ["ephemeral-storage", "460479488Ki"],
      ["memory", "8146356Ki"],
      ["pods", "110"],
    ],
    allocated: [
      {
        name: "CPU",
        requests: "850m",
        requestsPercent: 7,
        limits: "2",
        limitsPercent: 17,
        allocatable: "12",
      },
      {
        name: "Memory",
        requests: "1.2Gi",
        requestsPercent: 16,
        limits: "2.5Gi",
        limitsPercent: 33,
        allocatable: "7.8Gi",
      },
    ],
    taints: [],
    conditions: [
      { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", message: null },
      { type: "DiskPressure", status: "False", reason: "KubeletHasNoDiskPressure", message: null },
      { type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status" },
    ],
    labels: [
      ["kubernetes.io/arch", "arm64"],
      ["kubernetes.io/hostname", "orbstack"],
      ["node-role.kubernetes.io/control-plane", "true"],
    ],
    annotations: [],
    podCount: pods.length,
    yaml: NODE_YAML,
  },
  get_namespace: {
    apiVersion: "v1",
    kind: "Namespace",
    name: "krypton-system",
    phase: "Active",
    age: "12d",
    labels: [["kubernetes.io/metadata.name", "krypton-system"]],
    annotations: [],
    finalizers: [],
    podCount: 4,
    podsByPhase: [{ phase: "Running", count: 4 }],
    quotas: [
      {
        name: "compute",
        entries: [
          { resource: "limits.cpu", used: "1200m", hard: "4" },
          { resource: "limits.memory", used: "2Gi", hard: "8Gi" },
          { resource: "pods", used: "4", hard: "20" },
        ],
      },
    ],
    yaml: NAMESPACE_YAML,
  },
  list_namespace_events: [
    {
      type: "Warning",
      reason: "FailedScheduling",
      message: "0/1 nodes are available: 1 Insufficient memory.",
      count: 12,
      age: "8m",
      source: "default-scheduler",
      object: "Pod/qwen2-0-5b-model-5d7c8f9b6-xp4tv",
    },
    {
      type: "Normal",
      reason: "ScalingReplicaSet",
      message: "Scaled up replica set krypton-gateway-5f8b7d6c9 to 1",
      count: 1,
      age: "12d",
      source: "deployment-controller",
      object: "Deployment/krypton-gateway",
    },
  ],
  list_api_resources: [
    { group: "krypton.ai", version: "v1alpha1", kind: "Agent", plural: "agents", apiVersion: "krypton.ai/v1alpha1", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
    { group: "krypton.ai", version: "v1alpha1", kind: "Model", plural: "models", apiVersion: "krypton.ai/v1alpha1", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: true },
    { group: "monitoring.coreos.com", version: "v1", kind: "ServiceMonitor", plural: "servicemonitors", apiVersion: "monitoring.coreos.com/v1", namespaced: true, verbs: ["get", "list", "watch", "create", "update"], custom: true },
    { group: "monitoring.coreos.com", version: "v1", kind: "Prometheus", plural: "prometheuses", apiVersion: "monitoring.coreos.com/v1", namespaced: true, verbs: ["get", "list", "watch"], custom: true },
    { group: "", version: "v1", kind: "Pod", plural: "pods", apiVersion: "v1", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: false },
    { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", apiVersion: "apps/v1", namespaced: true, verbs: ["get", "list", "watch", "create", "update", "patch", "delete"], custom: false },
    { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRole", plural: "clusterroles", apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false, verbs: ["get", "list", "watch"], custom: false },
  ],
  list_objects: [
    { name: "mcp-hello", namespace: "agents", age: "65d", status: "Ready" },
    { name: "echo-agent", namespace: "agents", age: "3d", status: "Ready" },
    { name: "summarizer", namespace: "agents", age: "8m", status: "NotReady: ModelPullFailed" },
  ],
  get_object: {
    apiVersion: "krypton.ai/v1alpha1",
    kind: "Agent",
    name: "mcp-hello",
    namespace: "agents",
    age: "65d",
    status: "Ready",
    labels: [["app.kubernetes.io/managed-by", "krypton"]],
    annotations: [
      // The reason annotations get their own renderer: `kubectl apply`
      // writes the whole object back into this one.
      [
        "kubectl.kubernetes.io/last-applied-configuration",
        '{"apiVersion":"krypton.ai/v1alpha1","kind":"Agent","metadata":{"annotations":{},"name":"mcp-hello","namespace":"agents"},"spec":{"mode":"always-on","replicas":1,"model":"qwen2-0-5b","resources":{"limits":{"cpu":"1","memory":"1Gi"},"requests":{"cpu":"100m","memory":"256Mi"}},"tools":["search","fetch"]}}\n',
      ],
      ["krypton.ai/revision", "7"],
    ],
    conditions: [
      { type: "Ready", status: "True", reason: "RolloutComplete", message: "1/1 replicas available" },
      { type: "ModelResolved", status: "True", reason: null, message: null },
    ],
    editable: true,
    yaml: AGENT_YAML,
  },
  list_helm_releases: [
    {
      name: "krypton",
      namespace: "krypton-system",
      revision: 3,
      status: "deployed",
      chart: "krypton-0.0.4",
      appVersion: "0.0.4",
      updated: "12d",
      description: "Upgrade complete",
    },
    {
      name: "prom",
      namespace: "monitoring",
      revision: 1,
      status: "deployed",
      chart: "kube-prometheus-stack-85.3.3",
      appVersion: "v0.87.0",
      updated: "66d",
      description: "Install complete",
    },
  ],
  get_helm_release: {
    name: "krypton",
    namespace: "krypton-system",
    revision: 3,
    status: "deployed",
    chart: "krypton-0.0.4",
    chartName: "krypton",
    chartVersion: "0.0.4",
    appVersion: "0.0.4",
    updated: "12d",
    firstDeployed: "44d",
    description: "Upgrade complete",
    chartDescription: "The Krypton control plane",
    home: "https://github.com/kryptonhq/krypton",
    notes:
      "Krypton is installed.\n\n  kubectl --namespace krypton-system get pods\n\nReach the gateway:\n\n  kubectl --namespace krypton-system port-forward svc/krypton-gateway 8080:80\n",
    values: "gateway:\n  replicas: 1\npostgres:\n  persistence:\n    size: 8Gi\n",
    manifest:
      "---\napiVersion: v1\nkind: Service\nmetadata:\n  name: krypton-gateway\n  namespace: krypton-system\nspec:\n  ports:\n    - port: 80\n      targetPort: 8080\n",
    history: [
      { revision: 3, status: "deployed", chart: "krypton-0.0.4", appVersion: "0.0.4", updated: "12d", description: "Upgrade complete" },
      { revision: 2, status: "superseded", chart: "krypton-0.0.3", appVersion: "0.0.3", updated: "30d", description: "Upgrade complete" },
      { revision: 1, status: "superseded", chart: "krypton-0.0.2", appVersion: "0.0.2", updated: "44d", description: "Install complete" },
    ],
  },
  // Server-side printing: the demo returns a Service-shaped table, which
  // is enough to exercise the browser. A real cluster sends whatever
  // columns the kind actually has.
  list_table: {
    namespaced: true,
    // The demo fixture is one page and the last one.
    continueToken: null,
    remaining: null,
    columns: [
      { name: "Name", priority: 0, description: null },
      { name: "Type", priority: 0, description: null },
      { name: "Cluster-IP", priority: 0, description: null },
      { name: "Port(s)", priority: 0, description: null },
      { name: "Age", priority: 0, description: null },
      { name: "Selector", priority: 1, description: "label selector" },
    ],
    rows: [
      {
        name: "krypton-gateway",
        namespace: "krypton-system",
        cells: ["krypton-gateway", "ClusterIP", "192.168.194.87", "80/TCP", "12d", "app=gateway"],
      },
      {
        name: "krypton-postgres",
        namespace: "krypton-system",
        cells: ["krypton-postgres", "ClusterIP", "None", "5432/TCP", "12d", "app=postgres"],
      },
      {
        name: "kube-dns",
        namespace: "kube-system",
        cells: ["kube-dns", "ClusterIP", "192.168.194.138", "53/UDP,53/TCP", "65d", "k8s-app=kube-dns"],
      },
    ],
  },
  get_config_map_data: {
    type: null,
    redacted: false,
    keys: [
      { key: "Corefile", bytes: 412, binary: false, value: ".:53 {\n    errors\n    health\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa\n    forward . /etc/resolv.conf\n    cache 30\n}\n" },
      { key: "NodeHosts", bytes: 34, binary: false, value: "198.19.249.2 orbstack\n" },
    ],
  },
  // Browser dev has no config directory; following the system is the
  // same fallback the app uses when the file is missing.
  get_settings: { theme: "system" },
  set_theme: { theme: "system" },
  disconnect: null,
  // A browser has no native window to make translucent. Without this
  // the fallback `[]` would apply, and an empty array is truthy.
  vibrancy_enabled: false,
  stop_pod_logs: true,
  start_pod_logs: 1,
};

/// What the demo search index holds: a handful of objects across built-in
/// and custom kinds, with the statuses `kubectl get` would print.
const DEMO_OBJECTS = [
  ["", "v1", "Pod", "shop", "checkout-7f9c-x2k", "CrashLoopBackOff"],
  ["", "v1", "Pod", "shop", "checkout-7f9c-m4p", "Running"],
  ["", "v1", "Pod", "shop", "web-5d8b-q7p", "ImagePullBackOff"],
  ["", "v1", "Pod", "kube-system", "coredns-58db975755-wbhbz", "Running"],
  ["apps", "v1", "Deployment", "shop", "checkout", "1/2"],
  ["apps", "v1", "Deployment", "shop", "web", "0/2"],
  ["", "v1", "Service", "shop", "checkout", null],
  ["", "v1", "Service", "kube-system", "kube-dns", null],
  ["", "v1", "ConfigMap", "shop", "checkout-settings", null],
  ["", "v1", "Secret", "shop", "checkout-db-credentials", null],
  ["networking.k8s.io", "v1", "Ingress", "shop", "checkout", null],
  ["cert-manager.io", "v1", "Certificate", "shop", "checkout-tls", "True"],
  ["krypton.ai", "v1alpha1", "Agent", "agents", "mcp-hello", "Ready"],
  ["", "v1", "Node", null, "orbstack", "Ready"],
].map(([group, version, kind, namespace, name, status]) => ({
  group: group as string,
  version: version as string,
  kind: kind as string,
  namespace,
  name: name as string,
  status,
}));

/// A Problems snapshot with one of everything the monitor can say,
/// including a source RBAC refused — so the view can be laid out and
/// screenshotted without breaking a cluster on purpose.
export function demoProblems(now = Math.floor(Date.now() / 1000)) {
  const pod = (name: string, namespace = "shop") => ({
    group: "",
    version: "v1",
    kind: "Pod",
    namespace,
    name,
  });
  const source = (s: string, category: string, state = "ready") => ({
    source: s,
    category,
    state,
  });
  return {
    generatedAt: now,
    graceSeconds: 120,
    restartThreshold: 5,
    sources: [
      source("pods", "pods"),
      source("deployments", "workloads"),
      source("statefulSets", "workloads"),
      source("daemonSets", "workloads"),
      source("jobs", "workloads"),
      source("cronJobs", "workloads"),
      {
        ...source("nodes", "nodes", "forbidden"),
        message: 'nodes is forbidden: User "dev" cannot list resource "nodes"',
      },
      source("events", "events"),
      source("persistentVolumeClaims", "storage"),
    ],
    problems: [
      {
        id: "Pod/shop/checkout-7f9c-x2k/CrashLoopBackOff/app",
        severity: "critical",
        category: "pods",
        target: pod("checkout-7f9c-x2k"),
        reason: "CrashLoopBackOff",
        message: "Container `app` is crash-looping: last exit code 1 (Error), 14 restarts",
        since: now - 2_460,
        count: null,
      },
      {
        id: "Pod/shop/web-5d8b-q7p/ImagePullBackOff/web",
        severity: "critical",
        category: "pods",
        target: pod("web-5d8b-q7p"),
        reason: "ImagePullBackOff",
        message:
          "Cannot pull image `registry.example.com/shop/web:v2.4.0-rc` for container `web`: Back-off pulling image",
        since: now - 540,
        count: null,
      },
      {
        id: "Deployment/shop/web/ReplicasUnavailable/",
        severity: "critical",
        category: "workloads",
        target: { group: "apps", version: "v1", kind: "Deployment", namespace: "shop", name: "web" },
        reason: "ReplicasUnavailable",
        message: "0 of 2 replicas available for 9m",
        since: now - 540,
        count: null,
      },
      {
        id: "Pod/ml/trainer-0/Unschedulable/",
        severity: "warning",
        category: "pods",
        target: pod("trainer-0", "ml"),
        reason: "Unschedulable",
        message:
          "Cannot be scheduled: 0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.",
        since: now - 1_320,
        count: null,
      },
      {
        id: "CronJob/ops/nightly-backup/LastRunFailed/",
        severity: "warning",
        category: "workloads",
        target: { group: "batch", version: "v1", kind: "CronJob", namespace: "ops", name: "nightly-backup" },
        reason: "LastRunFailed",
        message: "Last run `nightly-backup-29311140` failed (BackoffLimitExceeded)",
        since: now - 18_000,
        count: null,
      },
      {
        id: "Pod/agents/mcp-hello-0/OOMKilled/model",
        severity: "warning",
        category: "pods",
        target: pod("mcp-hello-0", "agents"),
        reason: "OOMKilled",
        message: "Container `model` was killed for exceeding its memory limit (3 restarts)",
        since: now - 780,
        count: null,
      },
      {
        id: "PersistentVolumeClaim/shop/data-db-2/ClaimPending/",
        severity: "warning",
        category: "storage",
        target: { group: "", version: "v1", kind: "PersistentVolumeClaim", namespace: "shop", name: "data-db-2" },
        reason: "ClaimPending",
        message: "Claim has not been bound for 42m (storage class `fast-ssd`)",
        since: now - 2_520,
        count: null,
      },
      {
        id: "Pod/ml/trainer-0/Event:FailedScheduling/",
        severity: "info",
        category: "events",
        target: pod("trainer-0", "ml"),
        reason: "FailedScheduling",
        message: "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.",
        since: now - 45,
        count: 40,
      },
      {
        id: "source/nodes/NotPermitted",
        severity: "info",
        category: "nodes",
        target: null,
        reason: "NotPermitted",
        message: "Not permitted to list nodes across the cluster, so they were not checked",
        since: null,
        count: null,
      },
    ],
  };
}

export function installDemoBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_INTERNALS__ = {
    // `getCurrentWindow()` reads its label from here. Without it the
    // title-bar drag handlers throw on every mousedown instead of
    // quietly doing nothing, which is what a browser should do.
    metadata: { currentWindow: { label: "main" } },
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      // Discovery is cached in Rust; the refresh command returns the
      // same shape, so the demo shares one fixture.
      if (cmd === "refresh_api_resources") {
        return Promise.resolve(FIXTURES.list_api_resources);
      }
      // The demo has no cluster to write to, so an apply echoes the
      // edit back. That still exercises the editor's success path —
      // apply, leave edit mode, re-render with what was stored.
      // The detail view is kind-aware, so the demo has to be too: a
      // Secret opened from the browser must come back as a Secret, or
      // the Data tab never appears and the redaction is untestable.
      if (cmd === "get_object") {
        const kind = (args.resource as { kind?: string })?.kind ?? "Agent";
        const name = String(args.name ?? "");
        const namespace = (args.namespace as string | null) ?? null;
        if (kind === "Secret" || kind === "ConfigMap") {
          return Promise.resolve({
            apiVersion: "v1",
            kind,
            name,
            namespace,
            age: "12d",
            status: null,
            labels: [],
            annotations: [],
            conditions: [],
            // A Secret's YAML is redacted, and redacted YAML must not be
            // appliable — saving it would overwrite every value.
            editable: kind !== "Secret",
            yaml:
              kind === "Secret"
                ? `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\n  resourceVersion: "8812"\ntype: Opaque\ndata:\n  postgres-password: «redacted by Loupe — reveal in the Data tab»\n  tls.crt: «redacted by Loupe — reveal in the Data tab»\n`
                : `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\n  resourceVersion: "4410"\ndata:\n  Corefile: |\n    .:53 {\n        forward . /etc/resolv.conf\n    }\n`,
          });
        }
        return Promise.resolve(FIXTURES.get_object);
      }

      // Secrets are described but not disclosed: values arrive only for
      // the keys named in `reveal`, mirroring the Rust side.
      if (cmd === "get_secret_data") {
        const reveal = (args.reveal as string[]) ?? [];
        const values: Record<string, string> = {
          "postgres-password": "hunter2",
          "tls.crt": "-----BEGIN CERTIFICATE-----\nMIIB…\n-----END CERTIFICATE-----\n",
        };
        return Promise.resolve({
          type: "Opaque",
          redacted: true,
          keys: Object.entries(values).map(([key, value]) => ({
            key,
            bytes: value.length,
            binary: false,
            value: reveal.includes(key) ? value : null,
          })),
        });
      }
      // The monitor pushes snapshots on a channel rather than returning
      // one. With `transformCallback` above returning the callback
      // itself, the channel's id *is* its receiver.
      if (cmd === "start_problems") {
        const channel = args.channel as { id?: unknown } | undefined;
        const deliver = channel?.id;
        if (typeof deliver === "function") {
          setTimeout(() => deliver({ index: 0, message: demoProblems() }), 300);
        }
        return Promise.resolve(1);
      }
      if (cmd === "stop_problems") return Promise.resolve(true);
      // Cluster-wide search over a small demo index. The real one lives in
      // Rust (cluster::search); this ranks the same way — prefix, then
      // substring, then namespace or kind — so the palette can be laid out.
      if (cmd === "search_objects") {
        const q = String(args.query ?? "").trim().toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean);
        const scored = DEMO_OBJECTS.flatMap((o) => {
          let total = 0;
          for (const t of terms) {
            const at = o.name.indexOf(t);
            const s = at === 0 ? 3 : at > 0 ? 2 : (o.namespace ?? "").includes(t) || o.kind.toLowerCase().includes(t) ? 1 : 0;
            if (s === 0) return [];
            total += s;
          }
          return q.length >= 2 ? [{ o, total }] : [];
        });
        scored.sort((a, b) => b.total - a.total || a.o.name.localeCompare(b.o.name));
        const kinds = new Set(DEMO_OBJECTS.map((o) => o.kind)).size;
        return Promise.resolve({
          hits: scored.slice(0, 60).map((s) => s.o),
          indexedKinds: kinds,
          totalKinds: kinds + 3,
          forbiddenKinds: 3,
          failedKinds: 0,
          objects: DEMO_OBJECTS.length,
          warming: false,
          approxBytes: 4096,
        });
      }
      if (cmd === "apply_yaml") {
        return Promise.resolve({
          yaml: String(args.yaml ?? ""),
          resourceVersion: "demo",
        });
      }
      return Promise.resolve(cmd in FIXTURES ? FIXTURES[cmd] : []);
    },
    transformCallback: (cb: unknown) => cb,
  };
  // Loud on purpose: nothing on screen is real, and it should be
  // impossible to mistake this for a live cluster.
  console.warn(
    "[loupe] No Tauri bridge — running with demo fixtures. " +
      "This is dev-only and never reaches a production build.",
  );
}
