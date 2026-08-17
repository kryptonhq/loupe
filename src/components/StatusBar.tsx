import { Select } from "./Select";
import type { ClusterInfo, Guard } from "../lib/api";

// The line along the bottom of the window.
//
// What it holds is the answer to "what am I connected to, and what will
// it let me do" — the two questions whose answer has to be true no
// matter how many panes deep you are. Previously they lived in the foot
// of the nav rail, which is navigation space, and which a reader has no
// reason to look at once they are reading an object.
//
// It spans the whole window rather than the main area, because it
// describes the session and not the tab.

const GUARD_LABEL: Record<Guard, string> = {
  open: "Writes allowed",
  protected: "Protected · writes confirm",
  readOnly: "Read-only",
};

const GUARD_TONE: Record<Guard, string> = {
  open: "text-content-secondary",
  protected: "text-warn font-medium",
  readOnly: "text-danger font-medium",
};

const GUARD_DOT: Record<Guard, string> = {
  open: "bg-success",
  protected: "bg-warn",
  readOnly: "bg-danger",
};

/// The bar takes the guard's colour, so a cluster you have marked reads
/// differently at a glance and in a screenshot.
const GUARD_WASH: Record<Guard, string> = {
  open: "",
  protected: "bg-warn/[0.08]",
  readOnly: "bg-danger/[0.08]",
};

const CELL = "flex shrink-0 items-center gap-2 border-r px-3 py-1";

interface StatusBarProps {
  cluster: ClusterInfo;
  guard: Guard;
  onGuardChange: (guard: Guard) => void;
  onSwitchCluster: () => void;
  onDisconnect: () => void;
}

export function StatusBar({
  cluster,
  guard,
  onGuardChange,
  onSwitchCluster,
  onDisconnect,
}: StatusBarProps) {
  return (
    <footer
      className={`flex shrink-0 items-stretch border-t text-2xs text-content-secondary ${GUARD_WASH[guard]}`}
    >
      <button
        onClick={onSwitchCluster}
        title={`${cluster.server}\nClick to switch cluster`}
        className={`${CELL} min-w-0 transition-colors duration-150 ease-swift hover:bg-content/[0.05]`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${GUARD_DOT[guard]}`} />
        <span className="truncate font-medium text-content">{cluster.context}</span>
        <span aria-hidden className="text-content-muted">
          ⇄
        </span>
      </button>

      <span className={`${CELL} ${GUARD_TONE[guard]}`}>{GUARD_LABEL[guard]}</span>

      <span className={CELL}>
        <span className="text-content-muted">Writes</span>
        <Select
          dense
          value={guard}
          onChange={(v) => onGuardChange(v as Guard)}
          title="What this context allows. Loupe's own safeguard, not RBAC — it does not change your permissions."
        >
          <option value="open">Allowed</option>
          <option value="protected">Confirm each</option>
          <option value="readOnly">Refused</option>
        </Select>
      </span>

      {/* Everything after this sits at the far end, where a status bar
          keeps the things you read rather than press. */}
      <span className="min-w-0 flex-1" />

      <span className={`${CELL} font-mono text-content-muted`}>{cluster.version}</span>

      <button
        onClick={onDisconnect}
        className="shrink-0 px-3 py-1 text-content-muted transition-colors duration-150 ease-swift hover:bg-content/[0.05] hover:text-content"
      >
        Disconnect
      </button>
    </footer>
  );
}
