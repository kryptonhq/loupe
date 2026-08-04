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

**Ad-hoc signed**, which is what the release workflow falls back to when
no certificate is configured, the bundle carries a valid signature and
the hardened runtime. Gatekeeper still refuses it — there is no
notarisation — but for the reason it actually is, and the user gets the
normal "Open Anyway" path in Privacy & Security. This costs nothing.
v0.1.0 and v0.1.1 shipped in this state.

**Signed and notarised** is the only state where the app opens on a
double-click, and the only one homebrew/cask would accept, since a cask
there
[must not require Gatekeeper to be bypassed](https://docs.brew.sh/Acceptable-Casks).
**This is where releases are from v0.1.2 onward.** `spctl` reports
`accepted` with `source=Notarized Developer ID`, and the ticket is
stapled, so approval does not depend on the machine being able to reach
Apple.

Getting there needs an Apple Developer account (99 USD/year) and these
repository secrets. They are all-or-nothing: a partial set makes Tauri
attempt a notarisation it cannot complete — and because an unset secret
is still a *defined* environment variable, a partial set fails after
building all four platforms rather than in the first ten seconds.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12`, base64 encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | The Apple ID used for notarisation |
| `APPLE_PASSWORD` | An app-specific password, not the account password |
| `APPLE_TEAM_ID` | The 10-character team identifier |

#### Getting them

The fiddly part is the export: the obvious path in Keychain Access
produces a certificate **without its private key**, which signs nothing
and fails with an error that does not say so.

1. **Make a signing request.** Keychain Access → Certificate Assistant →
   *Request a Certificate From a Certificate Authority*. Enter your
   email, choose **Saved to disk**, and keep the `.certSigningRequest`.

2. **Create the certificate.** [developer.apple.com](https://developer.apple.com/account/resources/certificates/list)
   → Certificates → **+** → **Developer ID Application** (not "Apple
   Distribution", which is the App Store one). Upload the request,
   download the `.cer`, and double-click it to install.

3. **Export it *with* the key.** In Keychain Access, open **My
   Certificates** — not the Certificates category — and find
   `Developer ID Application: <name> (TEAMID)`. It must have a
   disclosure triangle with a private key under it. Right-click →
   *Export* → `.p12`, and set a password.

   If it is not under My Certificates, the private key is on whichever
   Mac generated the request in step 1.

4. **Encode it.**

   ```bash
   base64 -i DeveloperID.p12 | pbcopy      # -> APPLE_CERTIFICATE
   ```

   The password you just set is `APPLE_CERTIFICATE_PASSWORD`.

5. **Read the identity string exactly.** Copying it by eye from the
   portal is how people end up with a trailing space:

   ```bash
   security find-identity -v -p codesigning   # -> APPLE_SIGNING_IDENTITY
   ```

6. **Team ID** is on the [membership page](https://developer.apple.com/account)
   — ten characters, and also the parenthesised part of the identity
   string above.

7. **App-specific password** for notarisation, from
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security
   → App-Specific Passwords. Not your Apple ID password, which will not
   work.

An App Store Connect API key is the more durable alternative to steps 6
and 7 — it survives password rotations and 2FA changes, which an
app-specific password does not. Worth switching to if the notarisation
step starts failing after an account change.

When they are all present Tauri signs with the real identity and
notarises; otherwise it ad-hoc signs.

The workflow chooses between those with two separate build steps rather
than one step and a fallback value. An unset secret is still a *defined*
environment variable — the empty string, not absent — and Tauri reads a
defined `APPLE_CERTIFICATE` as "there is a certificate to import", then
fails on `security import` with nothing to import. The certificate
variables therefore only exist when there is a certificate.

### Windows

Unsigned installers work, but SmartScreen warns until the binary has
built up reputation — which for a low-volume download effectively means
always. Worse on Windows 11, where Smart App Control blocks unsigned
executables outright rather than offering a way through.

Signing needs a certificate and a `bundle.windows.signCommand` in
`tauri.conf.json`. Nothing here is set up yet; the options, cheapest
first:

| Option | Cost | Hardware token |
| --- | --- | --- |
| [SignPath Foundation](https://signpath.org/) | free for OSS | no |
| [Certum Open Source](https://shop.certum.eu/code-signing.html) | ~€69 first year, ~€29 after | yes |
| [Azure Artifact Signing](https://azure.microsoft.com/en-us/products/artifact-signing) | ~$10/month | no |

Do not pay for EV. Microsoft
[removed the behaviour](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
that made an EV certificate grant instant SmartScreen reputation, so it
now behaves exactly like OV and costs several times more.

Note that signing does not remove the warning the way notarisation does
on macOS. It attaches a publisher name to it and lets reputation
accumulate across releases, which unsigned builds cannot do at all —
every new binary starts from zero.

SignPath is the one to try first, since Loupe qualifies on licence and
repository. Its condition worth knowing in advance is that each release
needs manual approval before signing, which the current tag-triggered
pipeline does not have a step for.

## Homebrew

```bash
brew install --cask kryptonhq/tap/loupe
```

From v0.1.2 the builds are notarised, so this installs an app that
opens on a double-click. No `--no-quarantine`, and nothing to allow in
System Settings.

The cask carried a `caveats` block explaining how to get past Gatekeeper
for as long as that was true, and it is gone now that it is not. It
never grew the `postflight` that would have stripped the quarantine
attribute silently: removing a security attribute on someone's behalf,
without them asking, is not a decision an installer should make quietly
— and the fix for "Gatekeeper refuses this" was always to earn its
approval rather than to route around it.

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

   Nothing needs to be committed to it — the first release creates the
   branch and `Casks/loupe.rb`. A README is worth adding so the
   repository is not blank to anyone who lands on it.

2. Create the token at
   **[Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)**:

   | Field | Value |
   | --- | --- |
   | Resource owner | `kryptonhq` — the organisation, *not* your personal account |
   | Repository access | Only select repositories → `homebrew-tap` |
   | Repository permissions | **Contents: Read and write** |
   | Expiration | Whatever you will remember to rotate |

   Two things catch people out. The resource owner must be the
   organisation, or the token is issued against your personal account
   and cannot see an org repository at all. And organisations can block
   fine-grained tokens entirely — if the token appears to have no
   access, check **Organisation settings → Personal access tokens** and
   allow them.

   A [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
   on the tap with write access is the alternative worth knowing about:
   it never expires and belongs to the repository rather than to a
   person, so it does not break when someone leaves. It needs the script
   switched to SSH, which is a small change if the expiry becomes
   annoying.

3. Add the token to **this** repository as the `HOMEBREW_TAP_TOKEN`
   secret (Settings → Secrets and variables → Actions).

The token is only used to push to the tap. Reading this repository's
release assets uses the workflow's own `GITHUB_TOKEN`, so the tap token
never needs access here.

The release workflow then renders
[`packaging/homebrew/loupe.rb.template`](packaging/homebrew/loupe.rb.template)
with the published DMGs' checksums and pushes it to `Casks/loupe.rb`.
Without the secret that job logs a notice and skips, so releases work
before the tap exists.

Checksums are taken from the uploaded artifacts rather than from a local
build, so what the cask claims is what people actually download.

## Checking a signed release

Run this against a published DMG whenever the signing configuration
changes — a renewed certificate, a rotated app-specific password, a
Tauri upgrade that moves the notarisation step.

```bash
gh release download vX.Y.Z --repo kryptonhq/loupe --pattern '*aarch64.dmg'
hdiutil attach -nobrowse Loupe_X.Y.Z_aarch64.dmg -mountpoint /tmp/loupe

# Authority should name the Developer ID, and the flags should say
# "runtime" — an "adhoc" in either means the certificate path did not run.
codesign -dv --verbose=2 /tmp/loupe/Loupe.app
# The verdict that matters. Want: accepted, source=Notarized Developer ID.
spctl -a -vvv /tmp/loupe/Loupe.app
# The ticket is stapled, so approval does not need to reach Apple.
xcrun stapler validate /tmp/loupe/Loupe.app

hdiutil detach /tmp/loupe
```

Do both architectures. They are separate builds and notarised
separately, so one can succeed while the other does not.

### Testing on a throwaway tag does not work yet

The obvious way to rehearse a change would be a tag nobody is watching,
and there is no supported way to do that today. Two things are in the
way, and both are worth fixing before anyone needs it:

- The `version` job requires the manifests to match the tag, and
  `scripts/version.py --set` only accepts plain `X.Y.Z` — so a
  pre-release tag like `v0.0.2-test` cannot be made to pass.
- Nothing excludes a test tag from `publish` or `homebrew`. A run that
  *succeeded* would publish a public release and repoint the tap's cask
  at the test version, breaking `brew install` for everyone.

So changes to the signing path currently get proven by cutting a real
release and relying on the containment that already exists: `publish`
needs all four builds to succeed, so a notarisation failure leaves a
draft and an untouched tap rather than anything public.

## Not done yet

- **Auto-update.** Tauri ships an updater; it needs a signing key pair
  and an update manifest published alongside the release. Worth having
  before there are enough users that "download the new DMG" stops being
  reasonable.
- **Linux repositories.** The `.deb` is a direct download, not an apt
  repository. AppImage covers most of the gap.
- **`homebrew/cask` submission**, once the notability bar is met.
