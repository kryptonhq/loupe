import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Panel } from "../components/Panel";
import { SkeletonBlock } from "../components/Skeleton";
import { StatusDot, type Tone } from "../components/StatusDot";
import type {
  ClusterInfo,
  Overview,
  Problem,
  ProblemsSnapshot,
  ProblemSource as Source,
  Severity,
  UsageAnswer,
} from "../lib/api";
import { api } from "../lib/api";
import {
  busiestNodes,
  clusterUsage,
  formatBytes,
  formatCores,
  joinUsage,
  kindEntry,
  nodeLoad,
  percent,
  pressure,
  tallyProblems,
  topProblems,
  workloadHealth,
  type NodeLoad,
  type Pressure,
} from "../lib/dashboard";
import { routeForProblem } from "../lib/problems";
import type { OpenIntent, Route } from "../lib/routes";
import type { ProblemsState } from "../lib/useProblems";
import { Message } from "./Problems";

// How the cluster is doing, at a glance.
//
// Everything here except live usage comes from the Problems monitor's
// snapshot — the same watched store, pushed on change — so the dashboard
// costs the cluster nothing the Problems view was not already paying,
// and is exactly as current. Usage comes from metrics-server when there
// is one, polled, and the page says plainly when there is not.
//
// Every number is a way in: a tile, a row or a bar opens the listing or
// the object behind it.

/// How often live usage is asked for. metrics-server itself only
/// scrapes every fifteen seconds, so asking more often gets the same
/// numbers back.
const USAGE_EVERY_MS = 15_000;

/// Rows per list widget. A glance, not a listing.
const ROWS = 5;

type Open = (route: Route, intent?: OpenIntent) => void;

/// ⌘ or Ctrl asks for a tab of its own, as it does on a listing row.
const intentOf = (e: React.MouseEvent): OpenIntent =>
  e.metaKey || e.ctrlKey ? "newTab" : "here";

interface DashboardProps {
  state: ProblemsState;
  cluster: ClusterInfo | null;
  open: Open;
}

export function Dashboard({ state, cluster, open }: DashboardProps) {
  const { snapshot, error } = state;

  const usage = useQuery({
    queryKey: ["node-usage", cluster?.context ?? null],
    queryFn: () => api.nodeUsage(),
    refetchInterval: USAGE_EVERY_MS,
    enabled: cluster != null,
  });

  const subtitle = cluster
    ? `${cluster.context} · Kubernetes ${cluster.version} · ${cluster.platform}`
    : "Cluster overview";

  return (
    <Panel title="Dashboard" subtitle={subtitle} error={error}>
      <div className="h-full overflow-y-auto bg-surface-2/60">
        {snapshot ? (
          <Widgets snapshot={snapshot} usage={usage.data} open={open} />
        ) : (
          <Loading />
        )}
      </div>
    </Panel>
  );
}

function Loading() {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <SkeletonBlock key={i} className={i < 4 ? "h-24" : "h-44"} />
      ))}
    </div>
  );
}

/// Which sources could not be read, so a widget built on one says so
/// rather than showing a confident zero.
function blocked(snapshot: ProblemsSnapshot, ...sources: Source[]): string | null {
  for (const s of snapshot.sources) {
    if (!sources.includes(s.source)) continue;
    if (s.state === "forbidden") return `Not permitted to list ${s.source}`;
    if (s.state === "failed") return `Could not list ${s.source}`;
  }
  return null;
}

function loading(snapshot: ProblemsSnapshot, ...sources: Source[]): boolean {
  return snapshot.sources.some((s) => sources.includes(s.source) && s.state === "loading");
}

