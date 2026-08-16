// Getting log output out of the window.
//
// A debugging tool that cannot hand you the evidence sends you back to
// the terminal at the last step — the step you most wanted it for. Once
// someone has found the stack trace they were looking for, the next
// thing they do is put it in a ticket, a thread, or a file.
//
// Everything here is pure so the part that matters can be tested: what
// the saved file *says about itself*. A log file that does not record
// which pod it came from, or that it was filtered, is worse than no file
// — it is evidence that quietly misleads whoever reads it later.

import type { FilterSpec } from "./logFilter";

export interface ExportContext {
  namespace: string;
  pod: string;
  container: string;
  filter: FilterSpec;
  /// Lines of context shown around each match, if any.
  context: number;
  /// Whether the lines carry the API server's timestamps. Recorded
  /// rather than assumed: the buffer holds what was streamed, and if
  /// timestamps were off there is no way to add them after the fact.
  timestamps: boolean;
  /// Lines evicted by the buffer cap before the export.
  dropped: number;
  /// Lines held at the time of export.
  retained: number;
  /// Lines actually written — fewer than retained when filtered.
  written: number;
  at: Date;
}

/// A filesystem-safe stamp, ordered so files sort chronologically.
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/// Replaces anything that would be awkward in a filename. Kubernetes
/// names are already restrictive, but a container name reaches this from
/// the cluster and is not worth trusting into a path.
///
/// Runs of dots collapse to one: separators are gone by then, so `..`
/// cannot traverse anything, but a filename containing it is confusing
/// enough to be worth not producing.
function safe(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".") || "unnamed";
}

/// What to call the file, if the user does not rename it.
export function exportName(ctx: ExportContext): string {
  return `${safe(ctx.pod)}-${safe(ctx.container)}-${stamp(ctx.at)}.log`;
}

/// Describes the filter in the terms the user set it, or null when
/// nothing was filtered and there is nothing to disclose.
function describeFilter(ctx: ExportContext): string | null {
  const include = ctx.filter.include.trim();
  const exclude = ctx.filter.exclude.trim();
  if (!include && !exclude) return null;

  const mode = ctx.filter.regex ? "regex" : "text";
  const sense = ctx.filter.caseSensitive ? "case-sensitive" : "case-insensitive";
  const parts: string[] = [];
  if (include) parts.push(`matching ${mode} /${include}/`);
  if (exclude) parts.push(`excluding ${mode} /${exclude}/`);
  if (ctx.context > 0) parts.push(`with ${ctx.context} lines of context`);
  return `${parts.join(", ")} (${sense})`;
}

/// The comment block at the top of a saved file.
///
/// Every line is prefixed so the file still reads as a log, and so
/// anything that ingests it can drop the preamble on a single rule.
export function logHeader(ctx: ExportContext): string {
  const lines = [
    `# Loupe — pod logs`,
    `# pod:       ${ctx.namespace}/${ctx.pod}`,
    `# container: ${ctx.container}`,
    `# saved:     ${ctx.at.toISOString()}`,
  ];

  const filter = describeFilter(ctx);
  if (filter) {
    // Stated plainly, because a filtered log that does not say it is
    // filtered is the most misleading artefact this app can produce.
    lines.push(`# filter:    ${filter}`);
    lines.push(`# lines:     ${ctx.written} of ${ctx.retained} held`);
  } else {
    lines.push(`# lines:     ${ctx.written}`);
  }

  if (ctx.dropped > 0) {
    lines.push(
      `# NOTE: ${ctx.dropped} earlier line(s) were dropped by the viewer's buffer cap.`,
    );
  }
  if (!ctx.timestamps) {
    // Better to say so than to hand over a file whose lines cannot be
    // placed in time and let the reader assume the pod emitted none.
    lines.push(`# NOTE: streamed without timestamps, so lines carry none.`);
  }

  return lines.join("\n");
}

/// The full file: header, blank line, then the lines as streamed.
export function exportBody(ctx: ExportContext, lines: string[]): string {
  return `${logHeader(ctx)}\n\n${lines.join("\n")}\n`;
}
