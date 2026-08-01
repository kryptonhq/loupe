import type { ReactNode } from "react";

// Small labelled pill. Used wherever a cell holds a set of values —
// node roles, labels, event reasons — because a comma-separated string
// reads as one blob and a chip reads as N things.
//
// Tones are tinted rather than solid: at this size a saturated fill
// fights the text next to it, and a 12% tint carries the same meaning
// without pulling the eye off the row.

const TONES = {
  neutral: "bg-content/[0.06] text-content-secondary",
  accent: "bg-accent/[0.12] text-accent",
  ok: "bg-success/[0.12] text-success",
  warn: "bg-warn/[0.14] text-warn",
  danger: "bg-danger/[0.12] text-danger",
  info: "bg-info/[0.12] text-info",
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
      className={`inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs font-medium ${TONES[tone]} ${mono ? "font-mono" : ""}`}
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
    return <span className="text-content-muted">—</span>;
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
      return "danger";
    default:
      return "neutral";
  }
}
