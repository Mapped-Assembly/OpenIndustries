"""Summarize actual Actions job runtimes, including checkout/setup/teardown overhead.

Usage: gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs?per_page=100 | python3 scripts/ci_run_metrics.py
"""
from __future__ import annotations

from datetime import datetime
import json
import sys
from typing import Any, Mapping


def to_timestamp(value: str) -> float:
    """Convert an Actions ISO-8601 time into seconds since the epoch."""
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def summarize_jobs(data: Mapping[str, Any]) -> dict[str, float | int]:
    """Measure started jobs and elapsed runner minutes, excluding queue delay."""
    jobs = data.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("Expected GitHub Actions jobs array")
    spans: list[tuple[float, float]] = []
    for job in jobs:
        start, end = job.get("started_at"), job.get("completed_at")
        if not start or not end:
            continue
        a, b = to_timestamp(start), to_timestamp(end)
        if b < a:
            raise ValueError(f"Negative duration for {job.get('name')}")
        spans.append((a, b))
    return {
        "visible_jobs": len(jobs),
        "executed_jobs": len(spans),
        "aggregate_runner_minutes": round(sum(b - a for a, b in spans) / 60, 2),
        "wall_clock_minutes": round((max(b for _, b in spans) - min(a for a, _ in spans)) / 60, 2) if spans else 0.0,
    }


def main() -> None:
    """Read one Actions jobs API response from standard input and print metrics."""
    data = json.load(sys.stdin)
    print(json.dumps(summarize_jobs(data), indent=2))


if __name__ == "__main__":
    main()
