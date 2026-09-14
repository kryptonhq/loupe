# Handoff log

One entry per feature from the nine-feature handoff: what shipped,
measured numbers for any performance criterion, and deviations from the
handoff document with the reason for each.

## Release plan (deviation)

The handoff asks for one release per feature. On 2026-09-14 the maintainer
chose instead to ship features 1–8 together as **v0.2.0**, alongside the
Linux signing from feature 9. Each feature still lands as its own PR on
`main` with its own CHANGELOG entry under *Unreleased*; the only change is
that nothing is tagged until feature 8 is merged. The trade-off accepted:
a regression in one feature holds up the rest, and the release candidate
needs a full manual pass before tagging.

## 2. Cluster-wide ⌘K search

Branch `feat/cluster-search`; website branch `docs/loupe-search`.

**Shipped**

- `cluster::search` — one in-memory index for the active context. Built
  from server-printed Table listings (`resourceVersion=0` for the first
  page, then paged at 500), four kinds at a time, pods, deployments,
  services, configmaps and secrets first. Holds name, namespace (interned)
  and one status word from the Status/Phase/Ready/State column. Secrets
  are name-only; Events are excluded. 403 marks a kind forbidden for the
  session; other failures retry after 60 s; kinds are re-listed after
  5 minutes; a kind discovery stops serving is dropped. A different active
  context resets the index, and a generation counter stops a warmer for
  the previous cluster writing into the new one. Cleared on disconnect.
- `search_objects(query)` never waits on the cluster: it plans what needs
  listing, starts the warmer if idle, and answers from what is indexed,
  with coverage counts (`indexedKinds`, `totalKinds`, `forbiddenKinds`,
  `failedKinds`, `objects`, `warming`, `approxBytes`).
- Ranking: every whitespace term must match; name prefix > name substring
  > namespace or kind. At most 10 hits per kind, 60 in all.
- Palette: object results grouped by kind after the commands, namespace
  and status as the hint, Enter here / ⌘-Enter new tab, a coverage footer
  ("5,120 objects in 40 of 43 kinds · 3 kinds not permitted · indexing…"),
  a still-indexing message and re-query while warming, stale responses
  ignored. `routeForObject` in `lib/routes.ts` is now shared with Problems.
- **Fix found on the way:** `table.rs` rejected `rows: null`, which the API
  server sends for an empty kind, so listing an empty `LimitRange` or
  `CSIStorageCapacity` failed. Regression test added.
- Tests: 21 Rust unit tests (plus a Table regression test), one live kind
  test; 14 new frontend tests. Demo index in `src/dev/fixtures.ts`.

**Measured**

- Live, kind (Kubernetes v1.37.0), release build, 5,519 objects across
  63 kinds including two CRDs (`search::live_tests`):
  - first search returned in **0.9–1.5 ms** while warming had not started
    listing — it does not wait;
  - fully warm in **0.10 s**;
  - slowest warm 3-character query end to end **0.7–2.2 ms** (criterion
    300 ms);
  - a CRD created after warming was searchable **103 ms** after the
    discovery refresh;
  - index **≈ 0.37 MB**.
- Synthetic, 10,000 objects over 41 kinds, debug build (unit test): index
  **≈ 0.89 MB** (criterion 50 MB); 3-character query **10.6 ms**.
- Restricted ServiceAccount (list on pods, configmaps, services): 4 kinds
  indexed — those three plus `ClusterTrustBundle`, which Kubernetes lets
  every authenticated user list — and **60 not permitted**; objects of
  forbidden kinds never appear in results.

**Deviations**

- **Objects are listed alongside matching commands**, below them, rather
  than only when no command matches. Hiding objects whenever a command
  matched would make `api` find "Check for updates"-style commands and not
  the `api` Deployment.
- **The memory figure is counted, not sampled.** `approxBytes` sums every
  allocation the index owns (names, interned strings, per-kind metadata,
  vector capacity). Process RSS includes the webview and kube client and
  would not isolate the index.
- **The index is a snapshot, not a watch**, refreshed per kind after five
  minutes. Watching every kind to keep names current would hold a watch
  per kind for a feature used in short bursts.
- **Warming starts when the palette first opens**, not on connect, so a
  connection costs nothing until search is used. On the measured cluster
  that is 0.1 s; on a very large one the first query answers from the
  priority kinds while the rest index.
- **Two characters**, not three, start an object search.
- **Context invalidation** is covered by a unit test (reset plus
  generation) rather than the live test, which has one cluster.
- **Events are excluded** from the index; the criterion's "≥ 40 kinds" is
  met without them.

## 1. Problems view

Branch `feat/problems-view`; website branch `docs/loupe-problems`.

**Shipped**

