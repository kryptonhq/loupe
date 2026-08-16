import { useState } from "react";
import { useCluster } from "../lib/clusterContext";

// The dialog in front of anything destructive.
//
// One rule decides its shape: **the cluster matters more than the
// object**. Deleting the wrong pod in staging is a shrug; deleting the
// right-looking pod in production is an incident, and the difference
// between those two is a context name nobody was looking at. So the
// context is the thing the dialog leads with, and on a protected context
// it has to be typed back.

export interface ConfirmActionProps {
  /// What is about to happen, in the imperative: "Delete", "Drain".
  verb: string;
  /// What it happens to: "Pod api-7d9-xk2".
  subject: string;
  /// Anything the user should know before agreeing — what a drain will
  /// skip, what a delete cascades to.
  detail?: string;
  /// Set for actions that cannot be undone, which get firmer wording and
  /// a red button rather than an accent one.
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmAction({
  verb,
  subject,
  detail,
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: ConfirmActionProps) {
  const { context, guard } = useCluster();
  const [typed, setTyped] = useState("");

  const needsName = guard === "protected";
  const confirmed = !needsName || typed.trim() === context;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-label={`${verb} ${subject}`}
        className="glass-overlay w-full max-w-sm animate-slide-up p-4"
      >
        <h2 className="text-sm font-semibold">
          {verb} {subject}?
        </h2>
        <p className="mt-1 text-xs text-content-secondary">
          on <span className="font-medium text-content">{context ?? "this cluster"}</span>
        </p>

        {detail && (
          <p className="mt-2 text-2xs text-content-muted">{detail}</p>
        )}

        {children && <div className="mt-3">{children}</div>}

        {needsName && (
          <div className="mt-3 rounded-sm border border-warn/20 bg-warn/[0.06] p-2">
            <label className="block text-2xs text-content-secondary">
              {/* Deliberately not a checkbox: a checkbox can be ticked by
                  reflex, and reflex is the failure being guarded against. */}
              This context is protected. Type{" "}
              <span className="font-mono font-medium text-content">{context}</span>{" "}
              to confirm.
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type the context name to confirm"
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 w-full rounded-sm border bg-content/[0.03] px-2 py-1 font-mono text-xs outline-none focus:border-accent/40"
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-sm border border-danger/20 bg-danger/[0.08] px-2 py-1.5 text-2xs text-danger"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-1.5">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm border px-2.5 py-1 text-2xs text-content-secondary transition-colors hover:bg-content/[0.06] hover:text-content disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !confirmed}
            className={`rounded-sm px-2.5 py-1 text-2xs font-medium transition-colors disabled:opacity-40 ${
              destructive
                ? "bg-danger/[0.18] text-danger hover:bg-danger/[0.26]"
                : "bg-accent/[0.18] text-accent hover:bg-accent/[0.26]"
            }`}
          >
            {busy ? "Working…" : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
