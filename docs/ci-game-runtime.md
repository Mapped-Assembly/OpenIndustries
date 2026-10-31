# Game runtime CI consolidation (#68)

The Game runtime workflow covers Node/TypeScript tests, **not a Python test matrix**. Python coverage remains owned by the separate FIELD-LAB and related workflows. This refactor changes only the duplicated five-subsystem × two-OS *Game runtime* fan-out; it does not merge or remove unrelated workflow checks.

## PR check topology

| Job / stable check name | Runner | Coverage |
| --- | --- | --- |
| `Browser change detection` | Ubuntu | Pure-stdlib change-filter regression tests and conservative git diff; output used by browser job |
| `Ubuntu suite` | Ubuntu | All original Linux material build + diff verification, materials, simulation, game/MCP, manufacturing, units, combat, and victory tests |
| `Windows compatibility` | Windows | **All original Windows commands retained**, including native SQLite, subprocess/restart, materials, simulation, game/MCP, manufacturing, units, combat and victory; no Windows tests have moved out of PR CI |
| `downstream-browser` | Ubuntu, conditional | Unchanged pinned tower-defense integration, desktop/mobile browser results/full-match coverage and evidence upload |

Each suite has its own named step inside the consolidated OS job; any failed step fails its job. A single `npm ci` and cached Node setup per OS replaces five separate checkouts/installations. The game/browser jobs run alongside each other; only the browser job depends on fast change detection. Superseded **PR** runs cancel; push-to-main validation is not automatically canceled.

The browser check runs on **any non-documentation change**, rather than a fragile list of known frontend paths. This includes `src/`, `server/`, `scripts/`, `tests/`, `packages/`, `public/`, `services/`, fixtures, lockfiles, configuration and all workflows. Only Markdown/prose, license/issue templates, or documentation-media-only changes skip it. Missing base history or an empty change list **fails open** (browser runs). `scripts/test_ci_browser_changes.py` guards this behavior.

GitHub Actions reports a deliberately skipped `downstream-browser` check as a successful skipped job for branch protection; it does not vanish as an unreported workflow due to workflow-level path filters.

## Before/after evidence

**Before:** [Game runtime run #128](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41231502401) on PR #66, October 31, 2026. Eleven executed jobs (five suites × two OS, plus browser) finished successfully.

| Metric | Before (#128) | After (first completed #68 PR run) |
| --- | ---: | ---: |
| Visible jobs | 11 | **4 configured** (3 when browser is skipped, plus skipped-check entry) |
| Aggregate runner time (including setup/checkout/teardown) | 91.42 min | Pending live run |
| Wall-clock time (first job start → last job finish) | 24.85 min | Pending live run |

Baseline job breakdown: five Ubuntu jobs **26.97 min**, five Windows jobs **43.52 min**, downstream browser **20.93 min** (minor differences from rounding). This consolidation reduces repeated runner setups but **may increase wall-clock latency** because previously parallel OS suite jobs now run sequentially. Measure both runner cost and latency before treating the optimization as a win. The older split was runtime-parallelized; the new full Windows suite therefore has a longer explicit timeout.

Reproduce after CI completes, using the built-in GitHub CLI on WSL2 or any supported shell (replace the run ID):

```bash
gh api 'repos/Mapped-Assembly/OpenIndustries/actions/runs/RUN_ID/jobs?per_page=100' | python3 scripts/ci_run_metrics.py
```

The script counts only started jobs for runner-time totals but includes skipped job entries in the visible count. This measures job start→completion, including runner initialization and post-step cleanup; it excludes time queued waiting for a runner. On a documentation-only PR the browser appears as skipped and contributes zero runtime.

## Required-check migration and limits

The previous matrix emitted `mcp (ubuntu-latest)`, `mcp (windows-latest)`, `manufacturing (...)`, `units (...)`, `combat (...)` and `victory (...)`. Those checks are replaced by **`Ubuntu suite`** and **`Windows compatibility`**; **`downstream-browser`** remains. The filter check is named **`Browser change detection`**. A repository administrator must inspect branch protection/rulesets and update any required-check names to the new check set *before enforcing the change*. Branch-protection reads through the linked GitHub integration returned HTTP 403, so current policy cannot be verified or changed from this integration. This task must remain documented as an administrative follow-up, not silently assumed complete.

Other workflows (`Scene authoring`, `FIELD-LAB-01 benchmark`, `Local persistent runtime`, etc.) continue to have their own jobs and may still dominate total repository CI; their environment-specific coverage is intentionally out of scope for #68.
