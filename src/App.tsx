import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { StatusBar } from "./components/StatusBar";
import { TabStrip } from "./components/TabStrip";
import { TrailBar } from "./components/TrailBar";
import { KIND_SECTIONS } from "./lib/kinds";
import type { Command } from "./lib/palette";
import { Sidebar } from "./components/Sidebar";
import { SkeletonBlock } from "./components/Skeleton";
import { ContextPicker } from "./pages/ContextPicker";
import { Namespaces, Nodes, Pods } from "./pages/Resources";
import { NodeDetail } from "./pages/NodeDetail";
import { NamespaceDetail } from "./pages/NamespaceDetail";
import { PodDetail } from "./pages/PodDetail";
import { ObjectDetail } from "./pages/ObjectDetail";
import { Crds } from "./pages/Crds";
import { KindBrowser } from "./pages/KindBrowser";
import { Helm, ReleaseDetail } from "./pages/Helm";
import { api, type ClusterInfo, type Guard } from "./lib/api";
import { ClusterContext } from "./lib/clusterContext";
import { applyTheme, isDark, parseTheme, type Theme } from "./lib/theme";
import {
  crumbsFor,
  parentOf,
  routeKey,
  type OpenIntent,
  type Route,
} from "./lib/routes";
import {
  activeTab,
  canGoBack,
  canGoForward,
  closeActiveTab,
  closeTab,
  currentRoute,
  goBack,
  goForward,
  navigate,
  newWorkspace,
  openInNewTab,
  selectIndex,
  selectTab,
  type Workspace,
} from "./lib/workspace";

