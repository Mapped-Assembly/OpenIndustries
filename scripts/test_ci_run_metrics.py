"""Unit tests for CI runner-time accounting."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest
from typing import Any

from scripts.ci_run_metrics import summarize_jobs


class RunnerMetricsTests(unittest.TestCase):
    """Count executed jobs and include their entire allocation lifetime."""

    @staticmethod
    def job(**overrides: Any) -> dict[str, Any]:
        """Construct a completed Actions job while allowing one malformed field."""
        return {
            "name": "ubuntu", "status": "completed", "conclusion": "success",
            "started_at": "2026-10-31T20:00:00Z", "completed_at": "2026-10-31T20:01:00Z",
            **overrides,
        }

    def test_overlapping_jobs_and_skipped_job(self) -> None:
        """Runner minutes sum across jobs while wall time measures only their envelope."""
        data = {"jobs": [
            self.job(),
            self.job(name="windows", started_at="2026-10-31T20:00:30Z", completed_at="2026-10-31T20:02:00Z"),
            self.job(name="browser", started_at=None, completed_at=None, conclusion="skipped"),
        ]}
        self.assertEqual(summarize_jobs(data), {
            "visible_jobs": 3, "executed_jobs": 2,
            "successful_jobs": 2, "unsuccessful_jobs": 0, "skipped_jobs": 1,
            "all_jobs_successful": True,
            "aggregate_runner_minutes": 2.5, "wall_clock_minutes": 2.0,
        })

    def test_no_jobs(self) -> None:
        """An in-progress or empty API response must not invent measured runtime."""
        with self.assertRaisesRegex(ValueError, "No jobs"):
            summarize_jobs({"jobs": []})

    def test_timestamped_skipped_job_uses_no_runner(self) -> None:
        """GitHub's skipped-job timestamps must not inflate the execution envelope."""
        result = summarize_jobs({"jobs": [
            self.job(),
            self.job(name="browser", conclusion="skipped", completed_at="2026-10-31T21:00:00Z"),
        ]})
        self.assertEqual(result["executed_jobs"], 1)
        self.assertEqual(result["aggregate_runner_minutes"], 1.0)
        self.assertEqual(result["wall_clock_minutes"], 1.0)

    def test_incomplete_run_is_not_a_performance_result(self) -> None:
        """Completed fast jobs cannot conceal an unfinished long-running job."""
        for status in ("queued", "in_progress", "waiting"):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "not complete"):
                summarize_jobs({"jobs": [self.job(), self.job(
                    name="slow", status=status, conclusion=None, completed_at=None,
                )]})

    def test_missing_timestamps_rejected(self) -> None:
        """A completed non-skipped job requires both endpoints for valid measurement."""
        with self.assertRaisesRegex(ValueError, "Missing execution timestamps"):
            summarize_jobs({"jobs": [self.job(completed_at=None)]})

    def test_partial_page_rejected(self) -> None:
        """Only a full jobs collection can establish run-wide cost and critical path."""
        with self.assertRaisesRegex(ValueError, "every page"):
            summarize_jobs({"total_count": 4, "jobs": [self.job()]})

    def test_failed_and_cancelled_jobs_are_reported(self) -> None:
        """A fast failed run has measurable cost but cannot appear fully successful."""
        for conclusion in ("failure", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion):
                result = summarize_jobs({"jobs": [self.job(), self.job(conclusion=conclusion)]})
                self.assertEqual(result["executed_jobs"], 2)
                self.assertEqual(result["aggregate_runner_minutes"], 2.0)
                self.assertEqual(result["unsuccessful_jobs"], 1)
                self.assertFalse(result["all_jobs_successful"])

    def test_all_skipped_does_not_claim_successful_coverage(self) -> None:
        """An all-skipped collection is not an executed validation run."""
        result = summarize_jobs({"jobs": [self.job(conclusion="skipped")]})
        self.assertEqual(result["executed_jobs"], 0)
        self.assertFalse(result["all_jobs_successful"])

    def test_negative_duration_rejected(self) -> None:
        """Malformed timestamps cannot reduce aggregate runner time."""
        with self.assertRaisesRegex(ValueError, "Negative duration"):
            summarize_jobs({"jobs": [self.job(completed_at="2026-10-31T19:59:59Z")]})

    def test_cli_does_not_emit_partial_metrics(self) -> None:
        """The documented CLI fails visibly and emits no misleading JSON mid-run."""
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("ci_run_metrics.py"))],
            input=json.dumps({"jobs": [self.job(status="in_progress", conclusion=None)]}),
            capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Cannot report completed CI metrics", result.stderr)


if __name__ == "__main__":
    unittest.main()
