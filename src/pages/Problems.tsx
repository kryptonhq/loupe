import { useMemo } from "react";
import { ResourceTable } from "../components/ResourceTable";
import type { Column } from "../components/Table";
import { Chip, type ChipTone } from "../components/Chip";
import { Panel } from "../components/Panel";
import { Select } from "../components/Select";
import { StatusDot, type Tone } from "../components/StatusDot";
import type { Problem, ProblemCategory, Severity } from "../lib/api";
import {
  SEVERITY_RANK,
  formatSeconds,
  inNamespace,
  namespacesOf,
  problemAge,
  settled,
} from "../lib/problems";
import type { ListView, OpenIntent } from "../lib/routes";
import type { ProblemsState } from "../lib/useProblems";

// Everything currently broken, in one place.
//
// The page renders what the monitor in the Rust core decided; it decides
// nothing about what is a problem. It owns the presentation — the
// namespace filter, the sort, where a row leads — and it keeps those on
// the route, like every other listing, so they survive opening a row and
// differ between tabs.

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  warning: "warn",
  info: "unknown",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

const CATEGORY_LABEL: Record<ProblemCategory, string> = {
  pods: "Pods",
  workloads: "Workloads",
  nodes: "Nodes",
  events: "Events",
  storage: "Storage",
};

const CATEGORY_TONE: Record<ProblemCategory, ChipTone> = {
  pods: "ok",
  workloads: "accent",
  nodes: "info",
  events: "neutral",
  storage: "warn",
};

/// A message with its `quoted` names set as code. The core quotes the
/// identifiers it mentions — containers, images, taints — so they read
/// as names rather than as words in the sentence.
export function Message({ text }: { text: string }) {
  const parts = text.split("`");
  // An odd number of parts means the backticks paired up; anything else
  // is a message that happened to contain one, shown as written.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded-sm bg-content/[0.06] px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface ProblemsProps {
  state: ProblemsState;
  /// Called for rows with something to open; the "not permitted" rows
  /// have nothing behind them.
  onOpen: (problem: Problem, intent: OpenIntent) => void;
  view: ListView;
  onView: (patch: Partial<ListView>) => void;
}

export function Problems({ state, onOpen, view, onView }: ProblemsProps) {
  const { snapshot, receivedAt, error } = state;
  const namespace = view.namespace ?? "";

  const rows = useMemo(
    () => (snapshot ? inNamespace(snapshot.problems, namespace) : undefined),
    [snapshot, namespace],
  );
  const namespaces = useMemo(
    () => namespacesOf(snapshot?.problems ?? []),
    [snapshot],
  );

  // Ages are measured on the core's clock plus however long ago the
  // snapshot arrived here, so they keep moving between snapshots.
  const elapsed = receivedAt ? Math.max(0, (Date.now() - receivedAt) / 1000) : 0;
  const ageOf = (p: Problem) =>
    snapshot ? problemAge(p, snapshot.generatedAt, elapsed) : null;

  const columns: Column<Problem>[] = [
    {
      key: "severity",
      header: "Severity",
      width: "7rem",
      render: (p) => <StatusDot tone={SEVERITY_TONE[p.severity]} label={SEVERITY_LABEL[p.severity]} />,
      sortValue: (p) => SEVERITY_RANK[p.severity],
    },
    {
      key: "category",
      header: "Category",
      width: "7rem",
      render: (p) => <Chip tone={CATEGORY_TONE[p.category]}>{CATEGORY_LABEL[p.category]}</Chip>,
      sortValue: (p) => p.category,
    },
    {
      key: "object",
      header: "Object",
      render: (p) =>
        p.target ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-content">{p.target.name}</span>
            <span className="truncate text-2xs text-content-muted">
              {p.target.kind}
              {p.target.namespace && ` · ${p.target.namespace}`}
            </span>
          </span>
        ) : (
          <span className="text-content-muted">—</span>
        ),
      sortValue: (p) =>
        p.target ? `${p.target.kind}/${p.target.namespace ?? ""}/${p.target.name}` : "",
    },
    {
      key: "reason",
      header: "Reason",
      render: (p) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-2xs text-content-secondary">{p.reason}</span>
            {p.count != null && p.count > 1 && (
              <Chip tone="neutral" mono title={`Seen ${p.count} times`}>
                ×{p.count}
              </Chip>
            )}
          </span>
          <span className="text-content" title={p.message.split("`").join("")}>
            <Message text={p.message} />
          </span>
        </span>
      ),
      sortValue: (p) => p.reason,
    },
    {
      key: "age",
      header: "Age",
      width: "5rem",
      mono: true,
      render: (p) => {
        const age = ageOf(p);
        return age == null ? "—" : formatSeconds(age);
      },
      // Numbers rather than the printed age, so the sort is in seconds.
      sortValue: (p) => ageOf(p),
    },
  ];

  const unavailable = snapshot?.sources.filter(
    (s) => s.state === "forbidden" || s.state === "failed",
  );
  const loading = snapshot != null && !settled(snapshot);

  return (
    <Panel
      title="Problems"
      subtitle={
        snapshot
          ? `Across ${namespace ? `namespace ${namespace}` : "the cluster"} · pending or unready for over ${formatSeconds(snapshot.graceSeconds)}, or ${snapshot.restartThreshold}+ restarts in the last hour`
          : "Across the cluster"
      }
      error={error}
    >
      <ResourceTable
        columns={columns}
        rows={rows}
        isLoading={snapshot == null && error == null}
        rowKey={(p) => p.id}
        searchText={(p) =>
          `${p.reason} ${p.message} ${p.category} ${p.target?.kind ?? ""} ${p.target?.namespace ?? ""} ${p.target?.name ?? ""}`
        }
        empty={
          loading
            ? "Still checking the cluster…"
            : unavailable && unavailable.length > 0
              ? "Nothing wrong in what Loupe was permitted to check."
              : "Nothing is broken."
        }
        onRowClick={(p, intent) => {
          if (p.target) onOpen(p, intent);
        }}
        view={view}
        onView={onView}
        toolbar={
          <>
            <Select title="Namespace" value={namespace} onChange={(next) => onView({ namespace: next })}>
              <option value="">All namespaces</option>
              {/* The chosen namespace stays selectable after its last
                  problem clears, rather than silently resetting the
                  filter to everything. */}
              {[...new Set([...namespaces, ...(namespace ? [namespace] : [])])].sort().map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </Select>
            {loading && (
              <span className="text-2xs text-content-muted" role="status">
                Checking…
              </span>
            )}
          </>
        }
      />
    </Panel>
  );
}
