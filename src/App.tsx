import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { KIND_SECTIONS } from "./lib/kinds";
import type { Command } from "./lib/palette";
import { Sidebar, type View } from "./components/Sidebar";
import { SkeletonBlock } from "./components/Skeleton";
import { ContextPicker } from "./pages/ContextPicker";
import { Namespaces, Nodes, Pods } from "./pages/Resources";
import { Crds } from "./pages/Crds";
import { KindBrowser } from "./pages/KindBrowser";
import { Helm } from "./pages/Helm";
import { api, type ClusterInfo, type Guard } from "./lib/api";
import { ClusterContext } from "./lib/clusterContext";
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

  // What the connected context allows. Held here because every write
  // path needs it and none of the pages in between should have to carry
  // it. `open` until told otherwise: a failure to read preferences must
  // never silently lock someone out of their own cluster.
  const [guard, setGuard] = useState<Guard>("open");

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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

  useEffect(() => {
    if (!cluster) {
      setGuard("open");
      return;
    }
    api
      .contextGuard(cluster.context)
      .then(setGuard)
      .catch(() => setGuard("open"));
  }, [cluster]);

  // Custom resources belong in the palette too — on a cluster with forty
  // CRDs, hunting for one in the rail is exactly the mouse work this is
  // meant to remove. Shared cache key with the sidebar, so opening the
  // palette costs no extra discovery.
  const apiResources = useQuery({
    queryKey: ["api-resources"],
    queryFn: () => api.listApiResources(),
    staleTime: 5 * 60 * 1000,
    enabled: cluster != null,
  });

  const contexts = useQuery({
    queryKey: ["contexts"],
    queryFn: () => api.listContexts(),
    staleTime: 60 * 1000,
  });

  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];

    const goTo = (label: string, view: View, hint?: string, keywords?: string) =>
      out.push({
        id: `view:${label}`,
        group: "Go to",
        label,
        hint,
        keywords,
        run: () => setView(view),
      });

    goTo("Nodes", { type: "nodes" });
    goTo("Namespaces", { type: "namespaces" }, undefined, "ns");
    goTo("Pods", { type: "pods" });

    for (const section of KIND_SECTIONS) {
      for (const entry of section.items) {
        goTo("" + entry.label, { type: "kind", entry }, section.title, entry.gvk.kind);
      }
    }

    goTo("CRDs", { type: "crds" }, undefined, "custom resource definitions");
    goTo("Helm", { type: "helm" }, undefined, "releases charts");

    for (const resource of apiResources.data ?? []) {
      if (!resource.custom) continue;
      const entry = {
        id: `${resource.group}/${resource.version}/${resource.kind}`,
        label: resource.kind,
        gvk: {
          group: resource.group,
          version: resource.version,
          kind: resource.kind,
        },
      };
      out.push({
        id: `crd:${entry.id}`,
        group: "Go to",
        label: resource.kind,
        hint: resource.group,
        run: () => setView({ type: "kind", entry }),
      });
    }

    // Switching cluster without the mouse is most of the point on a
    // machine with more than one.
    for (const ctx of contexts.data ?? []) {
      if (ctx.name === cluster?.context) continue;
      out.push({
        id: `ctx:${ctx.name}`,
        group: "Cluster",
        label: ctx.name,
        hint: ctx.cluster,
        keywords: "switch context connect",
        run: async () => {
          try {
            await api.connect(ctx.name);
            await onConnected();
          } catch {
            // The picker is where connection failures are reported
            // properly; opening it puts the error where it belongs.
            setSwitching(true);
          }
        },
      });
    }

    out.push({
      id: "action:switch",
      group: "Action",
      label: "Switch cluster…",
      keywords: "context change",
      run: () => setSwitching(true),
    });
    out.push({
      id: "action:disconnect",
      group: "Action",
      label: "Disconnect",
      run: () => void disconnect(),
    });
    out.push({
      id: "action:shortcuts",
      group: "Action",
      label: "Keyboard shortcuts",
      keywords: "help keys",
      run: () => setShortcutsOpen(true),
    });
    for (const next of ["system", "light", "dark"] as Theme[]) {
      out.push({
        id: `theme:${next}`,
        group: "Action",
        label: `Appearance: ${next}`,
        keywords: "theme dark light",
        run: () => void chooseTheme(next),
      });
    }

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiResources.data, contexts.data, cluster?.context]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // `?` only when not typing, or it cannot be typed into a filter.
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function chooseGuard(next: Guard) {
    if (!cluster) return;
    setGuard(next);
    try {
      await api.setContextGuard(cluster.context, next);
    } catch {
      // A safeguard that did not persist is worse than one that visibly
      // failed to apply, so put it back.
      await api.contextGuard(cluster.context).then(setGuard).catch(() => {});
    }
  }

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
    // Still cleared. Query keys do not carry the cluster they came from,
    // so keeping them would let one cluster's rows appear under
    // another's name — which is far worse than a refetch.
    //
    // The switch is fast anyway, and for the part that actually cost
    // seconds: the Rust side retains each cluster's client and its API
    // discovery, so coming back re-authenticates nothing and re-walks
    // nothing. What is left is one listing request for the view on
    // screen. Isolating the frontend cache per cluster would remove that
    // too, and wants a key scheme rather than a comment.
    queryClient.clear();
    setCluster(await api.currentCluster());
    setSwitching(false);
  }

  async function disconnect() {
    await api.disconnect();
    // Everything, because every connection is gone. A per-cluster
    // disconnect drops only that cluster's keys.
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
    <ClusterContext.Provider value={{ context: cluster.context, guard }}>
      <div className="ambient flex h-full">
        <Sidebar
          cluster={cluster}
          view={view}
          onSelect={setView}
          theme={theme}
          onThemeChange={chooseTheme}
          guard={guard}
          onGuardChange={chooseGuard}
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

        {paletteOpen && (
          <CommandPalette
            commands={commands}
            onClose={() => setPaletteOpen(false)}
          />
        )}
        {shortcutsOpen && (
          <ShortcutSheet onClose={() => setShortcutsOpen(false)} />
        )}
      </div>
    </ClusterContext.Provider>
  );
}
