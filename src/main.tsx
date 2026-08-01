import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { api } from "./lib/api";
import "./index.css";

// Opening the Vite dev server in a plain browser has no Tauri bridge,
// so every command would throw. Fall back to demo fixtures there. Both
// guards matter: DEV is stripped from production builds, and the
// presence check means the desktop app always keeps the real bridge.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installDemoBridge } = await import("./dev/fixtures");
  installDemoBridge();
}

// Follow the OS appearance. Tailwind runs with darkMode:"class", so the
// class on <html> is what actually switches the palette.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (isDark: boolean) =>
  document.documentElement.classList.toggle("dark", isDark);

applyTheme(dark.matches);
dark.addEventListener("change", (e) => applyTheme(e.matches));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cluster state moves constantly, so cached data is stale
      // immediately — but it stays on screen while the refetch runs,
      // which is the whole point: no blank tables between refreshes.
      staleTime: 0,
      refetchInterval: 10_000,
      refetchOnWindowFocus: true,
      // Kubernetes errors are usually terminal for the request — an
      // RBAC denial or a missing pod will not succeed on retry, and
      // retrying only delays showing the user the reason.
      retry: false,
    },
  },
});

// Ask the Rust side whether the window is genuinely translucent, and
// mark the document if so. Failure means no bridge (browser dev) or an
// older build; either way the opaque background is the safe default.
void api
  .vibrancyEnabled()
  // Strict compare: a malformed reply must not enable a translucent
  // stylesheet over an opaque window.
  .then((on) => document.documentElement.classList.toggle("vibrancy", on === true))
  .catch(() => {});

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

// ?design renders the style guide instead of the app. Inside the DEV
// guard so the module is absent from a production bundle rather than
// present-but-unreachable.
if (
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has("design")
) {
  const { DesignSystem } = await import("./dev/DesignSystem");
  root.render(
    <React.StrictMode>
      <DesignSystem />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
