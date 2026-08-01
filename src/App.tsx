import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar, type View } from "./components/Sidebar";
import { SkeletonBlock } from "./components/Skeleton";
import { ContextPicker } from "./pages/ContextPicker";
import { Namespaces, Nodes, Pods } from "./pages/Resources";
import { Crds } from "./pages/Crds";
import { Helm } from "./pages/Helm";
import { api, type ApiResourceInfo, type ClusterInfo } from "./lib/api";

export default function App() {
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [view, setView] = useState<View>("nodes");
  // Owned here rather than inside the CRDs page: the sidebar selects a
  // kind too, and two owners of one selection drift apart the moment
  // either changes it.
  const [crd, setCrd] = useState<ApiResourceInfo | null>(null);
  // Shown over a live connection when the user wants a different
  // cluster, so switching does not require disconnecting first.
  const [switching, setSwitching] = useState(false);
  // Distinguishes "haven't asked the backend yet" from "asked, and not
  // connected". Without it the picker flashes on every launch.
  const [ready, setReady] = useState(false);

  const queryClient = useQueryClient();

  useEffect(() => {
    // The session lives in Rust, so a webview reload reconnects to the
    // existing client rather than dropping the user back to the picker.
    api
      .currentCluster()
      .then(setCluster)
      .catch(() => setCluster(null))
      .finally(() => setReady(true));
  }, []);

  async function onConnected() {
    // Every cached list belongs to the previous cluster. Clearing rather
    // than invalidating means no stale rows from the old cluster can
    // flash on screen while the new ones load.
    queryClient.clear();
    setCluster(await api.currentCluster());
    setSwitching(false);
  }

  async function disconnect() {
    await api.disconnect();
    queryClient.clear();
    setCluster(null);
    setSwitching(false);
  }

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <SkeletonBlock className="h-10 w-10 rounded-full" />
      </div>
    );
  }

  if (!cluster || switching) {
    return (
      <ContextPicker
        current={cluster}
        onConnected={onConnected}
        onCancel={cluster ? () => setSwitching(false) : undefined}
      />
    );
  }

  return (
    <div className="ambient flex h-full">
      <Sidebar
        cluster={cluster}
        view={view}
        onSelect={setView}
        crd={crd}
        onSelectCrd={setCrd}
        onSwitchCluster={() => setSwitching(true)}
        onDisconnect={disconnect}
      />
      <main className="min-w-0 flex-1">
        {view === "nodes" && <Nodes />}
        {view === "namespaces" && <Namespaces />}
        {view === "pods" && <Pods />}
        {view === "crds" && <Crds resource={crd} onSelectKind={setCrd} />}
        {view === "helm" && <Helm />}
      </main>
    </div>
  );
}
