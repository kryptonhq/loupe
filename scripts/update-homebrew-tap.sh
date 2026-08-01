#!/usr/bin/env bash
#
# Renders the Homebrew cask for a published release and pushes it to the
# tap repository.
#
# Run by the release workflow after the GitHub release goes public,
# because the checksums have to come from the artifacts people will
# actually download — computing them from a local build would let a
# re-upload drift from what the cask claims.
#
#   VERSION=0.2.0 TAG=v0.2.0 GH_TOKEN=... scripts/update-homebrew-tap.sh
#
# GH_TOKEN needs `contents: write` on the tap repository only.

set -euo pipefail

: "${VERSION:?set VERSION, e.g. 0.2.0}"
: "${TAG:?set TAG, e.g. v0.2.0}"
: "${GH_TOKEN:?set GH_TOKEN with write access to the tap}"

REPO="${REPO:-kryptonhq/loupe}"
TAP_REPO="${TAP_REPO:-kryptonhq/homebrew-tap}"
TEMPLATE="$(dirname "$0")/../packaging/homebrew/loupe.rb.template"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Tauri names macOS bundles "<product>_<version>_<arch>.dmg".
arm_dmg="Loupe_${VERSION}_aarch64.dmg"
intel_dmg="Loupe_${VERSION}_x64.dmg"

echo "downloading release assets for $TAG"
gh release download "$TAG" --repo "$REPO" --dir "$work" \
  --pattern "$arm_dmg" --pattern "$intel_dmg"

sha_arm="$(shasum -a 256 "$work/$arm_dmg" | cut -d' ' -f1)"
sha_intel="$(shasum -a 256 "$work/$intel_dmg" | cut -d' ' -f1)"

echo "  $arm_dmg   $sha_arm"
echo "  $intel_dmg $sha_intel"

sed \
  -e "s|__VERSION__|${VERSION}|g" \
  -e "s|__SHA256_ARM__|${sha_arm}|g" \
  -e "s|__SHA256_INTEL__|${sha_intel}|g" \
  "$TEMPLATE" > "$work/loupe.rb"

# Fail loudly rather than pushing a cask with an unsubstituted
# placeholder, which Homebrew would accept and then fail to install.
if grep -q "__" "$work/loupe.rb"; then
  echo "error: unsubstituted placeholder in the rendered cask" >&2
  grep -n "__" "$work/loupe.rb" >&2
  exit 1
fi

echo "cloning $TAP_REPO"
git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${TAP_REPO}.git" "$work/tap"

mkdir -p "$work/tap/Casks"
cp "$work/loupe.rb" "$work/tap/Casks/loupe.rb"

cd "$work/tap"
if git diff --quiet; then
  echo "cask already up to date at $VERSION"
  exit 0
fi

git config user.name "loupe-release"
git config user.email "noreply@krypton.ai"
git add Casks/loupe.rb
git commit -m "loupe ${VERSION}"
git push

echo "tap updated to $VERSION"
