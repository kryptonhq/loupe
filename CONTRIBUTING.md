# Contributing to Loupe

Thanks for your interest. Loupe is Apache-2.0 and intends to stay a
neutral, community-owned project.

## Developer Certificate of Origin

Every commit must be signed off. Loupe uses the
[Developer Certificate of Origin](https://developercertificate.org/)
(DCO) rather than a CLA — you keep the copyright to your contribution,
and the sign-off is your statement that you have the right to submit it
under the project's licence.

Add the sign-off automatically with `-s`:

```bash
git commit -s -m "your message"
```

That appends a line to the commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must be real and must match your git config. CI
rejects commits without a sign-off.

Forgot it? Amend the last commit:

```bash
git commit --amend -s --no-edit
```

For a longer branch, sign off everything since `main`:

```bash
git rebase --signoff main
```

## Development setup

Prerequisites: [Rust](https://rustup.rs), Node 22+, pnpm 10+. On macOS
you also need the Xcode command line tools.

```bash
pnpm install
pnpm tauri dev
```

## Before you open a pull request

```bash
pnpm test                                              # frontend tests
pnpm build                                             # typecheck + bundle
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
```

Some Rust tests need a real cluster and are ignored by default. If your
change touches anything that talks to Kubernetes, run them against a
local cluster:

```bash
LOUPE_TEST_CONTEXT=orbstack \
  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
```

`pnpm dev` alone serves the UI in a browser with no Tauri bridge, so it
falls back to the demo fixtures in `src/dev/fixtures.ts`. That is enough
for layout work, but anything touching cluster behaviour should be
checked in the real app.

## What we look for

- **Tests that would fail without the change.** The cluster-backed tests
  exist because a type-checked call to the Kubernetes API can still be
  wrong in every way that matters.
- **Comments explaining why, not what.** The code says what it does.
- **Errors surfaced, not swallowed.** An RBAC denial rendered as an
  empty table looks like a healthy, empty cluster. Show the reason.

## Reporting bugs

Open an issue with the Kubernetes version, the platform, and what you
expected. If it involves a cluster response, the output of the
equivalent `kubectl` command helps a great deal.

For security issues, see [SECURITY.md](SECURITY.md) — please do not open
a public issue.

## Code of conduct

This project follows the
[CNCF Code of Conduct](https://github.com/cncf/foundation/blob/main/code-of-conduct.md).
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
