import { describe, expect, it } from "vitest";
import {
  applyZoom,
  canZoomIn,
  canZoomOut,
  clampZoom,
  DEFAULT_ZOOM,
  ZOOM_STEPS,
  zoomIn,
  zoomLabel,
  zoomOut,
} from "./zoom";

describe("clampZoom", () => {
  it("keeps a level that is already a step", () => {
    for (const step of ZOOM_STEPS) expect(clampZoom(step)).toBe(step);
  });

  it("snaps to the nearest step", () => {
    expect(clampZoom(1.2)).toBe(1.25);
    expect(clampZoom(0.95)).toBe(0.9);
  });

  it("holds the ends", () => {
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(0.1)).toBe(0.75);
  });

  it("falls back to 100% for anything unreadable", () => {
    // A settings file edited by hand, or written by a build that stored
    // something else here. Rendering the app at four times its size is
    // not the right answer to a value that cannot be parsed.
    expect(clampZoom(NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(undefined)).toBe(DEFAULT_ZOOM);
    expect(clampZoom("big")).toBe(DEFAULT_ZOOM);
    expect(clampZoom(0)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(-2)).toBe(DEFAULT_ZOOM);
  });
});

describe("stepping", () => {
  it("moves one step at a time", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
  });

  it("stops at the ends rather than running off", () => {
    // So a held key does nothing surprising once it arrives.
    expect(zoomIn(2)).toBe(2);
    expect(zoomOut(0.75)).toBe(0.75);
  });

  it("steps from a level that is not on a step", () => {
    expect(zoomIn(1.2)).toBe(1.5);
    expect(zoomOut(1.2)).toBe(1.1);
  });

  it("says when it has run out", () => {
    expect(canZoomIn(2)).toBe(false);
    expect(canZoomIn(1)).toBe(true);
    expect(canZoomOut(0.75)).toBe(false);
    expect(canZoomOut(1)).toBe(true);
  });

  it("walks the whole range in both directions", () => {
    let level: number = ZOOM_STEPS[0];
    for (let i = 0; i < 20; i++) level = zoomIn(level);
    expect(level).toBe(2);
    for (let i = 0; i < 20; i++) level = zoomOut(level);
    expect(level).toBe(0.75);
  });
});

describe("zoomLabel", () => {
  it("reads as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(0.75)).toBe("75%");
  });
});

describe("applyZoom", () => {
  it("scales the root", () => {
    applyZoom(1.5);
    expect(document.documentElement.style.zoom).toBe("1.5");
  });

  it("leaves no trace at the default", () => {
    applyZoom(1.5);
    applyZoom(1);
    expect(document.documentElement.style.zoom).toBe("");
  });

  it("refuses to paint something unreadable", () => {
    applyZoom(1);
    applyZoom(NaN);
    expect(document.documentElement.style.zoom).toBe("");
  });
});
