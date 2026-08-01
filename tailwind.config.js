/** @type {import('tailwindcss').Config} */
// Every colour here resolves to a CSS variable from src/styles/tokens.css.
// Components name roles, not palette entries — `bg-surface-2`, never
// `bg-slate-900` — so the two themes stay in step and a token change
// lands everywhere at once.
//
// The `<alpha-value>` placeholder is what makes `bg-surface-2/60` work;
// it only functions because the tokens are space-separated RGB channels.
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base: withAlpha("--base"),
        surface: {
          1: withAlpha("--surface-1"),
          2: withAlpha("--surface-2"),
          3: withAlpha("--surface-3"),
        },
        hairline: withAlpha("--border"),
        content: {
          DEFAULT: withAlpha("--text"),
          secondary: withAlpha("--text-secondary"),
          muted: withAlpha("--text-muted"),
        },
        accent: {
          DEFAULT: withAlpha("--accent"),
          fg: withAlpha("--accent-fg"),
        },
        success: withAlpha("--success"),
        warn: withAlpha("--warn"),
        danger: withAlpha("--danger"),
        info: withAlpha("--info"),
      },
      borderColor: {
        DEFAULT: "rgb(var(--border) / var(--border-alpha))",
        strong: "rgb(var(--border) / var(--border-strong-alpha))",
      },
      fontFamily: {
        sans: [
          "Inter var",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        // A deliberately tight scale. Dense operator UIs go wrong when
        // there are six text sizes; these are the four that earn a place.
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.875rem", { lineHeight: "1.375rem" }],
      },
      borderRadius: {
        DEFAULT: "0.5rem",
        sm: "0.375rem",
        lg: "0.75rem",
        xl: "1rem",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      boxShadow: {
        // Elevation is two parts: a soft ambient shadow and a hairline
        // ring. The ring is what keeps a translucent panel legible when
        // it sits over a busy desktop.
        raised:
          "0 1px 2px rgb(var(--shadow-color) / 0.06), 0 4px 16px -4px rgb(var(--shadow-color) / 0.10)",
        overlay:
          "0 8px 32px -8px rgb(var(--shadow-color) / 0.24), 0 2px 8px -2px rgb(var(--shadow-color) / 0.12)",
        // The inner top highlight that sells a glass edge.
        glass:
          "inset 0 1px 0 0 rgb(255 255 255 / var(--glass-highlight)), 0 8px 32px -12px rgb(var(--shadow-color) / 0.30)",
      },
      transitionTimingFunction: {
        // No overshoot; desktop UI should feel immediate, not springy.
        swift: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 160ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-up": "slide-up 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};
