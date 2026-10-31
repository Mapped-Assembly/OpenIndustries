"""Conservative change classification for downstream browser CI.

Only documentation-only commits skip the expensive browser integration. Any unknown,
code, test, fixture, configuration, dependency or workflow file runs the browser.
Missing/unreadable Git history fails open: the browser check runs.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
from typing import Iterable

_SHA = re.compile(r"[0-9a-fA-F]{40}\Z")
_DOC_MEDIA = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pdf", ".mp4"})


def is_documentation_only(path: str) -> bool:
    """Return whether a single changed path cannot affect browser integration."""
    if path.endswith((".md", ".mdx")):
        return True
    if path in {"LICENSE", "COPYING", "NOTICE"}:
        return True
    if path.startswith(".github/ISSUE_TEMPLATE/"):
        return True
    if path.startswith("docs/") and Path(path).suffix.lower() in _DOC_MEDIA:
        return True
    return False


def browser_required(paths: Iterable[str]) -> bool:
    """Run on every non-documentation change, including all shared dependencies."""
    changed = list(paths)
    return not changed or any(not is_documentation_only(path) for path in changed)


def changed_paths(base_sha: str) -> list[str] | None:
    """Diff a known base against checked-out HEAD; return None if history is unavailable."""
    if not _SHA.fullmatch(base_sha) or base_sha == "0" * 40:
        return None
    try:
        result = subprocess.check_output(
            ["git", "diff", "--no-renames", "--name-only", "-z", base_sha, "HEAD"],
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return [path.decode("utf-8", errors="surrogateescape") for path in result.split(b"\0") if path]


def main() -> None:
    """Report the decision through the GitHub Actions step-output file."""
    base = (
        os.environ.get("OI_PR_BASE_SHA", "")
        if os.environ.get("GITHUB_EVENT_NAME") == "pull_request"
        else os.environ.get("OI_PUSH_BEFORE_SHA", "")
    )
    paths = changed_paths(base)
    required = paths is None or browser_required(paths)
    output = "true" if required else "false"
    print(f"Downstream browser: {output} ({'unavailable diff; fail open' if paths is None else str(len(paths)) + ' changed paths'})")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as destination:
            destination.write(f"browser={output}\n")


if __name__ == "__main__":
    main()
