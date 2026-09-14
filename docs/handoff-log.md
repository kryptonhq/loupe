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
  pending past grace. 22 unit tests.
- `cluster::problems` — a monitor per subscription: nine
  `kube::runtime::watcher`s (`any_semantic`, paged, with backoff) into a
  trimmed in-memory store, re-evaluated on change (250 ms coalesce) and
  every 15 s (memory only, no API calls), pushed to a Tauri channel.
  Each source degrades on its own; a 403 stops that watch and becomes a
  single `NotPermitted` row. Stopped on disconnect. 8 unit tests.
- `settings.json` → `problems.gracePeriodSeconds` (120) and
  `problems.restartThreshold` (5), read when the monitor starts.
- Frontend: `problems` route with `ListView` (namespace, search, sort
  per tab), `pages/Problems.tsx`, rail entry with count, status bar
  badge that opens the view, palette command, one window-level
  subscription (`useProblems`). Fixtures in `src/dev/fixtures.ts`
  (`demoProblems`). 33 new frontend tests.

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
