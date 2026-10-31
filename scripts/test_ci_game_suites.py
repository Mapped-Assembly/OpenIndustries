"""Verify CI suite ownership and the installed concurrent runner's failure behavior.

Run after ``npm ci``. Tiny Node processes replace the expensive suites, while the
actual package-script options and installed concurrently executable are retained.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
UBUNTU_SUITES = {
    "materials", "simulation", "mcp-game", "mcp", "manufacturing", "units", "combat", "victory",
}
WINDOWS_SUITES = {"materials", "simulation", "mcp-game", "mcp", "manufacturing"}


def suite_command(profile: str) -> tuple[list[str], list[str]]:
    """Split an existing npm CI script into its runner options and suite commands."""
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    words = shlex.split(scripts[f"ci:game:{profile}"])
    if not words or words[0] != "concurrently":
        raise AssertionError("Game CI must use the existing concurrently executable")
    first_command = next(index for index, word in enumerate(words) if word.startswith("npm run "))
    return words[1:first_command], words[first_command:]


class GameSuiteTests(unittest.TestCase):
    """Protect coverage, bounded execution, useful output and aggregate failures."""

    def test_full_ubuntu_and_focused_windows_inventory(self) -> None:
        """Keep every original Ubuntu suite and explicitly own the Windows subset."""
        for profile, expected in [("ubuntu", UBUNTU_SUITES), ("windows", WINDOWS_SUITES)]:
            with self.subTest(profile=profile):
                _, commands = suite_command(profile)
                self.assertEqual(set(commands), {f"npm run test:{suite}" for suite in expected})
                self.assertEqual(len(commands), len(expected), "Do not run duplicate suites")
        self.assertEqual(UBUNTU_SUITES - WINDOWS_SUITES, {"units", "combat", "victory"})

    def test_bounded_named_runner_options(self) -> None:
        """Bound CPU contention and keep per-suite labels, timing and failure status."""
        for profile in ("ubuntu", "windows"):
            with self.subTest(profile=profile):
                options, commands = suite_command(profile)
                names = [command.removeprefix("npm run test:") for command in commands]
                self.assertEqual(options, [
                    "--max-processes", "2", "--success", "all", "--timings", "--no-color",
                    "--names", ",".join(names),
                ])

    def test_workflow_wiring_preserves_coverage_and_fail_open(self) -> None:
        """Guard the reviewed workflow contract without adding a YAML dependency."""
        runtime = (ROOT / ".github/workflows/game-runtime.yml").read_text(encoding="utf-8")
        full = (ROOT / ".github/workflows/game-runtime-windows-full.yml").read_text(encoding="utf-8")

        def job_block(workflow: str, name: str) -> str:
            """Locate one current-format job; actionlint validates complete YAML syntax."""
            match = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  \S|\Z)", workflow)
            self.assertIsNotNone(match, f"Missing coverage-owning job {name}")
            assert match is not None
            return match.group(1)

        browser = job_block(runtime, "downstream-browser")
        condition = (
            "    if: ${{ !cancelled() && (needs.changes.result != 'success' "
            "|| needs.changes.outputs.browser != 'false') }}"
        )
        self.assertIn(condition, browser.splitlines())
        self.assertIn("    needs: changes", browser.splitlines())
        self.assertRegex(runtime, r"(?m)^  pull_request:\s*$")
        self.assertNotRegex(runtime, r"(?m)^    paths(?:-ignore)?:")
        self.assertIn("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}", runtime.splitlines())
        self.assertIn("  group: game-runtime-${{ github.event.pull_request.number || github.ref }}", runtime.splitlines())

        for name, profile, runner in [
            ("ubuntu-suite", "ubuntu", "ubuntu-latest"),
            ("windows-compat", "windows", "windows-latest"),
        ]:
            block = job_block(runtime, name)
            self.assertIn(f"    runs-on: {runner}", block.splitlines())
            self.assertIn(f"        run: npm run ci:game:{profile}", block.splitlines())
            self.assertIn("          cache: npm", block.splitlines())

        self.assertRegex(full, r"(?m)^  schedule:\s*$")
        self.assertIn("    - cron: '23 7 * * 1'", full.splitlines())
        self.assertRegex(full, r"(?m)^  workflow_dispatch:\s*$")
        full_job = job_block(full, "windows-full")
        self.assertIn("    runs-on: windows-latest", full_job.splitlines())
        self.assertIn("        run: npm run ci:game:ubuntu", full_job.splitlines())
        self.assertIn("          cache: npm", full_job.splitlines())

    def run_fixture(self, profile: str, failure: bool) -> subprocess.CompletedProcess[str]:
        """Run the exact configured options with short, isolated Node child fixtures."""
        node = shutil.which("node")
        self.assertIsNotNone(node, "Install Node before running CI suite regressions")
        runner = ROOT / "node_modules/concurrently/dist/bin/concurrently.js"
        self.assertTrue(runner.is_file(), "Run npm ci before CI suite regressions")
        options, commands = suite_command(profile)
        names = [command.removeprefix("npm run test:") for command in commands]
        with tempfile.TemporaryDirectory(prefix="oi-ci-suites-") as directory:
            fixture = Path(directory) / "suite.cjs"
            fixture.write_text(
                "const [name, exitCode] = process.argv.slice(2);\n"
                "console.log('CI_FIXTURE_START ' + name);\n"
                "setTimeout(() => {\n"
                "  console.log('CI_FIXTURE_END ' + name);\n"
                "  process.exit(Number(exitCode));\n"
                "}, 250);\n",
                encoding="utf-8",
            )
            # Both POSIX sh and Windows cmd accept double-quoted executable/file paths.
            replacements = [
                f'"{node}" "{fixture}" {name} {23 if failure and index == 0 else 0}'
                for index, name in enumerate(names)
            ]
            return subprocess.run(
                [str(node), str(runner), *options, *replacements],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=30, check=False,
            )

    def assert_complete_execution(self, profile: str, output: str) -> None:
        """Check every child completed, at most two overlapped, and logs identify suites."""
        _, commands = suite_command(profile)
        expected = {command.removeprefix("npm run test:") for command in commands}
        active: set[str] = set()
        started: set[str] = set()
        completed: set[str] = set()
        for line in output.splitlines():
            event = re.search(r"CI_FIXTURE_(START|END) ([\w-]+)$", line)
            if event is None:
                continue
            kind, name = event.groups()
            self.assertIn(f"[{name}]", line, "Output must name the failing suite")
            if kind == "START":
                self.assertNotIn(name, started)
                started.add(name)
                active.add(name)
                self.assertLessEqual(len(active), 2, output)
            else:
                self.assertIn(name, active)
                active.remove(name)
                completed.add(name)
        self.assertEqual(started, expected, output)
        self.assertEqual(completed, expected, output)
        self.assertFalse(active, output)
        self.assertIn("Timings:", output, "The runner must emit a timing report")
        self.assertIn("duration", output)
        self.assertNotIn("\x1b[", output, "CI logs must be readable without ANSI colors")

    def test_failure_propagates_without_cancelling_remaining_suites(self) -> None:
        """An early failing suite fails CI after every queued suite has reported."""
        for profile in ("ubuntu", "windows"):
            with self.subTest(profile=profile):
                result = self.run_fixture(profile, failure=True)
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assert_complete_execution(profile, output)
                self.assertIn("exited with code 23", output)

    def test_all_successful_suites_pass(self) -> None:
        """Successful children make both actual CI runner commands succeed."""
        for profile in ("ubuntu", "windows"):
            with self.subTest(profile=profile):
                result = self.run_fixture(profile, failure=False)
                output = result.stdout + result.stderr
                self.assertEqual(result.returncode, 0, output)
                self.assert_complete_execution(profile, output)


if __name__ == "__main__":
    unittest.main()
