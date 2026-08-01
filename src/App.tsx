import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar, type View } from "./components/Sidebar";
import { SkeletonBlock } from "./components/Skeleton";
import { ContextPicker } from "./pages/ContextPicker";
import { Namespaces, Nodes, Pods } from "./pages/Resources";
import { Crds } from "./pages/Crds";
import { KindBrowser } from "./pages/KindBrowser";
import { Helm } from "./pages/Helm";
import { api, type ClusterInfo } from "./lib/api";
import { applyTheme, isDark, parseTheme, type Theme } from "./lib/theme";

export default function App() {
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [view, setView] = useState<View>({ type: "nodes" });
  // Shown over a live connection when the user wants a different
  // cluster, so switching does not require disconnecting first.
  const [switching, setSwitching] = useState(false);
  // Distinguishes "haven't asked the backend yet" from "asked, and not
  // connected". Without it the picker flashes on every launch.
  const [ready, setReady] = useState(false);

  // App owns the appearance: the picker sets it, the OS feeds into it
  // when the preference is "system", and one effect applies the result.
  const [theme, setTheme] = useState<Theme>("system");

  const queryClient = useQueryClient();

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setTheme(parseTheme(s.theme)))
      // No settings file yet, or no bridge in browser dev. Following the
      // system is the right fallback either way.
      .catch(() => {});
  }, []);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const paint = () => applyTheme(isDark(theme, system.matches));
    paint();
    // Kept subscribed even when the preference is explicit: the user can
    // switch back to "system" without a reload, and re-subscribing on
    // every change would be the same work.
    system.addEventListener("change", paint);
    return () => system.removeEventListener("change", paint);
  }, [theme]);

  async function chooseTheme(next: Theme) {
    // Applied first: the click should feel instant, and a preference
    // that fails to persist is still the one the user asked for.
    setTheme(next);
    await api.setTheme(next).catch(() => {});
  }

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
        theme={theme}
        onThemeChange={chooseTheme}
        onSwitchCluster={() => setSwitching(true)}
        onDisconnect={disconnect}
      />
      <main className="min-w-0 flex-1">
        {view.type === "nodes" && <Nodes />}
        {view.type === "namespaces" && <Namespaces />}
        {view.type === "pods" && <Pods />}
        {view.type === "crds" && (
          <Crds onSelectKind={(entry) => setView({ type: "kind", entry })} />
        )}
        {view.type === "kind" && <KindBrowser entry={view.entry} />}
        {view.type === "helm" && <Helm />}
      </main>
    </div>
  );
}
