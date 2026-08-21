# Changelog

Notable changes, newest first. Versions follow
[semantic versioning](https://semver.org), with the caveat that on 0.x
the middle number carries the weight a major would.

This file starts at 0.1.5. Earlier releases are on the
[releases page](https://github.com/kryptonhq/loupe/releases); 0.1.3 and
0.1.4 exist only as version bumps and were never published.

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
