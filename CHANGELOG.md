# Changelog

Notable changes, newest first. Versions follow
[semantic versioning](https://semver.org), with the caveat that on 0.x
the middle number carries the weight a major would.

This file starts at 0.1.5. Earlier releases are on the
[releases page](https://github.com/kryptonhq/loupe/releases); 0.1.3 and
0.1.4 exist only as version bumps and were never published.

## [0.1.6] — 2026-09-25

### Added

- **Search the whole cluster from ⌘K.** Type part of a name and the
  palette finds matching objects of every kind — custom resources
  included — rather than only the rows a listing has loaded. Results are
  grouped by kind with their namespace and status; Enter opens one here,
  ⌘-Enter in a new tab. The index is built in the background from the
  API server's own listings, holds names and not contents (Secrets by
  name only), skips what RBAC does not allow and says how much that was,
  and is thrown away when you switch cluster.

- **Problems.** One view of everything currently broken across the
  cluster, so "is anything wrong?" has a one-glance answer after
  connecting. Crash loops with their exit codes, images that cannot be
  pulled, pods the scheduler cannot place and why, OOM kills, workloads
  short of replicas, failed Jobs and CronJobs, unready or pressured
  nodes, taints blocking pending pods, unbound claims, and the last
  hour's warning events — forty identical ones as one row with a count.
  Kept current by watches rather than polling, counted in the status
  bar, and honest about RBAC: a category you may not list says so
  instead of looking healthy. Grace period and restart threshold are in
  `settings.json`.

### Fixed

- **EKS, GKE and AKS contexts failed to connect** when Loupe was opened
  from the Dock or Finder, with "auth error: unable to run auth exec: No
  such file or directory" — while kubectl worked. Those kubeconfigs
  authenticate by running a plugin such as `aws` or
  `gke-gcloud-auth-plugin`, and an app launched by macOS gets only
  `/usr/bin:/bin:/usr/sbin:/sbin`, not your shell's PATH. Loupe now reads
  your login shell's environment at startup, so it finds the same
  plugin kubectl does, and picks up `KUBECONFIG`, `AWS_PROFILE` and
  friends when they are set there.

- **Listing a kind with no objects** could fail with "invalid type: null,
  expected a sequence". The API server sends `rows: null` rather than an
  empty list for an empty kind — seen on `LimitRange` and
  `CSIStorageCapacity` on a fresh cluster.

- **Signed Linux downloads.** The `.AppImage`, `.deb` and `.rpm` each
  carry a detached GPG signature, so a download can be checked with
  `gpg --verify` against a published key rather than trusted because of
  where it came from. macOS was already signed and notarised; Windows
  signing is planned, and SmartScreen will still warn until it lands.

### Security

- **rustls 0.23.45**, for
  [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285)
  (medium). rustls carries every connection Loupe makes to a cluster
  and to the update server.

## [0.1.5] — 2026-08-20

The first release since 0.1.2, and a large one: everything below either
had no public build at all or is new since.

### Added

- **Tabs, and a history behind each one.** The main area used to render
  exactly one view, so opening a pod lost the list it came from and
  following a related object was a one-way trip. Tabs open with ⌘T,
  close with ⌘W, and ⌘-clicking a row opens it in one of its own; ⌘[ and
  ⌘] walk a real back/forward history per tab.
- **A status bar.** Cluster, guard, server version and any pending
  update, on one line that does not move. The cluster and its write
  guard used to live in the foot of the nav rail, which is no help once
  you are three panes deep in a manifest.
- **Sortable columns**, in the units the columns are actually in. Ages
  sort as durations, ready counts as fractions, restarts as numbers —
  so `10m` no longer sorts before `2d`, and `pod-2` comes before
  `pod-10`. Sorting a partly loaded listing says so.
- **Auto-update.** Loupe checks once on launch and offers a new version
  in the status bar, verified against a signing key compiled into the
  binary. Also in the command palette as *Check for updates*.
- **Interface zoom** — ⌘+, ⌘− and ⌘0, from the View menu, the keyboard
  or the palette, remembered across launches.
- **Several clusters stay connected.** Switching back to one
  re-authenticates nothing and re-walks no API discovery.
- **Exec into a container**, through a real terminal emulator rather
  than a text box that sends lines.
- **Port-forward manager**, with forwards visible while they run instead
  of a terminal you have to leave open.
- **Operator actions** — scale, rollout restart, delete, cordon and
  drain — behind confirmations, and hidden entirely where RBAC says no.
- **Merged log view.** Tail every pod of a workload in one stream,
  colour-coded per pod, instead of opening them one at a time.
- **Log filtering, highlighting, and copy or save** of what is on
  screen.
- **Related-object navigation** — owners, selectors and references, so
  a pod is no longer an island.
- **Protected and read-only contexts**, marked per context, with a diff
  shown before every apply.
- **Command palette** (⌘K) and keyboard-first navigation.

### Changed

- **A mark of Loupe's own.** The app wore the Krypton mark, byte for
  byte the same file as the runtime's operator UI. The new one is a lens
  iris whose opening keeps the family's hexagon — and, unlike its
  predecessor's 1px lattice, survives being 16 pixels wide.
- **Breadcrumbs describe where an object sits**, not how you got there.
  They used to be the tab's visited history, which produced trails like
  `Nodes › Pods › some-pod › Jobs › DaemonSets` — six steps, none
  containing the next, in the one element whose meaning is containment.
- **Content sits in front of the chrome.** The surface ramp was defined
  and never painted, so a table fell through to the window background
  while every bar of chrome around it was brighter. Light and dark now
  both run base → glass → content.
- **Listings are paged and watched.** A page is fetched at a time, so
  time to first row follows the page size rather than the size of the
  cluster, and freshness comes from a watch rather than a ten-second
  timer.
- **The context picker stays instant** on a kubeconfig with thousands of
  contexts: search text is built once rather than per keystroke, only
  visible rows are in the DOM, and recents and pins sit above everything.
- **The log viewer keeps up with chatty pods** — lines batched on the
  Rust side, coalesced onto animation frames, and only the visible ones
  in the DOM.

### Fixed

- A listing's namespace filter, search and sort survive opening a row
  and coming back. They used to live in the page, which unmounts.
- The terminal no longer rebuilds itself on every render, mangles its
  own output, or ships without the stylesheet that makes it a terminal.
- Switching cluster no longer leaves tabs pointing at objects that do
  not exist in the new one.

### Notes

- Anyone on 0.1.2 must update by `brew upgrade` or a fresh download —
  there was no updater to offer them this one. From 0.1.5 onward Loupe
  can update itself.
- Homebrew is told the app self-updates, so `brew upgrade` no longer
  reinstalls an older build over a newer one.
