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


def summarize_jobs(data: Mapping[str, Any]) -> dict[str, float | int | bool]:
    """Measure a complete jobs response without treating partial runs as wins.

    These are elapsed allocation minutes, not billable minutes or currency.
    Conclusions are reported separately: timing a failed run does not validate it.
    """
    if not isinstance(data, Mapping):
        raise ValueError("Expected a GitHub Actions jobs response object")
    jobs = data.get("jobs", [])
    if not isinstance(jobs, list):
        raise ValueError("Expected GitHub Actions jobs array")
    if not jobs:
        raise ValueError("No jobs returned; completed run metrics are unavailable")
    if data.get("total_count", len(jobs)) != len(jobs):
        raise ValueError("Incomplete jobs response; fetch every page before measuring")
    spans: list[tuple[float, float]] = []
    successful = unsuccessful = skipped = 0
    for job in jobs:
        if not isinstance(job, Mapping):
            raise ValueError("Expected a GitHub Actions job object")
        if job.get("status") != "completed" or not job.get("conclusion"):
            raise ValueError(f"Job is not complete: {job.get('name')}")
        if job["conclusion"] == "skipped":
            # GitHub can supply timestamps for skipped jobs without allocating a
            # runner. Counting those would inflate cost and wall-clock duration.
            skipped += 1
            continue
        start, end = job.get("started_at"), job.get("completed_at")
        if not start or not end:
            raise ValueError(f"Missing execution timestamps for {job.get('name')}")
        a, b = to_timestamp(start), to_timestamp(end)
        if b < a:
            raise ValueError(f"Negative duration for {job.get('name')}")
        spans.append((a, b))
        if job["conclusion"] == "success":
            successful += 1
        else:
            unsuccessful += 1
    return {
        "visible_jobs": len(jobs),
        "executed_jobs": len(spans),
        "successful_jobs": successful,
        "unsuccessful_jobs": unsuccessful,
        "skipped_jobs": skipped,
        "all_jobs_successful": unsuccessful == 0 and successful > 0,
        "aggregate_runner_minutes": round(sum(b - a for a, b in spans) / 60, 2),
        "wall_clock_minutes": round((max(b for _, b in spans) - min(a for a, _ in spans)) / 60, 2) if spans else 0.0,
    }


def main() -> None:
    """Read one Actions jobs API response from standard input and print metrics."""
    try:
        data = json.load(sys.stdin)
        summary = summarize_jobs(data)
    except (ValueError, TypeError) as error:
        raise SystemExit(f"Cannot report completed CI metrics: {error}") from error
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
