# Releasing

Releases are cut from a tag and built by
[`.github/workflows/release.yml`](.github/workflows/release.yml). Every
platform builds into one draft GitHub release, which is published only
once all of them have landed.

## Cutting a release

```bash
scripts/version.py --set 0.2.0        # package.json, Cargo.toml, tauri.conf.json
pnpm install                          # refresh the lockfile's version
git commit -sam "release: 0.2.0"
git tag v0.2.0
git push --follow-tags
```

The workflow refuses a tag whose manifests disagree with it, because the
installer is named from the manifest rather than the tag — a mismatch
produces a `Loupe_0.1.0_aarch64.dmg` inside a `v0.2.0` release, and a
Homebrew cask that 404s.

A failed run can be retried from the Actions tab (**Run workflow** →
enter the tag) without moving or recreating the tag.

## What gets built

| Platform | Artifacts |
| --- | --- |
| macOS (Apple Silicon) | `Loupe_<version>_aarch64.dmg` |
| macOS (Intel) | `Loupe_<version>_x64.dmg` |
| Linux | `.AppImage`, `.deb`, `.rpm` |
| Windows | `.msi`, `-setup.exe` (NSIS) |

Linux builds on `ubuntu-22.04` rather than the newest runner: the binary
picks up the glibc it was built against, and building on 24.04 would
refuse to start on anything older.

The two macOS builds are separate rather than a universal binary, so
each download is the size of one architecture. Homebrew picks the right
one from the cask's `arch` stanza.

## Signing

Everything below is optional in the sense that the build succeeds
without it. None of it is optional if you want people to be able to open
the app without a fight.

### macOS

There are three states, not two, and the difference between the first
two is worth understanding before deciding what to do about the third.

**Left alone**, Tauri does not codesign the bundle at all. The only
signature is the one the linker leaves on the binary, which macOS reads
as *malformed* — `spctl` reports "code has no resources but signature
indicates they must be present", and the user is told **"Loupe is
damaged and can't be opened. You should move it to the Trash."** That
message is actively misleading: it points at a corrupt download rather
than at an unsigned app, and there is no obvious way past it.

**Ad-hoc signed**, which is what the release workflow does when no
certificate is configured, the bundle carries a valid signature and the
hardened runtime. Gatekeeper still refuses it — there is no
notarisation — but for the reason it actually is, and the user gets the
normal "Open Anyway" path in Privacy & Security. This costs nothing and
is the current default.

**Signed and notarised** is the only state where the app opens on a
double-click, and the only one homebrew/cask would accept, since a cask
there
[must not require Gatekeeper to be bypassed](https://docs.brew.sh/Acceptable-Casks).
Our own tap has no such rule, so the cask ships today with a `caveats`
block that explains the situation rather than a `postflight` that strips
the quarantine attribute silently.

Getting there needs an Apple Developer account (99 USD/year) and these
repository secrets. They are all-or-nothing: a partial set makes Tauri
attempt a notarisation it cannot complete.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12`, base64 encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | The Apple ID used for notarisation |
| `APPLE_PASSWORD` | An app-specific password, not the account password |
| `APPLE_TEAM_ID` | The 10-character team identifier |

```bash
# Export the certificate from Keychain Access first.
base64 -i DeveloperID.p12 | pbcopy
```

When they are all present Tauri signs with the real identity and
notarises. When `APPLE_SIGNING_IDENTITY` is absent the workflow passes
`-` instead, which is the ad-hoc case above.

### Windows

Unsigned installers work, but SmartScreen warns until the binary has
built up reputation — which for a low-volume download effectively means
always. Signing needs a code-signing certificate and a
`bundle.windows.signCommand` in `tauri.conf.json`; there is no
credential-only path.

## Homebrew

```bash
brew install --cask kryptonhq/tap/loupe
```

Until the builds are notarised, first launch needs one of:

- **System Settings → Privacy & Security → Open Anyway**, or
- `brew install --cask --no-quarantine kryptonhq/tap/loupe`

The cask says so in its caveats. It could remove the quarantine
attribute itself in a `postflight` and make the whole thing invisible,
and deliberately does not: stripping a security attribute on someone's
behalf, without them asking, is not a decision an installer should make
quietly.

### The tap

The cask lives in a tap this project owns —
`github.com/kryptonhq/homebrew-tap` — rather than in `homebrew/cask`.
That is the right starting point: a tap can be created today and needs
nobody's approval, while homebrew-cask judges submissions on
[notability](https://docs.brew.sh/Acceptable-Casks) and will decline a
project that has not built an audience yet. Moving to homebrew-cask
later is a submission, not a migration — the tap can keep working
alongside it.

To set it up:

1. Create a **public** repository named exactly `homebrew-tap` under the
   `kryptonhq` organisation. The `homebrew-` prefix is what lets
   `kryptonhq/tap` resolve. It may be empty — the first release creates
   the branch and the `Casks/` directory.
2. Create a fine-grained personal access token scoped to that repository
   with **Contents: read and write**.
3. Add it to this repository as the `HOMEBREW_TAP_TOKEN` secret.

The release workflow then renders
[`packaging/homebrew/loupe.rb.template`](packaging/homebrew/loupe.rb.template)
with the published DMGs' checksums and pushes it to `Casks/loupe.rb`.
Without the secret that job logs a notice and skips, so releases work
before the tap exists.

Checksums are taken from the uploaded artifacts rather than from a local
build, so what the cask claims is what people actually download.

## Not done yet

- **Auto-update.** Tauri ships an updater; it needs a signing key pair
  and an update manifest published alongside the release. Worth having
  before there are enough users that "download the new DMG" stops being
  reasonable.
- **Linux repositories.** The `.deb` is a direct download, not an apt
  repository. AppImage covers most of the gap.
- **`homebrew/cask` submission**, once the notability bar is met.
