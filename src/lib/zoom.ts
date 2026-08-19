// Interface zoom.
//
// An accessibility control, not a convenience: 13px is the size this app
// is drawn at, and for a good number of people that is simply too small
// to read for an hour at a time. The alternative is the OS-wide display
// scale, which means resizing every other window to fix one.
//
// Implemented as CSS `zoom` on the root element rather than by scaling
// the root font size. Font scaling only reaches what is expressed in
// rem, which leaves out exactly the panes worth enlarging — the log
// viewer and the terminal draw at a fixed pixel size, and xterm measures
// its own glyphs. `zoom` scales the layout itself, so everything goes
// together and nothing has to opt in.

/// The steps the app moves through, rather than a free-running
/// percentage: every stop is a size the layout has been looked at in,
/// and a stepped control is one you can hold a key on without landing
/// somewhere absurd.
export const ZOOM_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM = 1;

/// The event the native menu emits, and what it can carry. A contract
/// with `src-tauri/src/menu.rs`, so both ends name the same strings.
export const ZOOM_EVENT = "menu:zoom";
export const ZOOM_IN = "zoom-in";
export const ZOOM_OUT = "zoom-out";
export const ZOOM_RESET = "zoom-reset";

const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/// The nearest step to a level, for a settings file that has been edited
/// by hand or written by an older build. Anything unreadable comes back
/// as 100%: a preference that cannot be parsed is not a reason to render
/// the app at four times its size.
export function clampZoom(level: unknown): number {
  const value = typeof level === "number" ? level : Number(level);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ZOOM;
  if (value <= MIN) return MIN;
  if (value >= MAX) return MAX;

  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

function step(level: number, direction: 1 | -1): number {
  const current = clampZoom(level);
  const i = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number]);
  // At either end this returns the same level, so the caller can call it
  // repeatedly without checking and nothing moves.
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))];
}

export function zoomIn(level: number): number {
  return step(level, 1);
}

export function zoomOut(level: number): number {
  return step(level, -1);
}

export function canZoomIn(level: number): boolean {
  return clampZoom(level) < MAX;
}

export function canZoomOut(level: number): boolean {
  return clampZoom(level) > MIN;
}

/// How a level reads to a person.
export function zoomLabel(level: number): string {
  return `${Math.round(clampZoom(level) * 100)}%`;
}

/// Paint it. Removed rather than set to 1 at the default, so the ordinary
/// case leaves no trace in the DOM and nothing to explain later.
export function applyZoom(level: number): void {
  const root = document.documentElement;
  const value = clampZoom(level);
  if (value === DEFAULT_ZOOM) {
    root.style.removeProperty("zoom");
  } else {
    root.style.setProperty("zoom", String(value));
  }
}
