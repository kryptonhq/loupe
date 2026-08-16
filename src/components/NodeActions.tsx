import { useState } from "react";
import { ConfirmAction } from "./ConfirmAction";
import { useCluster } from "../lib/clusterContext";
import { Channel, api, errorMessage, type DrainEvent } from "../lib/api";

// Cordon, uncordon and drain.
//
// Drain is the one action here that is not a single request: it is a
// sequence of independent evictions, several of which are expected to be
// skipped and any of which a PodDisruptionBudget may refuse. Reporting
// it as one spinner would hide exactly the information that matters —
// which pod would not move, and why.

export function NodeActions({
  node,
  schedulable,
  onDone,
}: {
  node: string;
  schedulable: boolean;
  onDone: () => void;
}) {
  const { guard } = useCluster();
  const [pending, setPending] = useState<"cordon" | "drain" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string[]>([]);

  if (guard === "readOnly") return null;

  async function toggleCordon() {
    setBusy(true);
    setError(null);
    try {
      await api.setNodeSchedulable(node, !schedulable);
      setPending(null);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function drain() {
    setBusy(true);
    setError(null);
    setProgress([]);

    const channel = new Channel<DrainEvent>();
    channel.onmessage = (event) => {
      setProgress((lines) => [...lines, describe(event)]);
    };

    try {
      await api.drainNode(node, channel);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="flex items-center gap-1.5">
        <button
          onClick={() => setPending("cordon")}
          className="shrink-0 rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors duration-150 ease-swift hover:bg-content/[0.06] hover:text-content"
        >
          {schedulable ? "Cordon" : "Uncordon"}
        </button>
        <button
          onClick={() => setPending("drain")}
          className="shrink-0 rounded-sm border border-danger/30 px-2 py-1 text-2xs text-danger transition-colors duration-150 ease-swift hover:bg-danger/[0.1]"
        >
          Drain…
        </button>
      </span>

      {pending === "cordon" && (
        <ConfirmAction
          verb={schedulable ? "Cordon" : "Uncordon"}
          subject={`node ${node}`}
          detail={
            schedulable
              ? "Stops new pods being scheduled here. Pods already running are left alone."
              : "Allows pods to be scheduled here again."
          }
          busy={busy}
          error={error}
          onCancel={() => setPending(null)}
          onConfirm={toggleCordon}
        />
      )}

      {pending === "drain" && (
        <ConfirmAction
          verb="Drain"
          subject={`node ${node}`}
          destructive
          detail="Evicts the pods on this node, honouring PodDisruptionBudgets. DaemonSet and static pods are left where they are. This does not cordon the node."
          busy={busy}
          error={error}
          onCancel={() => {
            setPending(null);
            setProgress([]);
          }}
          onConfirm={drain}
        >
          {progress.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-sm border bg-content/[0.03] p-2 font-mono text-2xs">
              {progress.map((line, i) => (
                <p key={i} className="truncate text-content-secondary">
                  {line}
                </p>
              ))}
            </div>
          )}
        </ConfirmAction>
      )}
    </>
  );
}

/// One line of drain progress, in the terms the user cares about.
export function describe(event: DrainEvent): string {
  switch (event.kind) {
    case "started":
      return `${event.pods} pod${event.pods === 1 ? "" : "s"} on this node`;
    case "evicted":
      return `evicted ${event.pod}`;
    case "skipped":
      return `skipped ${event.pod} — ${event.reason}`;
    case "failed":
      // Usually a PodDisruptionBudget refusing, which is the system
      // working. The server's wording says which one.
      return `could not evict ${event.pod} — ${event.message}`;
    case "finished":
      return `done: ${event.evicted} evicted, ${event.skipped} skipped, ${event.failed} failed`;
  }
}
