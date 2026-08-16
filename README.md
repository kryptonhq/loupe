<p align="center">
  <img src="src/assets/logo.svg" width="88" alt="Loupe" />
</p>

<h1 align="center">Loupe</h1>

<p align="center">
  An open-source desktop client for Kubernetes. Free, and staying that way.
</p>

<p align="center">
  <a href="https://github.com/kryptonhq/loupe/actions/workflows/ci.yml"><img src="https://github.com/kryptonhq/loupe/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/kryptonhq/loupe"><img src="https://codecov.io/gh/kryptonhq/loupe/branch/main/graph/badge.svg" alt="Coverage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-Apache--2.0-blue.svg" alt="Apache 2.0" /></a>
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
- Views for nodes, namespaces and pods, with search and paging
- Pod detail: containers and their termination reasons, conditions,
  labels, events, and the manifest
- Node detail: allocated CPU and memory against what the scheduler has
  left, taints, pressure conditions, and the pods scheduled there
- Namespace detail: pod health at a glance, ResourceQuota headroom,
  finalizers when a namespace will not go away, and everything
  happening inside it
- Workloads, networking, config and storage — deployments, statefulsets,
  daemonsets, jobs, cronjobs, services, ingresses, config maps, secrets,
  volume claims and the rest — listed with the same columns `kubectl get`
  prints, because the API server does the printing
- Any custom resource, discovered from the cluster's own API — a CRD
  installed a minute ago is browsable without a new build, and shows
  whatever printer columns its author defined
- Secrets are described without being disclosed: keys and sizes are
  shown, values arrive one at a time on request, and the YAML tab
  redacts them
- Helm releases read straight from the release secrets: values, rendered
  manifest, notes and revision history, with no `helm` binary needed
- Editing: the YAML tab writes back as a full replace, so an object
  someone else changed underneath you is rejected rather than silently
  overwritten — and every apply shows a diff first, with the fields the
  server manages stripped out and the ones that carry weight marked
- Scale, rollout restart, delete, cordon and drain. Every one confirms,
  naming the cluster before the object, and an action your RBAC forbids
  is absent rather than failing
- Per-context safeguards: mark a cluster read-only and writes are
  refused, or protected and each one has to be confirmed by typing the
  context name. Enforced in Rust, not just hidden in the UI. This is not
  RBAC — it is the client-side equivalent of a red border round the
  production window
- A shell in any container, and port forwards that survive a rollout —
  the target pod is resolved per connection, so a forward aimed at a
  Service keeps working while its pods are replaced
- Related-object navigation: from a pod, the ReplicaSet that made it,
  the Deployment above that, the Service that selects it, and the
  ConfigMaps it mounts, each one click away
- Light, dark, or follow-the-system appearance, remembered in
  `settings.json` beside the app's other config
- Pod logs, streamed live — with container selection, timestamps, and
  `previous` for reading why a crashed container died. Filter them with
  a substring or a regex, exclude the noise, keep `grep -C` context, and
  copy or save what is on screen with a header recording what it was
  filtered through
- Or log a whole workload: every replica of a Deployment merged into one
  view, colour-coded by pod, following pods as a rollout replaces them —
  `stern` without the second tool
- A command palette on ⌘K over every kind, custom resource, context and
  action, so a session can run without the mouse

<p align="center">
  <img src="docs/screenshots/services.png" width="820" alt="Service list with the columns kubectl get prints" />
</p>

<p align="center">
  <em>Listings use the API server's own printer, so the columns match
  <code>kubectl get</code> — for built-in kinds and custom resources alike.</em>
</p>

<p align="center">
  <img src="docs/screenshots/node-detail.png" width="820" alt="Node detail with allocated CPU and memory against allocatable" />
</p>

<p align="center">
  <img src="docs/screenshots/secret-data.png" width="820" alt="Secret keys and sizes with values held back behind a per-key reveal" />
</p>

<p align="center">
  <em>A Secret is described without being disclosed.</em>
</p>

<p align="center">
  <img src="docs/screenshots/pod-yaml.png" width="820" alt="Pod manifest with syntax highlighting" />
</p>

## Scale

Loupe is built for the kubeconfig and the cluster people actually have,
not the demo ones:

- **A kubeconfig with thousands of contexts** opens instantly. Search
  text is built once rather than per keystroke, only the rows on screen
  are in the DOM, and results are ranked — so typing a cluster's full
  name puts it first rather than thirtieth. Recents and pins sit above
  everything, because on six thousand contexts about four are the ones
  anyone opens.
- **Listings are paged and watched.** A page is fetched at a time, so
  time to first row follows the page size rather than the size of the
  cluster, and freshness comes from a watch rather than a ten-second
  timer — one LIST and then deltas, which is both cheaper for the API
  server and faster to notice a change. When a listing holds only part
  of a namespace, it says so rather than implying a search covered
  everything.
- **Logs keep up with chatty pods.** Lines are batched on the Rust side,
  coalesced onto animation frames, and only the visible ones are in the
  DOM, so a pod emitting thousands of lines a second does not stutter.
- **Several clusters stay connected**, so switching back to one
  re-authenticates nothing and re-walks no API discovery.

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

## Installing

```bash
brew install --cask kryptonhq/tap/loupe
```

The macOS builds are signed with a Developer ID and notarised, so the
app opens on a double-click — nothing to allow in System Settings.

Or take a build from [releases](https://github.com/kryptonhq/loupe/releases):

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | `Loupe_<version>_aarch64.dmg` |
| macOS (Intel) | `Loupe_<version>_x64.dmg` |
| Linux | `.AppImage` (portable) or `.deb` |
| Windows | `-setup.exe` or `.msi` |

The Windows installers are not signed yet, so SmartScreen will warn on
first run — choose **More info → Run anyway**. Signing them is on the
list; see [RELEASING.md](RELEASING.md#windows).

Loupe reads the same kubeconfig as `kubectl`, so there is nothing to
configure — it lists the contexts you already have.

## Building from source

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
pnpm test:coverage             # …with a coverage report
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs `cargo fmt --check` and `cargo clippy -- -D warnings` as well, so
it is worth running both before pushing:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
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
  components/            Shared UI (Table, LogViewer, Terminal, palette)
  lib/api.ts             Typed wrappers over the Tauri commands
  lib/highlight.ts       YAML tokenizer for the manifest view
  lib/logBuffer.ts       Ring buffer behind the log viewer
  lib/useWatch.ts        Keeps a listing fresh from a watch
  lib/yamlDiff.ts        The diff shown before an apply
  pages/                 Context picker, resource lists, detail views
src-tauri/
  src/lib.rs             Tauri command surface
  src/cluster/           kubeconfig, session pool, resources, detail,
                         logs, exec, port-forward, watch, discovery,
                         server-side printing, helm, edit, actions
  src/guard.rs           Per-context read-only and protected marks
  src/error.rs           Error type shared across the IPC boundary
```

The frontend mirrors the runtime's operator UI — same Tailwind theme,
same mark — so the two read as one product.

## Releasing

Tag-driven, built by GitHub Actions, published as a GitHub release. See
[RELEASING.md](RELEASING.md).

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

The read path covers the everyday objects; editing exists, deleting does
not. Next:

- Detail views that follow ownership — the pods behind a deployment, the
  endpoints behind a service, the volume behind a claim
- Multi-cluster (several connected contexts at once)
- Deleting, behind a confirmation that names what goes
- `exec` into a container

## Licence

Apache 2.0. See [LICENSE](LICENSE).
