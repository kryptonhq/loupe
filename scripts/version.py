#!/usr/bin/env python3
"""Keep the version in step across the three files that carry it.

`package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` each
hold their own copy, and only the last one decides what the installer is
called. A release built from mismatched manifests produces a DMG whose
name disagrees with its tag, which is the sort of thing nobody notices
until a Homebrew cask 404s.

    scripts/version.py                 # print the current version
    scripts/version.py --set 0.2.0     # rewrite all three
    scripts/version.py --check v0.2.0  # assert they match a git tag
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

PACKAGE_JSON = ROOT / "package.json"
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
TAURI_CONF = ROOT / "src-tauri" / "tauri.conf.json"

# A release version, no pre-release suffix: Cargo, npm and Tauri each
# accept slightly different shapes, and the intersection is plain semver.
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def read_json(path: pathlib.Path) -> str:
    return json.loads(path.read_text())["version"]


def read_cargo() -> str:
    # Only the first `version =` — the dependency table has its own, and
    # a regex that matches those would rewrite the wrong line.
    for line in CARGO_TOML.read_text().splitlines():
        match = re.match(r'^version\s*=\s*"([^"]+)"', line)
        if match:
            return match.group(1)
    raise SystemExit(f"no version in {CARGO_TOML}")


def current() -> dict[str, str]:
    return {
        str(PACKAGE_JSON.relative_to(ROOT)): read_json(PACKAGE_JSON),
        str(CARGO_TOML.relative_to(ROOT)): read_cargo(),
        str(TAURI_CONF.relative_to(ROOT)): read_json(TAURI_CONF),
    }


def set_version(version: str) -> None:
    if not SEMVER.match(version):
        raise SystemExit(f"not a release version: {version} (expected X.Y.Z)")

    for path in (PACKAGE_JSON, TAURI_CONF):
        data = json.loads(path.read_text())
        data["version"] = version
        # Two spaces and a trailing newline, which is what both files
        # already use — a formatting-only diff hides the real change.
        path.write_text(json.dumps(data, indent=2) + "\n")

    lines = CARGO_TOML.read_text().splitlines(keepends=True)
    for i, line in enumerate(lines):
        if re.match(r'^version\s*=\s*"', line):
            lines[i] = f'version = "{version}"\n'
            break
    CARGO_TOML.write_text("".join(lines))

    print(f"set {version} in {len(current())} files")


def check(tag: str) -> None:
    """Assert every manifest matches the tag, which is what CI runs."""
    expected = tag[1:] if tag.startswith("v") else tag
    found = current()

    mismatched = {p: v for p, v in found.items() if v != expected}
    if mismatched:
        print(f"tag {tag} expects version {expected}, but:")
        for path, version in sorted(mismatched.items()):
            print(f"  {path}: {version}")
        print("\nrun: scripts/version.py --set " + expected)
        raise SystemExit(1)

    print(f"all manifests agree on {expected}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--set", metavar="X.Y.Z", help="rewrite every manifest")
    group.add_argument("--check", metavar="TAG", help="assert they match a tag")
    args = parser.parse_args()

    if args.set:
        set_version(args.set)
    elif args.check:
        check(args.check)
    else:
        versions = set(current().values())
        if len(versions) != 1:
            for path, version in sorted(current().items()):
                print(f"{path}: {version}", file=sys.stderr)
            raise SystemExit("manifests disagree")
        print(versions.pop())


if __name__ == "__main__":
    main()
