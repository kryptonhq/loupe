// Window dragging for a title bar that is entirely HTML.
//
// The window has no native title bar (`titleBarStyle: Overlay`), so the
// only thing there is to grab is our own markup. `-webkit-app-region:
// drag` alone did not deliver that — the built app could not be moved by
// its headers. The likely culprit is that every header here carries a
// `backdrop-filter` and so gets its own compositing layer, which is
// known to interfere with app-region hit testing, but the fix does not
// rest on that being the reason.
//
// Asking the window to drag itself goes through Tauri rather than the
// webview's hit testing, so it works whatever the cause. The CSS stays
// as the fast path where the platform does honour it, and for the
// cursor; this is what makes the gesture reliable where it does not.

import type { MouseEvent } from "react";

/// Elements that must keep their own click behaviour. A mousedown on a
/// button has to press the button, not pick the window up.
const INTERACTIVE = "button, input, select, textarea, a, [role='button'], .no-drag";

async function currentWindow() {
  // Imported lazily and defensively: in browser dev there is no Tauri
  // window behind the bridge, and a failure to drag must never take the
  // UI down with it.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/// Props for any element that should behave like a title bar.
///
/// Spread onto the header alongside the `drag-region` class, which is
/// what keeps the cursor and the platform's own hit-testing correct.
export const dragRegionProps = {
  onMouseDown: (e: MouseEvent<HTMLElement>) => {
    // Left button only: a right-click is a context menu, and a
    // middle-click drag is not a gesture anyone means.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;

    void currentWindow()
      .then((w) => w.startDragging())
      .catch(() => {});
  },

  onDoubleClick: (e: MouseEvent<HTMLElement>) => {
    // Double-clicking the title bar zooms the window on macOS, and the
    // gesture is muscle memory. Losing it is a smaller bug than not
    // being able to drag at all, but it is the same bug.
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;

    void currentWindow()
      .then((w) => w.toggleMaximize())
      .catch(() => {});
  },
};
