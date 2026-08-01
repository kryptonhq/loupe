import { describe, expect, it } from "vitest";
import { applyTheme, isDark, parseTheme } from "./theme";

// The preference and the resolved appearance are separate on purpose.
// Storing the resolved value would freeze a user who chose "system" into
// whichever mode they happened to be in at the time.

describe("isDark", () => {
  it("honours an explicit choice whatever the OS says", () => {
    expect(isDark("dark", false)).toBe(true);
    expect(isDark("light", true)).toBe(false);
  });

  it("follows the OS when the preference is system", () => {
    expect(isDark("system", true)).toBe(true);
    expect(isDark("system", false)).toBe(false);
  });
});

describe("parseTheme", () => {
  it("accepts the three it knows", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
  });

  it("falls back to system for anything else", () => {
    // A settings file from a newer build, hand-edited, or truncated.
    // Leaving the app with no appearance at all would be worse than
    // ignoring the value.
    expect(parseTheme("solarized")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme(42)).toBe("system");
  });
});

describe("applyTheme", () => {
  it("toggles the class Tailwind switches on", () => {
    const root = document.createElement("html");
    applyTheme(true, root);
    expect(root.classList.contains("dark")).toBe(true);
    applyTheme(false, root);
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("sets color-scheme so native controls match", () => {
    // Scrollbars and form controls come from the engine, not from our
    // stylesheet — without this they stay light on a dark window.
    const root = document.createElement("html");
    applyTheme(true, root);
    expect(root.style.colorScheme).toBe("dark");
    applyTheme(false, root);
    expect(root.style.colorScheme).toBe("light");
  });
});
