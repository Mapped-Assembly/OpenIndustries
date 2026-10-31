# Game runtime CI performance (#68)

Game runtime owns Node/TypeScript coverage; Python FIELD-LAB and other workflows remain separate. The [test inventory](ci-game-runtime-inventory.md) lists every command, simulation file, platform requirement, shared resource and overlap with other workflows.

## Why consolidation regressed feedback

PR #70 replaced five parallel groups per OS with one sequential job per OS. In its completed run, Ubuntu spent 2,013 seconds testing and Windows 2,553 seconds testing. Checkout, Node setup and npm installation across the two jobs cost only 48 seconds, versus 209 seconds across the previous ten jobs. Saving setup did not compensate for serializing the critical path.

The long tests use injected clocks and real file-backed SQLite. They are predominantly CPU-heavy validation, projection and history replay, not arbitrary sleeps. Manufacturing, units, combat and victory repeat the same recovered-stock preparation, but then take distinct branches. None was removed as redundant. The harness now reuses a freshly read projection within a block with no action/clock change, instead of repeatedly issuing the same expensive read transaction. Every assertion remains; fresh reads still follow actions, ticks and restarts. There is no cross-operation cache, mocked persistence or product-code change.

A local V8 CPU profile of the original manufacturing scenario attributed about 82.5% of self samples to resource balance checks, JSON validation/copying and command/game canonicalization; idle samples totaled only 0.138 seconds. In one Node 24.22.1 profiled pair on this shared host, the original scenario took **679.35 seconds elapsed / 726.30 seconds child CPU**, versus **509.64 / 546.02 seconds** after the harness edit (about 25% less each). Both passed with byte-identical PASS output. This is diagnostic evidence, not a repeatable Actions speedup claim: host load, instrumentation and Node version differ from CI. No product validation was bypassed.

One baseline cannot establish runner-cost causality: four pre-consolidation runs ranged from 91.42 to 101.90 runner-minutes, while the consolidated sample was 95.50. The wall-time regression is clear: those four runs took 20.32–24.85 minutes, versus 43.25 after serialization.

## Implemented check topology

| Stable check | Coverage and execution |
| --- | --- |
| `Browser change detection` | Stdlib classifier/accounting regressions; complete Git history; conservative classification |
| `Ubuntu suite` | Material build and committed-output verification, CI orchestration regressions, **all eight original suites**, at most two top-level suite processes |
| `Windows compatibility` | Material build/output verification, orchestration regressions, materials, all simulation, game/robot MCP, MCP rooms, and full manufacturing chain; at most two top-level suite processes |
| `downstream-browser` | Unchanged pinned tower-defense integration, desktop/mobile results, gesture/full-match coverage and evidence upload; runs unless successful classification explicitly says docs-only |
| `Windows full regression` (separate workflow) | All eight suites on Windows, every Monday at 07:23 UTC and via **Actions → Game runtime Windows full → Run workflow** |

`concurrently` was already a locked development dependency. The two npm CI profiles use its bounded process pool, explicit `--success all`, suite-name prefixes and `--timings`. A failed suite fails the check; the remaining suites continue so one failure does not hide another. No extra dependency or orchestration framework was added. Regression tests execute the actual installed CLI with short fixtures to verify failure propagation, completion, labels and the concurrency bound, as well as protecting the suite inventory.

Independent scripts own unique temporary directories/databases; services use ephemeral ports or stdio. Material output builds before the pool starts. Only simulation builds the local viewer output. Concurrency is capped at two because these scenarios consume CPU; the simulation command also uses Node's existing file-level test concurrency. Within-job concurrency avoids duplicate checkout/install and extra required-check names, but provides less CPU isolation than separate runner jobs. Actual Actions results, rather than local CPU count, decide whether this is sufficient.

npm download caching remains enabled. Superseded PR runs cancel; main pushes retain validation. Job timeouts are reduced from 65/80 to 35 minutes, not raised to mask slow/failing tests. Full Windows has a separate 45-minute guard.

## Windows coverage ownership

