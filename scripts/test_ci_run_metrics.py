"""Unit tests for CI runner-time accounting."""
from __future__ import annotations

import unittest

from scripts.ci_run_metrics import summarize_jobs


class RunnerMetricsTests(unittest.TestCase):
    """Count executed jobs and include their entire allocation lifetime."""

    def test_overlapping_jobs_and_skipped_job(self) -> None:
        """Runner minutes sum across jobs while wall time measures only their envelope."""
        data = {"jobs": [
            {"name": "ubuntu", "started_at": "2026-10-31T20:00:00Z", "completed_at": "2026-10-31T20:01:00Z"},
            {"name": "windows", "started_at": "2026-10-31T20:00:30Z", "completed_at": "2026-10-31T20:02:00Z"},
            {"name": "browser", "started_at": None, "completed_at": None, "conclusion": "skipped"},
        ]}
        self.assertEqual(summarize_jobs(data), {
            "visible_jobs": 3, "executed_jobs": 2,
            "aggregate_runner_minutes": 2.5, "wall_clock_minutes": 2.0,
        })

    def test_no_jobs(self) -> None:
        """An in-progress or empty API response must not invent measured runtime."""
        self.assertEqual(summarize_jobs({"jobs": []}), {
            "visible_jobs": 0, "executed_jobs": 0,
            "aggregate_runner_minutes": 0.0, "wall_clock_minutes": 0.0,
        })


if __name__ == "__main__":
    unittest.main()
