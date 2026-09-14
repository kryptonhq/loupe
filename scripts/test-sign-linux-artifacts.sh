#!/usr/bin/env bash
#
# Exercises sign-linux-artifacts.sh with throwaway keys, so the release
# path is proven on every pull request rather than on the next tag.
#
#   scripts/test-sign-linux-artifacts.sh

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'GNUPGHOME="$work/keys" gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

export GNUPGHOME="$work/keys"
mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"

make_key() { # name passphrase
  gpg --batch --quiet --pinentry-mode loopback --passphrase "$2" \
    --quick-gen-key "$1 <$1@example.invalid>" ed25519 sign never
  local fpr
  fpr="$(gpg --batch --with-colons --list-keys "$1@example.invalid" | awk -F: '$1=="fpr"{print $10; exit}')"
  gpg --batch --armor --export "$fpr" > "$work/$1.pub.asc"
  gpg --batch --armor --pinentry-mode loopback --passphrase "$2" \
    --export-secret-keys "$fpr" > "$work/$1.sec.asc"
}
make_key release hunter2
make_key impostor hunter2
unset GNUPGHOME

bundle="$work/bundle"
mkdir -p "$bundle"/{appimage,deb,rpm}
echo appimage > "$bundle/appimage/Loupe_0.0.0_amd64.AppImage"
echo deb > "$bundle/deb/Loupe_0.0.0_amd64.deb"
echo rpm > "$bundle/rpm/Loupe-0.0.0-1.x86_64.rpm"

fail() { echo "FAIL: $*" >&2; exit 1; }
sign() { # secret-key-file [bundle]
  LINUX_SIGNING_KEY="$(cat "$1")" LINUX_SIGNING_KEY_PASSPHRASE=hunter2 \
    PUBLIC_KEY="$work/release.pub.asc" \
    "$here/sign-linux-artifacts.sh" "${2:-$bundle}"
}

# 1. The happy path: three signatures, each verifying with only the
#    public key — the position a user downloading the release is in.
out="$(sign "$work/release.sec.asc")"
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 3 ] || fail "expected 3 signatures, got: $out"
user="$work/user" && mkdir -p "$user" && chmod 700 "$user"
gpg --homedir "$user" --batch --quiet --import "$work/release.pub.asc" 2>/dev/null
for f in "$bundle"/*/*; do
  case "$f" in *.asc) continue ;; esac
  gpg --homedir "$user" --batch --quiet --verify "$f.asc" "$f" 2>/dev/null || fail "$f does not verify"
done
GNUPGHOME="$user" gpgconf --kill all >/dev/null 2>&1 || true
echo "ok: signs and verifies all three formats"

# 2. A tampered artifact must not verify.
echo tampered >> "$bundle/deb/Loupe_0.0.0_amd64.deb"
if gpg --homedir "$user" --batch --quiet --verify "$bundle/deb/Loupe_0.0.0_amd64.deb.asc" "$bundle/deb/Loupe_0.0.0_amd64.deb" 2>/dev/null; then
  fail "tampered artifact verified"
fi
echo "ok: a modified artifact fails verification"

# 3. A secret that is not the published key is refused before signing.
expect_refusal() { # reason command...
  local reason="$1" out
  shift
  if out="$("$@" 2>&1)"; then fail "succeeded, expected: $reason"; fi
  printf '%s' "$out" | grep -q "$reason" || fail "failed for the wrong reason: $out"
}
expect_refusal "is not the published key" sign "$work/impostor.sec.asc"
echo "ok: refuses a key that does not match the published one"

# 4. A missing format is a failure, not a partial release.
rm "$bundle"/rpm/*
expect_refusal "no artifact matching" sign "$work/release.sec.asc"
echo "ok: refuses a bundle missing a format"

# 5. No key at all is a failure.
expect_refusal "LINUX_SIGNING_KEY is empty" \
  env LINUX_SIGNING_KEY="" PUBLIC_KEY="$work/release.pub.asc" "$here/sign-linux-artifacts.sh" "$bundle"
echo "ok: refuses to run without a key"