function Widgets({
  snapshot,
  usage,
  open,
}: {
  snapshot: ProblemsSnapshot;
  usage: UsageAnswer | undefined;
  open: Open;
}) {
  const o = snapshot.overview;
  const nodes = useMemo(() => joinUsage(o.nodeRows, usage), [o.nodeRows, usage]);
  const live = useMemo(() => clusterUsage(nodes), [nodes]);

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* The headline row: four numbers, each a way into its listing. */}
      <NodesTile snapshot={snapshot} open={open} />
      <PodsTile snapshot={snapshot} open={open} />
      <WorkloadsTile snapshot={snapshot} open={open} />
      <ProblemsTile snapshot={snapshot} open={open} />

      {/* Capacity: what is used, what is promised, and pod slots. */}
      <ResourceCard
        title="CPU"
        blockedBy={blocked(snapshot, "nodes", "pods")}
        loading={loading(snapshot, "nodes", "pods")}
        used={live ? { value: live.cpuUsed, of: live.cpuAllocatable } : null}
        requested={{ value: o.capacity.cpuRequested, of: o.capacity.cpuAllocatable }}
        format={formatCores}
        unit="cores"
        usage={usage}
      />
      <ResourceCard
        title="Memory"
        blockedBy={blocked(snapshot, "nodes", "pods")}
        loading={loading(snapshot, "nodes", "pods")}
        used={live ? { value: live.memoryUsed, of: live.memoryAllocatable } : null}
        requested={{ value: o.capacity.memoryRequested, of: o.capacity.memoryAllocatable }}
        format={formatBytes}
        unit=""
        usage={usage}
      />
      <PodCapacityCard overview={o} blockedBy={blocked(snapshot, "nodes", "pods")} />
      <PodPhasesCard overview={o} blockedBy={blocked(snapshot, "pods")} open={open} />

      <ProblemsCard snapshot={snapshot} open={open} />
      <WorkloadsCard snapshot={snapshot} open={open} />

      <NodesCard
        nodes={nodes}
        hasUsage={live != null}
        blockedBy={blocked(snapshot, "nodes")}
        open={open}
      />
      <RestartsCard overview={o} blockedBy={blocked(snapshot, "pods")} open={open} />

      <NamespacesCard overview={o} blockedBy={blocked(snapshot, "pods")} open={open} />
      <StorageCard overview={o} blockedBy={blocked(snapshot, "persistentVolumeClaims")} open={open} />
    </div>
  );
}

// ─── Frames ────────────────────────────────────────────────────────────

