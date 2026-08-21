#!/usr/bin/env python3
"""Pull one version's section out of CHANGELOG.md.

The release workflow seeds the GitHub release body with this. Without it
the body is whatever `generate_release_notes` produces, which is a list
of merged pull request titles — accurate, and not something anyone wants
to read to find out whether it is worth updating.

    scripts/release-notes.py v0.1.5    # print that section
    scripts/release-notes.py v9.9.9    # exit 1, nothing printed

Exits non-zero when there is no section, so the caller can fall back
rather than publishing an empty body.
"""

from __future__ import annotations

import pathlib
import re
import sys

CHANGELOG = pathlib.Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def section(text: str, version: str) -> str | None:
    """The body under `## [version]`, up to the next `## ` heading."""
    # Tolerates both `## [0.1.5] - date` and `## 0.1.5`, and a tag that
    # arrives with or without its leading v.
    wanted = version.lstrip("v")
    pattern = re.compile(
        r"^##\s+\[?" + re.escape(wanted) + r"\]?.*?$(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    found = pattern.search(text)
    if not found:
        return None
    body = found.group(1).strip()
    return body or None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    if not CHANGELOG.exists():
        print(f"no {CHANGELOG.name}", file=sys.stderr)
        return 1

    body = section(CHANGELOG.read_text(), sys.argv[1])
    if body is None:
        print(f"no section for {sys.argv[1]} in {CHANGELOG.name}", file=sys.stderr)
        return 1

    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
