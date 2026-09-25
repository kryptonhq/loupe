import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Checking for, and installing, a new version of Loupe.
//
// The updater is the one path in the app that downloads code and runs
// it, so it is worth saying what makes that safe: an artifact is
// installed only if it verifies against the public key compiled into
// the binary. A compromised release host cannot ship anything the
// private key did not sign.
//
// The check on launch is quiet on failure. A machine that is offline, on
// a captive portal, or behind a proxy that dislikes GitHub is the normal
// case, not an error worth a dialog — the app works perfectly well on
// the version already installed. What the user asks for is different:
// a check from the menu, or an install, answers either way, because
// someone is waiting for it and silence reads as "nothing happened".

/// The event the app menu's "Check for Updates…" emits. A contract with
/// `CHECK_UPDATES_EVENT` in menu.rs.
export const CHECK_UPDATES_EVENT = "menu:check-updates";

/// What the updater is doing, as far as the status bar is concerned.
export type UpdateState =
  | { status: "idle" }
  /// A check the user asked for is in flight.
  | { status: "checking" }
  /// A check the user asked for found nothing newer. Cleared after a
  /// moment by the caller — it answers the question, then gets out of
  /// the way.
  | { status: "current" }
  /// A check the user asked for could not be made.
  | { status: "unreachable"; message: string }
  | { status: "available"; version: string; notes: string | null }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "ready"; version: string }
  | { status: "failed"; version: string; message: string };

/// How far a download has got, or null when the server did not say how
/// big it was — some do not, and a progress bar that invents a number is
/// worse than one that admits it cannot say.
export function percentOf(downloaded: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}

/// What the status bar says, or null when there is nothing to say.
export function updateSummary(state: UpdateState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Loupe is up to date";
    case "unreachable":
      return "Could not check for updates";
    case "available":
      return `Update to ${state.version}`;
    case "downloading":
      return state.percent === null
        ? `Downloading ${state.version}…`
        : `Downloading ${state.version} — ${state.percent}%`;
    case "ready":
      return `Restart to finish ${state.version}`;
    case "failed":
      return `Update to ${state.version} failed`;
  }
}

/// Whether clicking the segment does anything, and what.
export function updateAction(
  state: UpdateState,
): "install" | "restart" | "retry" | "recheck" | null {
  switch (state.status) {
    case "unreachable":
      return "recheck";
    case "available":
      return "install";
    case "ready":
      return "restart";
    case "failed":
      return "retry";
    default:
      // Mid-download there is nothing useful a second click could do.
      return null;
  }
}

/// The parts of a pending update this app cares about, plus the handle
/// needed to install it.
export interface PendingUpdate {
  version: string;
  notes: string | null;
  download: (
    onProgress: (downloaded: number, total: number | null) => void,
  ) => Promise<void>;
}

/// What asking produced. Distinguishes "nothing newer" from "could not
/// ask", which the launch check folds together and a check the user
/// asked for must not.
export type CheckResult =
  | { kind: "available"; update: PendingUpdate }
  | { kind: "current" }
  | { kind: "failed"; message: string };

/// Look for a new version, and say what happened.
export async function checkNow(): Promise<CheckResult> {
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  // A version is the one thing an update has to have. Checked rather
  // than assumed because this crosses a boundary the app does not
  // control — a malformed manifest, or a stubbed bridge that answers
  // every command with an empty object, otherwise reaches the status
  // bar as "Update to undefined".
  if (!update || typeof update.version !== "string" || !update.version) {
    return { kind: "current" };
  }
  const found = update;

  return {
    kind: "available",
    update: {
      version: found.version,
      notes: found.body ?? null,
      download: async (onProgress) => {
        let downloaded = 0;
        let total: number | null = null;
        await found.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            onProgress(0, total);
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            onProgress(downloaded, total);
          }
        });
      },
    },
  };
}

/// Look for a new version. Resolves to null when there is none, when the
/// bridge is absent, and when the check simply could not be made — the
/// quiet form, for the check nobody asked for.
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  const result = await checkNow();
  return result.kind === "available" ? result.update : null;
}

/// Restart into the version just installed.
export async function restart(): Promise<void> {
  await relaunch();
}
