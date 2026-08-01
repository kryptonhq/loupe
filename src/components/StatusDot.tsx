// Status indicator shared by pod phases and node readiness.
//
// Colour alone would fail for the ~8% of men with a colour-vision
// deficiency, so the dot always sits next to its label rather than
// replacing it. Each dot carries a soft halo — at 6px a flat circle is
// easy to miss when scanning a long list, and the halo gives it presence
// without making it larger.

const TONE = {
  ok: "bg-success shadow-[0_0_0_3px_rgb(var(--success)/0.15)]",
  warn: "bg-warn shadow-[0_0_0_3px_rgb(var(--warn)/0.15)]",
  danger: "bg-danger shadow-[0_0_0_3px_rgb(var(--danger)/0.15)]",
  unknown: "bg-content-muted",
} as const;

export type Tone = keyof typeof TONE;

/// Maps a pod phase onto a tone. Succeeded is deliberately neutral, not
/// green: a completed Job pod is finished, not healthy.
export function phaseTone(phase: string): Tone {
  switch (phase) {
    case "Running":
      return "ok";
    case "Pending":
      return "warn";
    case "Failed":
      return "danger";
    case "Succeeded":
      return "unknown";
    default:
      return "unknown";
  }
}

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone]}`} />
      <span className="truncate">{label}</span>
    </span>
  );
}
