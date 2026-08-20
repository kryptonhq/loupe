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
  });

  it("offers nothing mid-download, where a second click would do nothing", () => {
    expect(
      updateAction({ status: "downloading", version: "1", percent: 10 }),
    ).toBeNull();
    expect(updateAction({ status: "idle" })).toBeNull();
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
