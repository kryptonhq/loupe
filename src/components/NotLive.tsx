import type { WatchState } from "../lib/useWatch";

/// Said out loud when a listing's watch is not running: a listing that
/// has quietly stopped updating is worse than one that admits it.
export function NotLive({ watch }: { watch: WatchState }) {
  if (!watch.error) return null;
  return (
    <span
      className="shrink-0 text-2xs text-warn"
      title={`${watch.error} — the listing still works, but will not update by itself`}
    >
      not live
    </span>
  );
}