function Card({
  title,
  action,
  className = "",
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col rounded-lg border bg-surface-1 p-4 ${className}`}
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-content-secondary">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/// A widget whose source could not be read. Said, not implied by zeros.
function Blocked({ reason }: { reason: string }) {
  return <p className="text-xs text-content-muted">{reason}, so this is unknown.</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-content-muted">{children}</p>;
}

function LinkButton({ onClick, children }: { onClick: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-sm text-2xs text-content-muted transition-colors hover:text-accent"
    >
      {children}
    </button>
  );
}

/// A headline number that opens the listing behind it.
function Tile({
  label,
  value,
  of,
  detail,
  tone,
  blockedBy,
  onOpen,
}: {
  label: string;
  value: ReactNode;
  of?: ReactNode;
  detail: ReactNode;
  tone?: Tone;
  blockedBy?: string | null;
  onOpen: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onOpen}
      title={`Open ${label}`}
      className="group flex min-w-0 flex-col items-start rounded-lg border bg-surface-1 p-4 text-left transition-colors duration-150 ease-swift hover:border-strong"
    >
      <span className="flex w-full items-center justify-between text-xs font-semibold text-content-secondary">
        {label}
        <span aria-hidden className="text-content-muted opacity-0 transition-opacity group-hover:opacity-100">
          →
        </span>
      </span>
      {blockedBy ? (
        <span className="mt-3 text-xs text-content-muted">{blockedBy}</span>
      ) : (
        <>
          <span className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight text-content">{value}</span>
            {of != null && <span className="text-sm text-content-muted">/ {of}</span>}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-2xs text-content-secondary">
            {tone && <Dot tone={tone} />}
            <span className="truncate">{detail}</span>
          </span>
        </>
      )}
    </button>
  );
}

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  unknown: "bg-content-muted",
};

function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />;
}

const FILL: Record<Pressure, string> = {
  normal: "bg-accent",
  high: "bg-warn",
  critical: "bg-danger",
};

const TRACK: Record<Pressure, string> = {
  normal: "bg-accent/15",
  high: "bg-warn/15",
  critical: "bg-danger/15",
};

/// A ratio against a limit. The track is a lighter step of the fill, so
/// the whole bar reads as one state; it turns warn and danger only near
/// the ceiling, where scheduling starts to fail, and says so in words.
function Meter({ pct, label, thin = false }: { pct: number | null; label: string; thin?: boolean }) {
  const p = pressure(pct);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      title={pct == null ? `${label}: unknown` : `${label}: ${pct}%`}
      className={`${thin ? "h-1" : "h-1.5"} w-full overflow-hidden rounded-full ${TRACK[p]}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ease-swift ${FILL[p]}`}
        // Over-commitment is real — requests can exceed allocatable — so
        // the bar clamps and the number beside it tells the truth.
        style={{ width: `${Math.min(100, pct ?? 0)}%` }}
      />
    </div>
  );
}

function PressureNote({ pct }: { pct: number | null }) {
  const p = pressure(pct);
  if (p === "normal") return null;
  return (
    <span className={`text-2xs font-medium ${p === "critical" ? "text-danger" : "text-warn"}`}>
      {p === "critical" ? "Near full" : "High"}
    </span>
  );
}

// ─── Headline tiles ────────────────────────────────────────────────────

function NodesTile({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  const n = snapshot.overview.nodes;
  const down = n.total - n.ready;
  const parts = [down > 0 ? `${down} not ready` : "All ready"];
  if (n.cordoned > 0) parts.push(`${n.cordoned} cordoned`);
  return (
    <Tile
      label="Nodes"
      value={n.ready}
      of={n.total}
      detail={parts.join(" · ")}
      tone={n.total === 0 ? "unknown" : down > 0 ? "danger" : n.cordoned > 0 ? "warn" : "ok"}
      blockedBy={blocked(snapshot, "nodes")}
      onOpen={(e) => open({ type: "nodes" }, intentOf(e))}
    />
  );
}

function PodsTile({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  const p = snapshot.overview.pods;
  const trouble = p.pending + p.failed + p.crashLooping;
  const parts: string[] = [];
  if (p.crashLooping) parts.push(`${p.crashLooping} crash-looping`);
  if (p.pending) parts.push(`${p.pending} pending`);
  if (p.failed) parts.push(`${p.failed} failed`);
  return (
    <Tile
      label="Pods running"
      value={p.running}
      of={p.total}
      detail={parts.length ? parts.join(" · ") : "Nothing pending or failing"}
      tone={p.total === 0 ? "unknown" : p.crashLooping || p.failed ? "danger" : trouble ? "warn" : "ok"}
      blockedBy={blocked(snapshot, "pods")}
      onOpen={(e) => open({ type: "pods" }, intentOf(e))}
    />
  );
}

function WorkloadsTile({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  const { healthy, total } = workloadHealth(snapshot.overview);
  const short = total - healthy;
  const deployments = kindEntry("Deployment");
  return (
    <Tile
      label="Workloads healthy"
      value={healthy}
      of={total}
      detail={
        short > 0
          ? `${short} short of replicas`
          : "Deployments, StatefulSets, DaemonSets"
      }
      tone={total === 0 ? "unknown" : short > 0 ? "warn" : "ok"}
      blockedBy={blocked(snapshot, "deployments", "statefulSets", "daemonSets")}
      onOpen={(e) => deployments && open({ type: "kind", entry: deployments }, intentOf(e))}
    />
  );
}

function ProblemsTile({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  const { critical, warning } = tallyProblems(snapshot.problems);
  return (
    <Tile
      label="Problems"
      value={critical + warning}
      detail={
        critical + warning === 0
          ? "Nothing wrong right now"
          : `${critical} critical · ${warning} warning`
      }
      tone={critical ? "danger" : warning ? "warn" : "ok"}
      onOpen={(e) => open({ type: "problems" }, intentOf(e))}
    />
  );
}

// ─── Capacity ──────────────────────────────────────────────────────────

function ResourceCard({
  title,
  blockedBy,
  loading,
  used,
  requested,
  format,
  unit,
  usage,
}: {
  title: string;
  blockedBy: string | null;
  loading: boolean;
  used: { value: number; of: number } | null;
  requested: { value: number; of: number };
  format: (n: number) => string;
  unit: string;
  usage: UsageAnswer | undefined;
}) {
  const usedPct = used ? percent(used.value, used.of) : null;
  const reqPct = percent(requested.value, requested.of);
  // The headline is what the machines are doing when that is known, and
  // what has been promised when it is not — labelled either way, since
  // the two are routinely far apart.
  const headline = used ? usedPct : reqPct;
  const suffix = unit ? ` ${unit}` : "";

  return (
    <Card title={title} action={<PressureNote pct={headline} />}>
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : loading ? (
        <SkeletonBlock className="h-16" />
      ) : (
        <>
          <p className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight">
              {headline == null ? "—" : `${headline}%`}
            </span>
            <span className="text-2xs text-content-muted">{used ? "in use" : "requested"}</span>
          </p>

          <div className="mt-3 space-y-2.5">
            {used && (
              <Row
                label="In use"
                value={`${format(used.value)} of ${format(used.of)}${suffix}`}
                pct={usedPct}
              />
            )}
            <Row
              label="Requested"
              value={`${format(requested.value)} of ${format(requested.of)}${suffix}`}
              pct={reqPct}
            />
          </div>

          {usage?.state === "unavailable" && (
            <p className="mt-3 text-2xs text-content-muted" title={usage.reason}>
              Live usage unavailable: {usage.reason}.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Row({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-2xs">
        <span className="text-content-secondary">{label}</span>
        <span className="truncate font-mono tabular-nums text-content-muted">
          {value}
          {pct != null && <span className="ml-1.5 text-content-secondary">{pct}%</span>}
        </span>
      </div>
      <Meter pct={pct} label={label} />
    </div>
  );
}

function PodCapacityCard({ overview, blockedBy }: { overview: Overview; blockedBy: string | null }) {
  const { podsScheduled, podsAllocatable } = overview.capacity;
  const pct = percent(podsScheduled, podsAllocatable);
  return (
    <Card title="Pod slots" action={<PressureNote pct={pct} />}>
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : (
        <>
          <p className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight">
              {pct == null ? "—" : `${pct}%`}
            </span>
            <span className="text-2xs text-content-muted">of pod capacity</span>
          </p>
          <div className="mt-3">
            <Row label="Scheduled" value={`${podsScheduled} of ${podsAllocatable}`} pct={pct} />
          </div>
          <p className="mt-3 text-2xs text-content-muted">
            The kubelet's max-pods across all nodes. A cluster can run out of
            slots with CPU and memory to spare.
          </p>
        </>
      )}
    </Card>
  );
}

/// Pod phases, worst first. Status colours, because a phase is a state;
/// Succeeded is neutral, since a finished Job pod is done, not healthy.
const PHASES: { key: keyof Overview["pods"]; label: string; tone: Tone }[] = [
  { key: "failed", label: "Failed", tone: "danger" },
  { key: "pending", label: "Pending", tone: "warn" },
  { key: "running", label: "Running", tone: "ok" },
  { key: "succeeded", label: "Succeeded", tone: "unknown" },
  { key: "unknown", label: "Unknown", tone: "unknown" },
];

function PodPhasesCard({
  overview,
  blockedBy,
  open,
}: {
  overview: Overview;
  blockedBy: string | null;
  open: Open;
}) {
  const p = overview.pods;
  const shown = PHASES.filter((ph) => p[ph.key] > 0);
  return (
    <Card
      title="Pod phases"
      action={<LinkButton onClick={(e) => open({ type: "pods" }, intentOf(e))}>All pods →</LinkButton>}
    >
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : p.total === 0 ? (
        <Empty>No pods.</Empty>
      ) : (
        <>
          {/* One stacked bar; a 2px gap between segments keeps adjacent
              states apart without a border colour of their own. */}
          <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {shown.map((ph) => (
              <div
                key={ph.key}
                title={`${ph.label}: ${p[ph.key]}`}
                className={`h-full first:rounded-l-full last:rounded-r-full ${DOT[ph.tone]} ${ph.key === "succeeded" || ph.key === "unknown" ? "opacity-50" : ""}`}
                style={{ width: `${(p[ph.key] / p.total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="mt-3 space-y-1.5">
            {PHASES.map((ph) => (
              <li key={ph.key} className="flex items-center justify-between text-2xs">
                <StatusDot tone={ph.tone} label={ph.label} />
                <span className="font-mono tabular-nums text-content-secondary">{p[ph.key]}</span>
              </li>
            ))}
          </ul>
          {p.crashLooping > 0 && (
            <p className="mt-3 border-t pt-2 text-2xs text-danger">
              {p.crashLooping} running {p.crashLooping === 1 ? "pod is" : "pods are"} crash-looping
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Lists ─────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  warning: "warn",
  info: "unknown",
};

function ProblemsCard({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  const rows = topProblems(snapshot.problems, 6);
  const { critical, warning } = tallyProblems(snapshot.problems);
  const total = critical + warning;
  const openRow = (p: Problem, e: React.MouseEvent) => {
    const to = routeForProblem(p);
    if (to) open(to, intentOf(e));
  };

  return (
    <Card
      title="Problems"
      className="sm:col-span-2"
      action={
        <LinkButton onClick={(e) => open({ type: "problems" }, intentOf(e))}>
          {total > rows.length ? `All ${total} →` : "Open Problems →"}
        </LinkButton>
      }
    >
      {rows.length === 0 ? (
        <Empty>Nothing broken right now.</Empty>
      ) : (
        <ul className="-mx-2 divide-y">
          {rows.map((p) => (
            <li key={p.id}>
              <button
                onClick={(e) => openRow(p, e)}
                disabled={!p.target}
                className="flex w-full min-w-0 items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors enabled:hover:bg-content/[0.04]"
              >
                <span className="pt-1.5">
                  <Dot tone={SEVERITY_TONE[p.severity]} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="shrink-0 font-medium text-content">{p.reason}</span>
                    {p.target && (
                      <span className="truncate text-content-muted">
                        {p.target.kind} {p.target.namespace ? `${p.target.namespace}/` : ""}
                        {p.target.name}
                      </span>
                    )}
                    {p.count != null && p.count > 1 && (
                      <span className="shrink-0 font-mono text-2xs text-content-muted">×{p.count}</span>
                    )}
                  </span>
                  <span className="block truncate text-2xs text-content-secondary">
                    <Message text={p.message} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const WORKLOAD_LABEL: Record<string, string> = {
  Deployment: "Deployments",
  StatefulSet: "StatefulSets",
  DaemonSet: "DaemonSets",
  Job: "Jobs",
  CronJob: "CronJobs",
};

const WORKLOAD_SOURCE: Record<string, Source> = {
  Deployment: "deployments",
  StatefulSet: "statefulSets",
  DaemonSet: "daemonSets",
  Job: "jobs",
  CronJob: "cronJobs",
};

/// What the ones that are not healthy are, per kind.
const UNHEALTHY_WORD: Record<string, string> = {
  Deployment: "short",
  StatefulSet: "short",
  DaemonSet: "short",
  Job: "failed",
  CronJob: "suspended",
};

/// What "healthy" means per kind, for the tooltip.
const HEALTHY_MEANS: Record<string, string> = {
  Deployment: "every replica available",
  StatefulSet: "every replica available",
  DaemonSet: "available on every node it should run on",
  Job: "not failed",
  CronJob: "not suspended",
};

function WorkloadsCard({ snapshot, open }: { snapshot: ProblemsSnapshot; open: Open }) {
  return (
    <Card title="Workloads" className="sm:col-span-2">
      <ul className="-mx-2">
        {snapshot.overview.workloads.map((w) => {
          const entry = kindEntry(w.kind);
          const why = blocked(snapshot, WORKLOAD_SOURCE[w.kind]);
          const pct = percent(w.healthy, w.total);
          const short = w.total - w.healthy;
          return (
            <li key={w.kind}>
              <button
                onClick={(e) => entry && open({ type: "kind", entry }, intentOf(e))}
                title={`Healthy: ${HEALTHY_MEANS[w.kind] ?? "running as asked"}`}
                className="grid w-full grid-cols-[7.5rem_1fr_auto] items-center gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/[0.04]"
              >
                <span className="truncate text-content">{WORKLOAD_LABEL[w.kind] ?? w.kind}</span>
                {why ? (
                  <span className="text-2xs text-content-muted">{why}</span>
                ) : (
                  <HealthBar healthy={w.healthy} total={w.total} />
                )}
                <span className="font-mono text-2xs tabular-nums text-content-secondary">
                  {why ? "—" : `${w.healthy}/${w.total}`}
                  {!why && short > 0 && (
                    <span className="ml-1.5 text-warn">
                      {short} {UNHEALTHY_WORD[w.kind] ?? "unhealthy"}
                    </span>
                  )}
                  {!why && short === 0 && pct != null && (
                    <span className="ml-1.5 text-content-muted">ok</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/// Healthy against unhealthy, as one bar. Status colours: this is state,
/// not magnitude.
function HealthBar({ healthy, total }: { healthy: number; total: number }) {
  if (total === 0) return <span className="h-1.5 rounded-full bg-content/[0.06]" aria-hidden />;
  const pct = (healthy / total) * 100;
  return (
    <span className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {healthy > 0 && <span className="h-full rounded-l-full bg-success" style={{ width: `${pct}%` }} />}
      {healthy < total && (
        <span className="h-full flex-1 rounded-r-full bg-warn" />
      )}
    </span>
  );
}

function NodesCard({
  nodes,
  hasUsage,
  blockedBy,
  open,
}: {
  nodes: NodeLoad[];
  hasUsage: boolean;
  blockedBy: string | null;
  open: Open;
}) {
  const rows = busiestNodes(nodes, ROWS);
  return (
    <Card
      title={hasUsage ? "Busiest nodes" : "Busiest nodes, by requests"}
      className="sm:col-span-2"
      action={<LinkButton onClick={(e) => open({ type: "nodes" }, intentOf(e))}>All {nodes.length} →</LinkButton>}
    >
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : rows.length === 0 ? (
        <Empty>No nodes.</Empty>
      ) : (
        <>
          <div className="mb-1 grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-3 px-2 text-2xs text-content-muted">
            <span>Node</span>
            <span>CPU</span>
            <span>Memory</span>
          </div>
          <ul className="-mx-2">
            {rows.map((n) => {
              const cpu = percent(n.cpuUsed ?? n.cpuRequested, n.cpuAllocatable);
              const mem = percent(n.memoryUsed ?? n.memoryRequested, n.memoryAllocatable);
              const state = !n.ready ? "Not ready" : n.cordoned ? "Cordoned" : null;
              return (
                <li key={n.name}>
                  <button
                    onClick={(e) => open({ type: "node", name: n.name }, intentOf(e))}
                    title={`${n.name} — ${n.pods} pods, load ${nodeLoad(n)}%`}
                    className="grid w-full grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] items-center gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/[0.04]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Dot tone={!n.ready ? "danger" : n.cordoned ? "warn" : "ok"} />
                      <span className="truncate font-mono text-2xs">{n.name}</span>
                      {state && <span className="shrink-0 text-2xs text-content-muted">{state}</span>}
                    </span>
                    <NodeMeter pct={n.ready ? cpu : null} label={`${n.name} CPU`} />
                    <NodeMeter pct={n.ready ? mem : null} label={`${n.name} memory`} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

function NodeMeter({ pct, label }: { pct: number | null; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Meter pct={pct} label={label} thin />
      <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-content-secondary">
        {pct == null ? "—" : `${pct}%`}
      </span>
    </span>
  );
}

function RestartsCard({
  overview,
  blockedBy,
  open,
}: {
  overview: Overview;
  blockedBy: string | null;
  open: Open;
}) {
  return (
    <Card title="Most restarts" className="sm:col-span-2">
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : overview.restarts.length === 0 ? (
        <Empty>No container has restarted.</Empty>
      ) : (
        <ul className="-mx-2">
          {overview.restarts.map((r) => (
            <li key={`${r.namespace}/${r.pod}/${r.container}`}>
              <button
                onClick={(e) => open({ type: "pod", namespace: r.namespace, name: r.pod }, intentOf(e))}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/[0.04]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-content">{r.pod}</span>
                  <span className="block truncate text-2xs text-content-muted">
                    {r.namespace} · {r.container}
                    {r.lastReason && ` · last ${r.lastReason}`}
                  </span>
                </span>
                <span className="font-mono text-xs tabular-nums text-content-secondary">
                  {r.restarts}×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NamespacesCard({
  overview,
  blockedBy,
  open,
}: {
  overview: Overview;
  blockedBy: string | null;
  open: Open;
}) {
  return (
    <Card
      title="Namespaces by pods"
      className="sm:col-span-2"
      action={
        <LinkButton onClick={(e) => open({ type: "namespaces" }, intentOf(e))}>
          All {overview.namespaceCount} →
        </LinkButton>
      }
    >
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : overview.namespaces.length === 0 ? (
        <Empty>No pods in any namespace.</Empty>
      ) : (
        <ul className="-mx-2">
          {overview.namespaces.map((n, _, all) => (
            <li key={n.namespace}>
              <button
                onClick={(e) =>
                  open({ type: "pods", view: { namespace: n.namespace } }, intentOf(e))
                }
                title={`Pods in ${n.namespace}`}
                className="grid w-full grid-cols-[8rem_1fr_2.5rem] items-center gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-content/[0.04]"
              >
                <span className="truncate text-content">{n.namespace}</span>
                {/* Magnitude, so one hue: the accent, scaled to the
                    largest namespace rather than to 100%. */}
                <span className="h-1.5 w-full overflow-hidden rounded-full bg-accent/10" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-accent"
                    // Largest first, and a namespace is only listed
                    // because it has pods, so the first is never zero.
                    style={{ width: `${(n.pods / all[0].pods) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-2xs tabular-nums text-content-secondary">
                  {n.pods}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StorageCard({
  overview,
  blockedBy,
  open,
}: {
  overview: Overview;
  blockedBy: string | null;
  open: Open;
}) {
  const c = overview.claims;
  const claims = kindEntry("PersistentVolumeClaim");
  const rows: { label: string; value: number; tone: Tone }[] = [
    { label: "Bound", value: c.bound, tone: "ok" },
    { label: "Pending", value: c.pending, tone: "warn" },
    { label: "Lost", value: c.lost, tone: "danger" },
  ];
  return (
    <Card
      title="Volume claims"
      className="sm:col-span-2"
      action={
        claims && (
          <LinkButton onClick={(e) => open({ type: "kind", entry: claims }, intentOf(e))}>
            All {c.total} →
          </LinkButton>
        )
      }
    >
      {blockedBy ? (
        <Blocked reason={blockedBy} />
      ) : c.total === 0 ? (
        <Empty>No persistent volume claims.</Empty>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {rows.map((r) => (
            <div key={r.label} className="rounded-sm bg-content/[0.03] px-3 py-2">
              <p className="text-2xl font-semibold tracking-tight">{r.value}</p>
              <p className="mt-0.5">
                <StatusDot tone={r.value > 0 ? r.tone : "unknown"} label={r.label} />
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
