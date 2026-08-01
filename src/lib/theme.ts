// Appearance: what the user asked for, and what that means right now.
//
// Two separate things, deliberately. `Theme` is the preference and is
// what gets persisted; `system` is a live fact about the OS. Storing the
// *resolved* value instead would freeze a user who chose "system" into
// whichever mode they happened to be in when they chose it.

export type Theme = "system" | "light" | "dark";

export const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/// Whether the given preference means dark, given what the OS says.
export function isDark(theme: Theme, systemPrefersDark: boolean): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return systemPrefersDark;
}

/// Anything unrecognised means "follow the system" — a settings file
/// written by a newer build, or edited by hand, should not leave the app
/// with no appearance at all.
export function parseTheme(value: unknown): Theme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/// Tailwind runs with darkMode:"class", so the class on <html> is what
/// actually switches the palette.
export function applyTheme(dark: boolean, root: HTMLElement = document.documentElement) {
  root.classList.toggle("dark", dark);
  // Tells the engine which built-in control colours to use — form
  // controls and scrollbars come from here, not from our stylesheet.
  root.style.colorScheme = dark ? "dark" : "light";
}
