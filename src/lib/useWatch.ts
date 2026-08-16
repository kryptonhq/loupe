import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Channel, api, errorMessage, type GvkRef, type WatchEvent } from "./api";

// Keeping a listing fresh without asking for it again on a timer.
//
// Every view used to refetch every ten seconds whether or not anything
// had changed. On a cluster with 8,000 pods that was a full LIST every
// ten seconds, per open view, forever — to discover that two rows moved.
//
// A watch inverts that: nothing is fetched until something actually
// changes. The saving is not marginal. An idle cluster costs one open
// connection instead of a request every ten seconds, and a busy one
// costs the same, because changes are coalesced.

/// How long changes are collected before the listing is refetched.
///
/// A rollout produces dozens of events in a second, and refetching per
/// event would be worse than the polling this replaces. Short enough to
/// read as live; long enough that a burst is one request.
const COALESCE_MS = 400;

export interface WatchState {
  /// False once the watch has failed and stopped following the cluster.
  /// A view that has quietly stopped updating is worse than one that
  /// says it has, so the caller is expected to show this.
  live: boolean;
  error: string | null;
}

/// Refetches `queryKey` whenever the watched kind changes.
///
/// The event says *that* something changed, not what the new row is —
/// listings are printed by the API server, and a watch delivers objects
/// rather than printed rows. Refetching the affected listing is one
/// request when something happened, rather than one every ten seconds
/// regardless.
export function useWatch(
  resource: GvkRef,
  namespace: string | null,
  queryKey: QueryKey,
  enabled = true,
): WatchState {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in refs so the effect does not restart when they change — a
  // restarting watch is a dropped connection and a fresh LIST.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = useRef(queryKey);
  key.current = queryKey;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let id: number | null = null;
    setError(null);

    const refetchSoon = () => {
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!cancelled) {
          void queryClient.invalidateQueries({ queryKey: key.current });
        }
      }, COALESCE_MS);
    };

    const channel = new Channel<WatchEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "changed":
          refetchSoon();
          break;
        case "reset":
          // Everything cached is suspect after a relist, so this is a
          // refetch rather than a patch — but it is still only one.
          refetchSoon();
          break;
        case "failed":
          setLive(false);
          setError(event.message);
          break;
      }
    };

    api
      .startWatch(resource, namespace, channel)
      .then((started) => {
        if (cancelled) {
          // The view unmounted while the watch was starting; stop it
          // rather than leaving a connection open to the cluster.
          void api.stopWatch(started);
          return;
        }
        id = started;
        setLive(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Not fatal to the view: the listing still works, it just will
        // not update by itself. Saying so is the whole point.
        setLive(false);
        setError(errorMessage(e));
      });

    return () => {
      cancelled = true;
      setLive(false);
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (id !== null) void api.stopWatch(id);
    };
    // Deliberately keyed on the identity of the kind rather than on the
    // object: a new `resource` literal on every render would restart the
    // watch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.group, resource.version, resource.kind, namespace, enabled, queryClient]);

  return { live, error };
}
