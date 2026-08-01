// Status indicator shared by pod phases and node readiness.
//
// Colour alone would fail for the ~8% of men with a colour-vision
// deficiency, so the dot always sits next to its label rather than
// replacing it.
const TONE = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
  unknown: "bg-slate-400",
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
      return "error";
    case "Succeeded":
      return "unknown";
    default:
      return "unknown";
  }
}

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[tone]}`} />
      {label}
    </span>
  );
}