- `cluster::problems::rules` — pure rules over typed objects with the
  clock passed in: pods (crash loop, image pull, container config
  errors, OOMKilled, restarts over threshold, pending with the
  scheduler's reason, not ready past grace, failed), workloads
  (replicas short past grace, stalled rollout, failed Job, CronJob whose
  newest owned Job failed), nodes (not ready, pressure, cordoned, taints
  not tolerated by unschedulable pending pods), warning events in the
  last hour deduplicated by (kind, namespace, name, reason), and PVCs
  pending past grace. 34 unit tests.
- `cluster::problems` — a monitor per subscription: nine
  `kube::runtime::watcher`s (`any_semantic`, paged, with backoff) into a
  trimmed in-memory store, re-evaluated on change (250 ms coalesce) and
  every 15 s (memory only, no API calls), pushed to a Tauri channel.
  Each source degrades on its own; a 403 stops that watch and becomes a
  single `NotPermitted` row. Stopped on disconnect. Event handling (`apply_event`) and the publish
  loop are split out so they are tested without a cluster; 14 unit tests.
- `settings.json` → `problems.gracePeriodSeconds` (120) and
  `problems.restartThreshold` (5), read when the monitor starts.
- Frontend: `problems` route with `ListView` (namespace, search, sort
  per tab), `pages/Problems.tsx`, rail entry with count, status bar
  badge that opens the view, palette command, one window-level
  subscription (`useProblems`). Fixtures in `src/dev/fixtures.ts`
  (`demoProblems`). 43 new frontend tests, including App-level wiring.

**Measured** (kind, Kubernetes v1.37.0, single node, `problems::live_tests`)

- All three acceptance breakages reported **0.28–0.29 s** after the
  monitor started (criterion: 5 s).
- The image-pull row cleared **0.5 s** after patching the image, with no
  refetch (criterion: one watch cycle).
- A ServiceAccount allowed everything except nodes and events got
  exactly two `NotPermitted` rows and still saw its pod problems.

**Deviations**

- **"Restarts within the last hour"** is approximated as restart count
  ≥ threshold *and* the last termination finished within the hour. The
  API records a restart count and the last termination time, not a
  history of restart times.
- **StatefulSets and DaemonSets have no condition recording when they
  became degraded**, so their grace period runs from when the monitor
  first saw them short. A set already degraded before connecting appears
  after the grace period rather than immediately. Deployments use their
  `Available` condition and are not affected; pods owned by a degraded
  set are reported by the pod rules without waiting.
- **Taint blocking** checks `nodeSelector` but not node affinity. A pod
  excluded from a tainted node by affinity may still be counted against
  that taint.
- **A user who can list only some namespaces** sees every category as
  not permitted, because the watches are cluster-wide. Falling back to
  per-namespace watches is possible but was not in scope.
- **Warning events and not-permitted rows are `info`** and excluded from
  the status bar count, which counts critical and warning rows only. On
  a busy cluster some event is always a warning, and a count that is
  never zero stops being read.
- **Additions beyond the list:** `CreateContainerConfigError` and related
  container start errors (critical), stalled rollouts
  (`ProgressDeadlineExceeded`), and pods in phase `Failed`.
- **Live tests use a 5 s grace period** rather than the 120 s default, to
  avoid spending two minutes proving arithmetic the unit tests cover.
  The defaults themselves are asserted in `settings.rs`.
- **Not verified in a real Tauri window.** The Rust side was exercised
  on kind and the UI through `pnpm dev` fixtures; the channel between
  them uses the same mechanism as the existing watches.

## 9. Signed Linux builds

Branch `feat/linux-signing`; website branch `docs/loupe-linux-signing`.

**Shipped**

- `scripts/sign-linux-artifacts.sh` makes a detached, armoured GPG
  signature for each `.AppImage`, `.deb` and `.rpm`, after checking the
  secret key's fingerprint equals the committed public key's, and
  verifies each signature against a keyring holding *only* the committed
  public key before printing it for upload.
- The release workflow's Linux build runs it after tauri-action and
  uploads the `.asc` files into the draft. `publish` now requires an
  `.rpm` asset, and — once the key is committed — a same-named `.asc`
  beside every Linux installer.
- `scripts/test-sign-linux-artifacts.sh` runs in CI as the `signing`
  job: happy path, tampered artifact, wrong key, missing format, missing
  secret — each failure asserted by its message, not just its exit code.
- RELEASING.md: Linux section and key ceremony; Windows marked "signing
  planned". `packaging/linux/README.md`: user verification. Website:
  "Verifying a download", Windows caution retitled.

**Deviations**

- **The key was generated by the maintainer, not the agent** (RELEASING.md
  → "The key ceremony"), on 2026-09-14: ed25519, sign-only, expires
  2029-09-13, fingerprint `CC01D01D4A8B455DCC67EED51D2D0C2A56D78DD0`.
  Both secrets are set; the revocation certificate is held offline and
  `*-revoke.asc` is gitignored. The public key is committed in its own
  commit, last, since it is what makes signing mandatory.
- **"Fails if signing fails" is gated on the public key being
  committed**, not unconditional. Unconditional would fail every release
  until the ceremony happens. The committed key is what tells users to
  expect signatures, so it is the right switch: from that commit onward
  a missing secret, wrong key, or missing signature blocks `publish`.
- **Detached signatures only, no embedded rpm/deb signatures.** Embedded
  signing rewrites the file after tauri-action has uploaded it and after
  the updater's minisign signature was computed over it. `rpm -K` will
  therefore report the rpm as unsigned; `gpg --verify` is the documented
  check.
- **No `.deb` repository exists**, so there is no repository metadata to
  sign ("if any" in the criterion).
- **Windows tracking issue:** kryptonhq/loupe#53.
- **Updater verification** is unaffected by construction — no artifact
  byte changes — but is not re-proven until the next real release; the
  repo has no throwaway-tag path (RELEASING.md, "Testing on a throwaway
  tag does not work yet").
