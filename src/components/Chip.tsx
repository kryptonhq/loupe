import type { ReactNode } from "react";

// Small labelled pill. Used wherever a cell holds a set of values —
// node roles, labels, event reasons — because a comma-separated string
// reads as one blob and a chip reads as N things.

const TONES = {
  neutral:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  accent: "bg-accent/10 text-accent dark:bg-accent/20 dark:text-indigo-300",
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
} as const;

export type ChipTone = keyof typeof TONES;

export function Chip({
  children,
  tone = "neutral",
  mono,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${TONES[tone]} ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}

/// Renders a list of values as chips, with an em dash when empty so the
/// cell never looks like a rendering failure.
export function ChipList({
  values,
  tone = "neutral",
  mono,
}: {
  values: string[];
  tone?: ChipTone;
  mono?: boolean;
}) {
  if (values.length === 0) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <Chip key={v} tone={tone} mono={mono}>
          {v}
        </Chip>
      ))}
    </span>
  );
}

/// Kubernetes event types are a closed set; anything unexpected stays
/// neutral rather than being coloured green by accident.
export function eventTone(type: string): ChipTone {
  switch (type) {
    case "Normal":
      return "ok";
    case "Warning":
      return "warn";
    case "Error":
      return "error";
    default:
      return "neutral";
  }
}
