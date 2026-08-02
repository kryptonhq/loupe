import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import { dragRegionProps } from "./window";

// The window has no native title bar, so these handlers are the only
// thing making it movable. What is worth pinning is where dragging must
// *not* happen: a mousedown on a button has to press the button, and a
// right-click has to stay a right-click.

const startDragging = vi.fn();
const toggleMaximize = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging, toggleMaximize }),
}));

/// A mouse event carrying only what these handlers read.
function mouse(target: HTMLElement, button = 0) {
  return { button, target } as unknown as MouseEvent<HTMLElement>;
}

/// The handlers import Tauri lazily, so the call lands a microtask later.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function element(html: string): HTMLElement {
  document.body.innerHTML = `<header>${html}</header>`;
  return document.body.querySelector("header")!;
}

beforeEach(() => {
  startDragging.mockReset();
  toggleMaximize.mockReset();
});

describe("dragRegionProps", () => {
  it("drags the window from an empty part of the header", async () => {
    dragRegionProps.onMouseDown(mouse(element("<span>Pods</span>")));
    await settle();
    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("does not drag from a control inside the header", async () => {
    // The header holds Refresh, the namespace picker and the theme
    // switch. Picking the window up instead of pressing them would make
    // every one of them unusable.
    const header = element("<button>Refresh</button>");
    const button = header.querySelector("button")!;

    dragRegionProps.onMouseDown(mouse(button));
    await settle();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("does not drag from a control nested inside a control", async () => {
    // `closest` rather than a direct check, because the click lands on
    // whatever is innermost — the label inside the button.
    const header = element("<button><span>Refresh</span></button>");
    const label = header.querySelector("span")!;

    dragRegionProps.onMouseDown(mouse(label));
    await settle();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("respects an explicit opt-out", async () => {
    const header = element('<div class="no-drag"><span>x</span></div>');
    dragRegionProps.onMouseDown(mouse(header.querySelector("span")!));
    await settle();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("ignores anything but the left button", async () => {
    // A right-click is a context menu, and a middle-click drag is not a
    // gesture anyone means.
    const header = element("<span>Pods</span>");
    dragRegionProps.onMouseDown(mouse(header, 2));
    dragRegionProps.onMouseDown(mouse(header, 1));
    await settle();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("zooms on a double-click of the title bar", async () => {
    // Muscle memory on macOS.
    dragRegionProps.onDoubleClick(mouse(element("<span>Pods</span>")));
    await settle();
    expect(toggleMaximize).toHaveBeenCalledOnce();
  });

  it("does not zoom on a double-click of a control", async () => {
    const header = element("<button>Refresh</button>");
    dragRegionProps.onDoubleClick(mouse(header.querySelector("button")!));
    await settle();
    expect(toggleMaximize).not.toHaveBeenCalled();
  });

  it("swallows a failure rather than taking the UI down", async () => {
    // In browser dev there is no Tauri window behind the bridge. Failing
    // to drag is a small bug; an unhandled rejection on every mousedown
    // in the header is a much larger one.
    startDragging.mockRejectedValue(new Error("no window"));
    dragRegionProps.onMouseDown(mouse(element("<span>Pods</span>")));
    await settle();
    expect(startDragging).toHaveBeenCalledOnce();
  });
});