All original Ubuntu commands remain on every PR: `test:materials`, `test:simulation`, `test:mcp-game`, `test:mcp`, `test:manufacturing`, `test:units`, `test:combat`, `test:victory`.

The default Windows profile retains native SQLite transactions, migrations, competing processes/connections, SQL-fault rollback, immutable receipts, filesystem paths/symlink handling, stdio, kill/restart, persistence and the complete recovered-stock manufacturing chain. It also retains the cheap platform-independent tests within materials and simulation; maintaining fine-grained test-name exclusions would save little and risk drift.

| Windows command moved out of default PR checks | Coverage retained |
| --- | --- |
| `test:units` | Entire unique manufactured turret/launcher, repair, destruction and salvage chain runs every PR on Ubuntu and weekly/manual on Windows. Windows PR simulation retains unit policy tests; manufacturing/native suites retain database/process compatibility. |
| `test:combat` | Entire manufactured combat/capture/retreat/timed-salvage chain runs every PR on Ubuntu and weekly/manual on Windows. Windows PR simulation retains combat policies plus native persistence/concurrency regressions. |
| `test:victory` | Entire manufactured tower-destruction/victory/frozen-resource chain runs every PR on Ubuntu and weekly/manual on Windows. Windows PR simulation retains file-backed finalization, simultaneous writers, rollback, restart and untrusted-winner rejection. |

These three scenarios are **deferred on Windows, not equivalent to the remaining tests**. Risk: a Windows-only interaction unique to these chains may be discovered by the weekly run rather than before merge. Run the full Windows workflow manually before releases and when changing native runtime or these chains. The schedule becomes active only after merge. This new weekly workflow has been linted and its full-profile wiring regression-tested; the deferred Windows chains await its first scheduled/manual execution. Do not make its weekly-only check required on PRs.

Counts before and after should remain 16 material TAP cases plus the authority script, and 113 simulation cases on Ubuntu / 110 passes plus 3 existing POSIX skips on Windows. Script scenarios contain assertions rather than individually enumerated TAP cases; their PASS log lines are not advertised as test counts. Unrelated workflows retain their distinct browser, systemd, Caddy, vision, scene and FIELD-LAB coverage; no similar-looking suite was deleted.

## Browser selection and failure behavior

Only recognized root prose, Markdown/media under `docs/`, license text and issue templates skip browser integration. Unknown paths, source Markdown, executable MDX, UI, API, shared runtime, tests, fixtures, configuration, dependency and workflow changes run it. Missing/invalid base history and empty diffs fail open. Rename detection is disabled so both old and new paths are classified. Real temporary-Git regression cases cover renames and missing objects.

A failed change-detection job or absent output also runs browser integration, while leaving the detector failure visible. Cancellation still stops superseded work. Conditional skipping is at job level, so the check reports a skipped result rather than vanishing through a workflow path filter.

## Measurements

All times below are whole-job start→completion sums or first-job-start→last-job-completion envelopes, including setup/cleanup. Queueing before the first job starts is excluded; gaps and staggered starts inside the envelope are included. These are **elapsed runner-minutes, not billed cost**. The table measures the Game runtime PR workflow; separate repository workflows and the weekly/manual full Windows run incur additional allocations and are not included in these per-PR totals. Windows rates/multipliers, public-repository allowances, billing rounding and plan details are not supplied by this API, so no dollar saving is claimed.

