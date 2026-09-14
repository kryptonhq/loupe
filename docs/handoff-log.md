# Handoff log

One entry per feature from the nine-feature handoff: what shipped,
measured numbers for any performance criterion, and deviations from the
handoff document with the reason for each.

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

- **The key itself is not generated or committed.** Generating it and
  setting `LINUX_SIGNING_KEY` / `LINUX_SIGNING_KEY_PASSPHRASE` is a
  maintainer ceremony (RELEASING.md → "The key ceremony"); a key made by
  an agent on a working machine is not a key anyone should trust. Until
  `packaging/linux/loupe-release.asc` is committed, releases stay
  unsigned with a notice in the run. The website branch should merge
  only after that commit, since it links to the file.
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
- **Updater verification** is unaffected by construction — no artifact
  byte changes — but is not re-proven until the next real release; the
  repo has no throwaway-tag path (RELEASING.md, "Testing on a throwaway
  tag does not work yet").
