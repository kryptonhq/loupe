#!/usr/bin/env bash
#
# Makes a detached, ASCII-armoured GPG signature beside every Linux
# installer, and proves each one verifies against the public key this
# repository publishes before anything is uploaded.
#
#   LINUX_SIGNING_KEY="$(cat private.asc)" \
#   LINUX_SIGNING_KEY_PASSPHRASE=... \
#     scripts/sign-linux-artifacts.sh src-tauri/target/release/bundle
#
# Prints the paths of the signatures it wrote, one per line, so the
# caller can upload exactly those.
#
# Detached rather than embedded, deliberately. `rpmsign --addsign`,
# `dpkg-sig` and `appimagetool --sign` all rewrite the file they sign —
# and by the time this runs the installer has already been uploaded, and
# the AppImage already carries an updater signature over its exact
# bytes. Changing a byte would invalidate the one and orphan the other.
#
# Every failure is fatal. A release with a missing signature is the thing
# this exists to prevent, so there is no "sign what you can" mode.

set -euo pipefail

BUNDLE="${1:?usage: sign-linux-artifacts.sh <bundle dir>}"
: "${LINUX_SIGNING_KEY:?LINUX_SIGNING_KEY is empty — the public key is published, so releases must be signed}"
PUBLIC_KEY="${PUBLIC_KEY:-$(dirname "$0")/../packaging/linux/loupe-release.asc}"

if [ ! -f "$PUBLIC_KEY" ]; then
  echo "error: no public key at $PUBLIC_KEY" >&2
  exit 1
fi

# Two throwaway keyrings. The signing one holds the secret key; the
# verifying one holds *only* the committed public key, which is what
# users will have. Verifying against the signing keyring would pass even
# if the secret were a different key from the one we publish.
GNUPGHOME="$(mktemp -d)"
VERIFY_HOME="$(mktemp -d)"
export GNUPGHOME
chmod 700 "$GNUPGHOME" "$VERIFY_HOME"
trap 'gpgconf --kill all >/dev/null 2>&1 || true; GNUPGHOME="$VERIFY_HOME" gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME" "$VERIFY_HOME"' EXIT

printf '%s\n' "$LINUX_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null
gpg --homedir "$VERIFY_HOME" --batch --quiet --import "$PUBLIC_KEY" 2>/dev/null

# Fingerprints, not key IDs: a short ID collides by construction.
fingerprint() {
  gpg "$@" --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}'
}
signing_fpr="$(fingerprint)"
published_fpr="$(fingerprint --homedir "$VERIFY_HOME")"

if [ -z "$signing_fpr" ] || [ "$signing_fpr" != "$published_fpr" ]; then
  echo "error: the signing key ($signing_fpr) is not the published key ($published_fpr)" >&2
  exit 1
fi

shopt -s nullglob
artifacts=("$BUNDLE"/appimage/*.AppImage "$BUNDLE"/deb/*.deb "$BUNDLE"/rpm/*.rpm)

# One of each, or the build did not produce what the release promises.
for pattern in '\.AppImage$' '\.deb$' '\.rpm$'; do
  if ! printf '%s\n' "${artifacts[@]}" | grep -qE "$pattern"; then
    echo "error: no artifact matching $pattern under $BUNDLE" >&2
    exit 1
  fi
done

for file in "${artifacts[@]}"; do
  gpg --batch --yes --quiet --pinentry-mode loopback \
    --passphrase "${LINUX_SIGNING_KEY_PASSPHRASE:-}" \
    --local-user "$signing_fpr" \
    --armor --detach-sign --output "$file.asc" "$file"

  gpg --homedir "$VERIFY_HOME" --batch --quiet --verify "$file.asc" "$file" 2>/dev/null || {
    echo "error: $file.asc does not verify against $PUBLIC_KEY" >&2
    exit 1
  }
  echo "$file.asc"
done
