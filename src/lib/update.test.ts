import { beforeEach, describe, expect, it, vi } from "vitest";
import { percentOf, updateAction, updateSummary, type UpdateState } from "./update";

beforeEach(() => {
  vi.resetModules();
});

describe("percentOf", () => {
  it("reports progress against a known size", () => {
    expect(percentOf(0, 200)).toBe(0);
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(200, 200)).toBe(100);
  });

  it("admits it cannot say when the server did not give a size", () => {
    // A progress bar that invents a number is worse than one that says
    // it does not know.
    expect(percentOf(50, null)).toBeNull();
    expect(percentOf(50, 0)).toBeNull();
    expect(percentOf(50, NaN)).toBeNull();
  });

  it("never leaves the range, whatever the server claims", () => {
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-5, 200)).toBe(0);
  });
});

describe("updateSummary", () => {
  const cases: [UpdateState, string | null][] = [
    [{ status: "idle" }, null],
    [{ status: "checking" }, "Checking for updates…"],
    [{ status: "current" }, "Loupe is up to date"],
    [{ status: "unreachable", message: "offline" }, "Could not check for updates"],
    [{ status: "available", version: "0.1.6", notes: null }, "Update to 0.1.6"],
    [
      { status: "downloading", version: "0.1.6", percent: 40 },
      "Downloading 0.1.6 — 40%",
    ],
    [
      { status: "downloading", version: "0.1.6", percent: null },
      "Downloading 0.1.6…",
    ],
    [{ status: "ready", version: "0.1.6" }, "Restart to finish 0.1.6"],
    [
      { status: "failed", version: "0.1.6", message: "boom" },
      "Update to 0.1.6 failed",
    ],
  ];

  for (const [state, expected] of cases) {
    it(`reads "${expected ?? "(nothing)"}" when ${state.status}`, () => {
      expect(updateSummary(state)).toBe(expected);
    });
  }

  it("says nothing at all when there is no update", () => {
    // The common case by far, and it should cost no pixels.
    expect(updateSummary({ status: "idle" })).toBeNull();
  });
});

describe("updateAction", () => {
  it("offers the step that makes sense", () => {
    expect(updateAction({ status: "available", version: "1", notes: null })).toBe(
      "install",
    );
    expect(updateAction({ status: "ready", version: "1" })).toBe("restart");
    expect(updateAction({ status: "failed", version: "1", message: "x" })).toBe(
      "retry",
    );
    // A check that could not be made is asked again, not installed.
    expect(updateAction({ status: "unreachable", message: "x" })).toBe("recheck");
  });

  it("offers nothing mid-download, where a second click would do nothing", () => {
    expect(
      updateAction({ status: "downloading", version: "1", percent: 10 }),
    ).toBeNull();
    expect(updateAction({ status: "idle" })).toBeNull();
    expect(updateAction({ status: "checking" })).toBeNull();
    expect(updateAction({ status: "current" })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("refuses an answer with no version in it", async () => {
    // The bridge is not something this app controls. A malformed
    // manifest — or a stub that answers every command with an empty
    // object — otherwise reaches the status bar as "Update to
    // undefined", which is worse than saying nothing.
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockResolvedValue({}),
    }));
    const { checkForUpdate } = await import("./update");
    expect(await checkForUpdate()).toBeNull();
  });

  it("stays quiet when the check itself fails", async () => {
    // Offline, captive portal, or a proxy that dislikes GitHub. The app
    // works fine on the version already installed.
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockRejectedValue(new Error("network unreachable")),
    }));
    const { checkForUpdate } = await import("./update");
    expect(await checkForUpdate()).toBeNull();
  });

  it("reports a well-formed update", async () => {
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockResolvedValue({
        version: "0.1.6",
        body: "Sortable columns.",
        downloadAndInstall: vi.fn(),
      }),
    }));
    const { checkForUpdate } = await import("./update");
    const found = await checkForUpdate();
    expect(found?.version).toBe("0.1.6");
    expect(found?.notes).toBe("Sortable columns.");
  });
});

// The check the user asked for, from the menu or the context picker.
// Unlike the one on launch it has to tell "nothing newer" apart from
// "could not ask" — both are silence in the quiet form.
describe("checkNow", () => {
  it("says up to date when there is nothing newer", async () => {
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockResolvedValue(null),
    }));
    const { checkNow } = await import("./update");
    expect(await checkNow()).toEqual({ kind: "current" });
  });

  it("says why when the check could not be made", async () => {
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockRejectedValue(new Error("network unreachable")),
    }));
    const { checkNow } = await import("./update");
    expect(await checkNow()).toEqual({ kind: "failed", message: "network unreachable" });
  });

  it("keeps a rejection that is not an Error legible", async () => {
    // The Tauri bridge rejects with plain strings.
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockRejectedValue("Could not fetch a valid release JSON"),
    }));
    const { checkNow } = await import("./update");
    expect(await checkNow()).toEqual({
      kind: "failed",
      message: "Could not fetch a valid release JSON",
    });
  });

  it("hands back an update that downloads with progress", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 200 } });
      onEvent({ event: "Progress", data: { chunkLength: 50 } });
      onEvent({ event: "Progress", data: { chunkLength: 150 } });
      onEvent({ event: "Finished" });
    });
    vi.doMock("@tauri-apps/plugin-updater", () => ({
      check: vi.fn().mockResolvedValue({ version: "0.1.7", body: null, downloadAndInstall }),
    }));
    const { checkNow } = await import("./update");
    const result = await checkNow();
    if (result.kind !== "available") throw new Error(`expected an update, got ${result.kind}`);
    expect(result.update.version).toBe("0.1.7");
    expect(result.update.notes).toBeNull();

    const progress: [number, number | null][] = [];
    await result.update.download((done, total) => progress.push([done, total]));
    expect(progress).toEqual([
      [0, 200],
      [50, 200],
      [200, 200],
    ]);
  });
});