| Architecture / run | Executed jobs | Runner min | Wall min |
| --- | ---: | ---: | ---: |
| [Requested baseline 41231502401](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41231502401) | 11 | 91.42 | 24.85 |
| [Additional baseline 41236666779](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41236666779) | 11 | 98.83 | 21.65 |
| [Additional baseline 41239187367](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41239187367) | 11 | 97.85 | 20.60 |
| [Immediately before #70, 41243311718](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41243311718) | 11 | 101.90 | 20.32 |
| [Serialized #70, 41243871762](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41243871762) | 4 | 95.50 | 43.25 |
| [New architecture, 41248769031](https://github.com/Mapped-Assembly/OpenIndustries/actions/runs/41248769031) | 4 | **47.43** | **21.67** |

The earliest baseline precedes embodied changes; the immediately pre-#70 main run shares product state with #70. The eight suite entrypoints and 16/113 case counts match across the compared runs. Browser full-match alone took 971 seconds in #70 and is expected to set a substantial lower bound. The first new run completed successfully with all eight repository workflows green; a second run with unchanged implementation is being collected to test repeatability. The first benchmark remains **below 91.42 runner-minutes and 24.85 wall minutes** with accounted coverage.

The first new run beats the requested baseline by **48.1% runner time and 12.8% wall time**. Job allocations were Ubuntu **18.57 min**, Windows **7.25 min**, filter **0.10 min**, browser **21.52 min**. Linux allocations total **40.18 min**; Windows **7.25 min**. All eight Ubuntu suite commands passed, with **113 simulation and 16 material TAP cases**; Windows retained **110 simulation passes / 3 existing skips and 16 material passes**. All five orchestration regression methods passed on both OSes, and all 26 classifier/accounting tests passed. Browser integration, results, gesture and full desktop/mobile match passed and uploaded evidence. [Machine-readable job timestamps and per-OS totals](evidence/ci-runtime/measurements.json) preserve the calculation inputs.

The browser set the critical path. It began 9 seconds after the first job started, versus 3.92 minutes in the requested baseline; its own duration varies (18.30 minutes in #70, 21.52 here). The Ubuntu pool used 18.17 minutes with 2,004.86 seconds summed across overlapping commands: per-command elapsed time is not CPU time or runner billing. Its late MCP-game tail leaves some capacity idle, but an additional Ubuntu job would not shorten this observed browser-bound workflow and would add setup/maintenance. This supports keeping bounded within-job concurrency. The first sample beats the requested targets, but does not establish a wall-time improvement against every historical matrix run; the older four-run range starts at 20.32 minutes.

The pinned downstream source was also audited: its full desktop/mobile match performs real recovery, recharge, inspection, processing, manufacture and combat against the production wall clock and one-second scheduler. It has no unconditional full-match sleeps or repeated application build. The two crews deliberately serialize revision-sensitive operations. Independent integration/results commands could overlap about 95 seconds historically (155 seconds in the first new run), but CPU contention could erase the saving; they remain unchanged. Larger cuts require a separately reviewed downstream harness or product-performance change, rather than accelerating the production clock or patching pinned tests.

Reproduce metrics from a completed run (WSL2 or any shell with GitHub CLI and Python):

```bash
gh api 'repos/Mapped-Assembly/OpenIndustries/actions/runs/RUN_ID/jobs?per_page=100' | python3 scripts/ci_run_metrics.py
```

The script rejects unfinished, empty or truncated responses instead of reporting misleading partial totals; it excludes skipped jobs even when they have timestamps and reports unsuccessful job counts. Use one completed attempt consistently. Per-OS times and suite timings must be retained alongside aggregate values. Failed/cancelled attempts do not establish a performance win.

## Required checks and completion gate

Available branch metadata reports `main` unprotected, enforcement off and no required contexts. The rulesets list is empty. Detailed `GET /repos/Mapped-Assembly/OpenIndustries/branches/main/protection` returns **403: Resource not accessible by integration**. Thus current accessible metadata shows no enforced check list, but detailed administration could not be inspected.

An administrator should verify **Settings → Branches** and **Settings → Rules → Rulesets**. If enforcing PR gates, select `Ubuntu suite`, `Windows compatibility`, `Browser change detection`, and `downstream-browser`; remove obsolete `mcp (ubuntu-latest)`, `mcp (windows-latest)` and equivalent manufacturing/units/combat/victory matrix names if still configured. Keep unrelated required checks. Confirm a documentation-only PR reports browser skipped successfully. Do not require the scheduled-only `Windows full regression` check.

Keep #68 open until the implementation is merged with passing checks, actual performance evidence and acknowledged Windows coverage policy. No automatic merge is configured by this change.
