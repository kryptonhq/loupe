import { useEffect, useState } from "react";
import { Channel, api, errorMessage, type ProblemsSnapshot } from "./api";

// One subscription to the Problems monitor for the whole window.
//
// Held at the top of the app rather than in the Problems page, because
// the status bar counts problems whether or not the view is open — and
// two subscriptions would be two sets of cluster-wide watches for the
// same answer.

export interface ProblemsState {
  snapshot: ProblemsSnapshot | null;
  /// When the latest snapshot arrived, by this clock. What lets an age
  /// keep ticking between snapshots.
  receivedAt: number;
  error: string | null;
}

/// Subscribes while `context` is set, and restarts when it changes: a
/// snapshot of one cluster must never be shown under another's name.
export function useProblems(context: string | null): ProblemsState {
  const [state, setState] = useState<ProblemsState>({
    snapshot: null,
    receivedAt: 0,
    error: null,
  });

  useEffect(() => {
    setState({ snapshot: null, receivedAt: 0, error: null });
    if (!context) return;

    let cancelled = false;
    let id: number | null = null;

    const channel = new Channel<ProblemsSnapshot>();
    channel.onmessage = (snapshot) => {
      if (cancelled) return;
      setState({ snapshot, receivedAt: Date.now(), error: null });
    };

    api
      .startProblems(channel)
      .then((started) => {
        if (cancelled) {
          void api.stopProblems(started);
          return;
        }
        id = started;
      })
      .catch((e) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e) }));
      });

    return () => {
      cancelled = true;
      if (id !== null) void api.stopProblems(id).catch(() => {});
    };
  }, [context]);

  return state;
}
