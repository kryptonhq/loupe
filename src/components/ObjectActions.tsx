import { useState } from "react";
import { ConfirmAction } from "./ConfirmAction";
import { useCluster } from "../lib/clusterContext";
import { api, errorMessage, type GvkRef } from "../lib/api";

// The verbs, on an object's detail view.
//
// Two rules. Every destructive action confirms, naming the cluster
// before the object. And an action the user's RBAC does not allow is
// *absent*, not merely failing — discovery already tells us the verbs
// the API server will accept, so offering a button that is guaranteed to
// be refused is a choice, and the wrong one.

/// Kinds with a scale subresource worth offering. A short list rather
/// than a guess: offering Scale on something that cannot scale produces
/// a 404 the user cannot act on.
const SCALABLE = new Set(["Deployment", "StatefulSet", "ReplicaSet"]);

/// Kinds where `kubectl rollout restart` means something — the ones with
/// a pod template a controller will act on.
const RESTARTABLE = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

type Pending =
  | { kind: "scale"; replicas: number }
  | { kind: "restart" }
  | { kind: "delete" }
  | null;

export function ObjectActions({
  resource,
  namespace,
  name,
  /// Verbs the API server reports for this kind, from discovery. An
  /// empty list means we have not been told, in which case the actions
  /// are offered and the server is left to refuse — better than hiding
  /// them because discovery was slow.
  verbs,
  onDone,
}: {
  resource: GvkRef;
  namespace: string | null;
  name: string;
  verbs?: string[];
  onDone: () => void;
}) {
  const { guard } = useCluster();
  const [pending, setPending] = useState<Pending>(null);
  const [replicas, setReplicas] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A read-only context offers no verbs at all. The backend would refuse
  // them anyway; a menu full of buttons that always fail is worse than
  // an absent menu.
  if (guard === "readOnly") return null;

  const allows = (verb: string) => !verbs?.length || verbs.includes(verb);
  const canScale = SCALABLE.has(resource.kind) && allows("patch");
  const canRestart = RESTARTABLE.has(resource.kind) && allows("patch");
  const canDelete = allows("delete");

  if (!canScale && !canRestart && !canDelete) return null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPending(null);
      onDone();
    } catch (e) {
      // Reported in the dialog rather than closing it: the API server's
      // wording is the whole answer, especially for an RBAC denial.
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="flex items-center gap-1.5">
        {canScale && (
          <ActionButton onClick={() => setPending({ kind: "scale", replicas: 1 })}>
            Scale…
          </ActionButton>
        )}
        {canRestart && (
          <ActionButton onClick={() => setPending({ kind: "restart" })}>
            Restart
          </ActionButton>
        )}
        {canDelete && (
          <ActionButton danger onClick={() => setPending({ kind: "delete" })}>
            Delete…
          </ActionButton>
        )}
      </span>

      {pending?.kind === "scale" && (
        <ConfirmAction
          verb="Scale"
          subject={`${resource.kind} ${name}`}
          busy={busy}
          error={error}
          onCancel={() => setPending(null)}
          onConfirm={() =>
            run(() =>
              api.scaleObject(resource, namespace, name, Number(replicas)),
            )
          }
        >
          <label className="flex items-center gap-2 text-xs">
            Replicas
            <input
              type="number"
              min={0}
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              aria-label="Replicas"
              className="w-20 rounded-sm border bg-content/[0.03] px-2 py-1 text-xs outline-none focus:border-accent/40"
            />
          </label>
        </ConfirmAction>
      )}

      {pending?.kind === "restart" && (
        <ConfirmAction
          verb="Restart"
          subject={`${resource.kind} ${name}`}
          detail="Rolls the pods by touching the pod template, the same way kubectl rollout restart does."
          busy={busy}
          error={error}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api.rolloutRestart(resource, namespace, name))}
        />
      )}

      {pending?.kind === "delete" && (
        <ConfirmAction
          verb="Delete"
          subject={`${resource.kind} ${name}`}
          destructive
          detail="Deleted in the background, the way kubectl does. Anything this object owns goes with it."
          busy={busy}
          error={error}
          onCancel={() => setPending(null)}
          onConfirm={() => run(() => api.deleteObject(resource, namespace, name))}
        />
      )}
    </>
  );
}

function ActionButton({
  onClick,
  danger = false,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-sm border px-2 py-1 text-2xs transition-colors duration-150 ease-swift ${
        danger
          ? "border-danger/30 text-danger hover:bg-danger/[0.1]"
          : "text-content-secondary hover:bg-content/[0.06] hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}
