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

Unsigned and un-notarised, macOS refuses to open the app at all —
Gatekeeper reports it as damaged, and the only way past is
`xattr -d com.apple.quarantine`, which is not something to ask of
someone installing a Kubernetes client.

It also rules out Homebrew: casks
[must not require Gatekeeper to be bypassed](https://docs.brew.sh/Acceptable-Casks).

Signing needs an Apple Developer account (99 USD/year) and these
repository secrets:

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

When they are all present Tauri signs and notarises; when any is absent
it builds unsigned and says so in the log.

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
   `kryptonhq/tap` resolve.
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