export default function App() {
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);

  // Where the window is, in full: which tabs are open, what each has
  // shown, and which one is on screen. Every navigation in the app ends
  // up here, which is what makes back, forward and the trail work the
  // same way regardless of what did the navigating.
  const [workspace, setWorkspace] = useState<Workspace>(() => newWorkspace());

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

  const tab = activeTab(workspace);
  const route = currentRoute(workspace);
  const crumbs = crumbsFor(route);

  /// Go somewhere. `intent` is how the click asked to be handled — this
  /// tab, or one of its own — and is what makes ⌘-clicking a row fan a
  /// listing out into tabs.
  function open(next: Route, intent: OpenIntent = "here") {
    setWorkspace((ws) =>
      intent === "newTab"
        ? openInNewTab(ws, next, currentRoute(ws))
        : navigate(ws, next),
    );
  }

  /// Go somewhere from outside a listing — the palette, mostly, where
  /// there is no current view for the destination to have come from. A
  /// detail route is seeded with its listing so the trail is not empty
  /// on arrival.
  function jump(next: Route) {
    setWorkspace((ws) => {
      const under = parentOf(next);
      return under ? openInNewTab(ws, next, under) : navigate(ws, next);
    });
  }

  const back = () => setWorkspace(goBack);

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

    const goTo = (label: string, to: Route, hint?: string, keywords?: string) =>
      out.push({
        id: `view:${label}`,
        group: "Go to",
        label,
        hint,
        keywords,
        run: () => jump(to),
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
        run: () => jump({ type: "kind", entry }),
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
      id: "action:new-tab",
      group: "Action",
      label: "New tab",
      keywords: "open split",
      run: () =>
        setWorkspace((ws) => openInNewTab(ws, currentRoute(ws))),
    });
    out.push({
      id: "action:close-tab",
      group: "Action",
      label: "Close tab",
      run: () => setWorkspace(closeActiveTab),
    });
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
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      // Tab management. Guarded on the modifier rather than on focus:
      // these have to work while the cursor is in a filter box, which is
      // exactly where it is when someone decides to open a second tab.
      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setWorkspace((ws) => openInNewTab(ws, currentRoute(ws)));
        return;
      }
      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        setWorkspace(closeActiveTab);
        return;
      }
      if (mod && (e.key === "[" || e.key === "ArrowLeft")) {
        e.preventDefault();
        setWorkspace(goBack);
        return;
      }
      if (mod && (e.key === "]" || e.key === "ArrowRight")) {
        e.preventDefault();
        setWorkspace(goForward);
        return;
      }
      if (mod && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        setWorkspace((ws) => selectIndex(ws, Number(e.key) - 1));
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
    // Tabs go with it. They name objects in the cluster being left, and
    // a tab pointing at a pod that does not exist here is worse than
    // starting clean.
    setWorkspace(newWorkspace());
    setCluster(await api.currentCluster());
    setSwitching(false);
  }

  async function disconnect() {
    await api.disconnect();
    // Everything, because every connection is gone. A per-cluster
    // disconnect drops only that cluster's keys.
    queryClient.clear();
    setWorkspace(newWorkspace());
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
      <div className="ambient flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          <Sidebar
            route={route}
            onSelect={open}
            theme={theme}
            onThemeChange={chooseTheme}
          />

          <main className="flex min-w-0 flex-1 flex-col">
            <TabStrip
              tabs={workspace.tabs}
              active={workspace.active}
              onSelect={(id) => setWorkspace((ws) => selectTab(ws, id))}
              onClose={(id) => setWorkspace((ws) => closeTab(ws, id))}
              onNew={() =>
                setWorkspace((ws) => openInNewTab(ws, currentRoute(ws)))
              }
            />

            {/* Shown when it has something to say: an object sitting
                somewhere, or a history worth stepping through. On a
                listing opened fresh it is one crumb repeating the
                heading below it and two dead arrows — chrome paying no
                rent. */}
            {(crumbs.length > 1 || canGoBack(tab) || canGoForward(tab)) && (
              <TrailBar
                crumbs={crumbs}
                canBack={canGoBack(tab)}
                canForward={canGoForward(tab)}
                onBack={back}
                onForward={() => setWorkspace(goForward)}
                onCrumb={(to) => open(to)}
              />
            )}

            <div className="min-h-0 flex-1">
              <View route={route} open={open} back={back} />
            </div>
          </main>
        </div>

        <StatusBar
          cluster={cluster}
          guard={guard}
          onGuardChange={chooseGuard}
          onSwitchCluster={() => setSwitching(true)}
          onDisconnect={disconnect}
        />

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

/// One route, rendered.
///
/// Every page here is either a listing that reports what was opened, or
/// a detail view that reports where it wants to go next. None of them
/// decides what happens as a result — that is the workspace's, which is
/// why the same pod row can open in this tab or a new one without the
/// pod list knowing either exists.
function View({
  route,
  open,
  back,
}: {
  route: Route;
  open: (route: Route, intent?: OpenIntent) => void;
  back: () => void;
}) {
  switch (route.type) {
    case "nodes":
      return <Nodes onOpen={(n, i) => open({ type: "node", name: n.name }, i)} />;

    case "namespaces":
      return (
        <Namespaces
          onOpen={(n, i) => open({ type: "namespace", name: n.name }, i)}
        />
      );

    case "pods":
      return (
        <Pods
          onOpen={(p, i) =>
            open({ type: "pod", namespace: p.namespace, name: p.name }, i)
          }
        />
      );

    case "crds":
      return <Crds onSelectKind={(entry) => open({ type: "kind", entry })} />;

    case "helm":
      return (
        <Helm
          onOpen={(r, i) =>
            open({ type: "release", namespace: r.namespace, name: r.name }, i)
          }
        />
      );

    case "kind":
      return (
        <KindBrowser
          entry={route.entry}
          onOpen={(row, i) =>
            open(
              {
                type: "object",
                resource: route.entry.gvk,
                namespace: row.namespace,
                name: row.name,
              },
              i,
            )
          }
        />
      );

    case "node":
      return <NodeDetail key={route.name} name={route.name} onClose={back} />;

    case "namespace":
      return (
        <NamespaceDetail
          key={route.name}
          name={route.name}
          onClose={back}
          onOpenPod={(pod) =>
            open({ type: "pod", namespace: pod.namespace, name: pod.name })
          }
        />
      );

    case "pod":
      return (
        <PodDetail
          key={routeKey(route)}
          namespace={route.namespace}
          name={route.name}
          onClose={back}
        />
      );

    case "release":
      return (
        <ReleaseDetail
          key={routeKey(route)}
          namespace={route.namespace}
          name={route.name}
          onClose={back}
        />
      );

    case "object":
      return (
        <ObjectDetail
          // Keyed so following a related object remounts rather than
          // showing the previous object's tab state over the new one.
          key={routeKey(route)}
          resource={route.resource}
          namespace={route.namespace}
          name={route.name}
          onClose={back}
          onOpenRelated={(related) =>
            open({
              type: "object",
              resource: {
                group: related.group,
                version: related.version,
                kind: related.kind,
              },
              namespace: related.namespace,
              name: related.name,
            })
          }
        />
      );
  }
}
