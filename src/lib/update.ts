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
// Everything here is quiet on failure. A machine that is offline, on a
// captive portal, or behind a proxy that dislikes GitHub is the normal
// case, not an error worth a dialog — the app works perfectly well on
// the version already installed. Only a failure during an install the
// user asked for is worth showing, because they are waiting for it.

/// What the updater is doing, as far as the status bar is concerned.
export type UpdateState =
  | { status: "idle" }
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
): "install" | "restart" | "retry" | null {
  switch (state.status) {
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

/// Look for a new version. Resolves to null when there is none, when the
/// bridge is absent, and when the check simply could not be made.
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  try {
    const update = await check();
    // A version is the one thing an update has to have. Checked rather
    // than assumed because this crosses a boundary the app does not
    // control — a malformed manifest, or a stubbed bridge that answers
    // every command with an empty object, otherwise reaches the status
    // bar as "Update to undefined".
    if (!update || typeof update.version !== "string" || !update.version) {
      return null;
    }

    return {
      version: update.version,
      notes: update.body ?? null,
      download: async (onProgress) => {
        let downloaded = 0;
        let total: number | null = null;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            onProgress(0, total);
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            onProgress(downloaded, total);
          }
        });
      },
    };
  } catch {
    return null;
  }
}

/// Restart into the version just installed.
export async function restart(): Promise<void> {
  await relaunch();
}
