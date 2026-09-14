import type { Problem, ProblemsSnapshot, Severity } from "./api";
import { routeForObject, type Route } from "./routes";

// What the Problems view does with a snapshot, as pure functions.
//
// The judgement — what is broken — is made in Rust (`cluster::problems`).
// What is left here is presentation: where a row leads, how old it is
// right now, which rows a namespace filter keeps, and what the status bar
// counts.

/// Worst first, as a number a sort can use.
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/// Where opening a row goes. Pods and nodes have views of their own;
/// everything else, custom resources included, opens the generic detail.
/// Null for a row with nothing to open.
export function routeForProblem(problem: Problem): Route | null {
  return problem.target ? routeForObject(problem.target) : null;
}

/// Seconds a problem has lasted, measured on the Rust side's clock.
///
/// `generatedAt` is when the snapshot was taken there; `elapsed` is how
/// long ago that was here. Measuring this way means a difference between
/// the webview's clock and the core's cannot make a row read as starting
/// in the future.
export function problemAge(
  problem: Problem,
  generatedAt: number,
  elapsedSinceSnapshot = 0,
): number | null {
  if (problem.since == null) return null;
  return Math.max(0, generatedAt - problem.since + elapsedSinceSnapshot);
}

/// The shorthand every age column in the app uses.
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/// Rows a namespace filter keeps.
///
/// Cluster-scoped rows — nodes, and the "not permitted" stand-ins — stay
/// visible under any filter: a node that is not ready is a problem for
/// every namespace, and hiding it because you narrowed to one would be
/// exactly the "nothing wrong here" answer the view exists to avoid.
export function inNamespace(problems: Problem[], namespace: string): Problem[] {
  if (!namespace) return problems;
  return problems.filter(
    (p) => p.target == null || p.target.namespace == null || p.target.namespace === namespace,
  );
}

/// What the status bar counts: things that are actually wrong.
///
/// Info rows — warning events and the categories Loupe could not check —
/// are on the view but not in the badge. A badge that is never zero on a
/// busy cluster, because some event somewhere always says "Warning", is a
/// badge people learn to ignore.
export function badgeCount(snapshot: ProblemsSnapshot | null): {
  critical: number;
  warning: number;
} {
  const out = { critical: 0, warning: 0 };
  for (const p of snapshot?.problems ?? []) {
    if (p.severity === "critical") out.critical += 1;
    else if (p.severity === "warning") out.warning += 1;
  }
  return out;
}

/// Whether every source has answered one way or another. Until then an
/// empty view means "still looking", not "nothing is wrong".
export function settled(snapshot: ProblemsSnapshot | null): boolean {
  return snapshot != null && snapshot.sources.every((s) => s.state !== "loading");
}

/// The namespaces rows are in, for the filter.
export function namespacesOf(problems: Problem[]): string[] {
  const seen = new Set<string>();
  for (const p of problems) if (p.target?.namespace) seen.add(p.target.namespace);
  return [...seen].sort();
}
