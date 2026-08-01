<p align="center">
  <img src="src/assets/logo.svg" width="88" alt="Loupe" />
</p>

<h1 align="center">Loupe</h1>

<p align="center">
  An open-source desktop client for Kubernetes. Free, and staying that way.
</p>

<p align="center">
  <img src="docs/screenshots/pods.png" width="820" alt="Pod list with search, status and restart counts" />
</p>

<p align="center">
  <em>Screenshots use demo data, not a live cluster.</em>
</p>

---

## Why

Lens moved behind a commercial licence and OpenLens was discontinued. The
official Kubernetes Dashboard was archived in January 2026 for want of
maintainers. Loupe is an Apache-2.0 alternative that reads the same
kubeconfig as `kubectl` and behaves the way an operator expects.

Loupe is a companion to
[kryptonhq/runtime](https://github.com/kryptonhq/runtime), the in-cluster
AI agent runtime — but it is a general Kubernetes client and does not
require Krypton Runtime to be installed.

## What works today

- Kubeconfig context discovery, connecting, and switching cluster
- Read-only views for nodes, namespaces and pods, with search and paging
- Pod detail: containers and their termination reasons, conditions,
  labels, events, and the manifest
- Pod logs, streamed live — with container selection, timestamps, and
  `previous` for reading why a crashed container died

<p align="center">
  <img src="docs/screenshots/pod-yaml.png" width="820" alt="Pod manifest with syntax highlighting" />
</p>

## Security model

The Rust process owns every cluster interaction. The webview never
receives a kubeconfig, a bearer token, or an API server URL it could
exfiltrate — it calls typed commands and gets back summarised data. That
matters because the frontend is a bundled browser engine, and keeping
credentials out of it removes a whole class of risk.

Loupe holds **no credentials of its own**. It authenticates as whoever
your kubeconfig says you are, so the API server decides what you can see.
If a listing comes back denied, that is your RBAC — not a bug in the app,
and the error is surfaced rather than swallowed into an empty table.

## Getting started

Prerequisites: [Rust](https://rustup.rs), Node 22+, pnpm 10+. On macOS
you also need the Xcode command line tools.

```bash
pnpm install
pnpm tauri dev
```

To produce a distributable bundle:

```bash
pnpm tauri build
```

## Development

```bash
pnpm test                      # frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml
```

The Rust suite includes tests that need a real cluster. They are ignored
by default; point them at a local one to run them:

```bash
LOUPE_TEST_CONTEXT=orbstack \
  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
```

`pnpm dev` on its own serves the UI in a plain browser, where there is no
Tauri bridge. In that case Loupe falls back to the demo fixtures in
`src/dev/fixtures.ts`, so layout work does not need a cluster. That path
is dev-only and is stripped from production builds.

## Layout

```
src/                     React + TypeScript frontend
  components/            Shared UI (Table, Chip, LogViewer, YamlView)
  lib/api.ts             Typed wrappers over the Tauri commands
  lib/highlight.ts       YAML tokenizer for the manifest view
  pages/                 Context picker, resource lists, pod detail
src-tauri/
  src/lib.rs             Tauri command surface
  src/cluster/           kubeconfig, session, resources, detail, logs
  src/error.rs           Error type shared across the IPC boundary
```

The frontend mirrors the runtime's operator UI — same Tailwind theme,
same mark — so the two read as one product.

## Contributing

Contributions are welcome. Loupe uses the
[DCO](https://developercertificate.org/) rather than a CLA — sign your
commits with `git commit -s` and you keep your copyright. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the details,
[GOVERNANCE.md](GOVERNANCE.md) for how decisions get made, and
[SECURITY.md](SECURITY.md) before reporting anything security related.

This project follows the
[CNCF Code of Conduct](https://github.com/cncf/foundation/blob/main/code-of-conduct.md).

## Status

Early, and read-only by design until the read path is solid. Next:

- Generic CRD browsing via API discovery
- Deployments, services, and the rest of the core workloads
- Helm release listing
- Multi-cluster (several connected contexts at once)
- Write operations: scale, delete, apply, exec

## Licence

Apache 2.0. See [LICENSE](LICENSE).
