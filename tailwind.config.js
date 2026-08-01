/** @type {import('tailwindcss').Config} */
// Kept in sync with kryptonhq/runtime's ui/tailwind.config.js so the
// desktop app and the in-cluster operator UI read as one product.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#6366f1",
          fg: "#eef2ff",
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
