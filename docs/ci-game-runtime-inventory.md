# Game runtime coverage and isolation audit

Audited main commit `25c1f95c7769a7c9ef953b9e7343b8bb636ab9ae`, all `.github/workflows/*.yml`, package scripts, Game runtime scripts and 17 simulation test files. Historical timings come from completed post-consolidation run 41243871762. Durations below are entire Actions steps, rounded to seconds, not billed usage.

See [CI architecture and measurements](ci-game-runtime.md) for the implemented OS selection and performance evidence.

## Command inventory

| Command | Ubuntu / Windows seconds | Executed coverage | Dependencies / OS relevance |
|---|---:|---|---|
| build:materials + diff verification | small, included in setup | Compile committed material-science dist and refuse stale generated files | TypeScript; native filesystem handling on both supported OSes |
| test:materials | 47 / 61 | 16 node:test cases + game-materials authority scenario (owned evidence, inspection, allocation, conservation, v3 migration, restart/receipt fidelity) | Pure package calculations are OS independent; authority script uses file-backed native SQLite |
| test:simulation | 78 / 90 | 113 cases on Linux; Windows 110 pass, 3 pre-existing intentional skips | TypeScript check plus Vite local-viewer build, native SQLite, independent writers, HTTP sockets, child processes; details below |
| test:mcp-game | 309 / 405 | game-robots, game-spatial-sensing, game-world, mcp-game, game-all-waste scripts | File-backed SQLite; transactions/restart/migration, worker process and MCP stdio, actual real-time autonomous completion |
| test:mcp | 2 / 4 | MCP room creation/read/write, >1 MB bundles, validation, traversal/symlink refusal | Child process stdio, native paths, filesystem; Windows symlink tests explicitly skip only if privilege yields EPERM |
| test:manufacturing | 414 / 532 | Recovered stock through complete machine chain, owned BOMs, exact offcuts, pause/cancel, interlocks, disabled equipment, starvation/storage, reservation rollback, restart and immutable retry | File-backed SQLite and competing connections; unique machine chain assertions |
| test:units | 346 / 431 | Same recovered-stock prefix, then both turrets and launcher, ammo, ownership, repair, salvage, rollback, restart | Distinct branch of manufacturing script; not redundant with manufacturing or policy tests |
| test:combat | 391 / 497 | Same real manufacture prefix, then paid movement, ammo, tower/power damage, capture, retreat, timed salvage, concurrency/restart/receipts | Distinct branch; not redundant with fixture-based combat policies |
| test:victory | 426 / 533 | Same real manufacture prefix, then tower destruction, authoritative winner, frozen post-match resources, private state/restart/history/receipt fidelity | Distinct branch; not redundant with fixture-based victory tests |
| downstream integration + browser | job 1,098s on Ubuntu | Pinned tower-defense integration, results browser, full desktop/mobile match and evidence | Cross-repository actual HTTP/MCP client/browser integration; independent environment. Full-match browser step is 971s |

The 16 materials cases are 13 science tests plus 3 science-evidence tests. The long script stages are assertion-driven scenarios, not node:test cases; do not advertise their console PASS line count as a test count.

## Simulation test inventory (actual expanded case counts)

| File under tests/simulation | Count | Coverage and Windows relevance |
|---|---:|---|
| adoption.test.ts | 6 | Production work-cell HTTP, multi-process writers, hard restart, version refusal, legacy native migration, CLI worker; keep Windows |
| commands.test.ts | 7 | Durable command/event/receipt atomicity, authorization, SQL fault rollback, racing process writers; keep Windows |
| contracts.test.ts | 11 | Registry/schema/provenance/privacy/entity validation; platform-independent logic |
| deployment.test.ts | 3 | POSIX backup/deployed entry point (2 Windows skips); cross-platform HTTP heartbeat test remains |
| event-runtime.test.ts | 8 | Deterministic event clock, conservation, native migration, real file-backed envelope; keep Windows native integration |
| events.test.ts | 11 | Cursor encryption/retention/privacy; SQL faults, multi-process restart, HTTP worker and game history; keep Windows |
| field-lab.test.ts | 6 | Six frozen day timelines, durable rollback, HTTP identity, independent process races and hard kill; keep Windows |
| game-combat.test.ts | 13 | Deterministic policies and shared clock, ownership/range/energy/interruption; platform-independent fixture logic |
| game-manufacturing.test.ts | 3 | Exact eligible inputs, starvation/tick equivalence, disabled equipment; in-memory fixtures, distinct from manufactured-chain integration |
| game-recovery.test.ts | 7 | Three recovery policies + migrations from schema 6/7/8/9; keep Windows migration portion |
| game-transport-errors.test.ts | 1 | HTTP socket destroyed mid-response distinguishes reads from uncertain mutations; keep Windows |
| game-units.test.ts | 5 | Attachment/magazine/inventory/stock policies; platform-independent fixture logic |
| game-victory.test.ts | 4 | Win/loss/tie file-backed finalization + untrusted winner/refusal; concurrent process writer, rollback/restart; keep Windows |
| jobs.test.ts | 12 | Job scheduling/accounting plus independent worker hard-kill and SQLite persistence faults; keep Windows |
| local-runtime.test.ts | 1 | Installed station, disk sessions, restore/kill, browser optional; intentional Windows skip already present |
| native-game-adoption.test.ts | 4 | Captured native v3/v5 save migration, exact receipts, failed migration rollback, unsupported pins; keep Windows |
| resources.test.ts | 11 | Conservation/rounding plus durable ledger restart, independent SQLite writer contention and fault rollback; keep Windows |
| **Total** | **113** | **110 run on Windows, 3 existing skips** |

## Actual overlap with other workflows

- `test:mcp` is the exact same command in Scene authoring and also both Python-version Vision jobs when that path-filtered workflow runs. Game runtime Linux repeats about two seconds; Windows is its only Windows execution. Keep it for simple self-contained diagnostics unless changing other workflow ownership deliberately.
- `local-runtime.test.ts` is included by simulation and repeated in Local persistent runtime. The latter sets `OI_TEST_BROWSER=true`, installs Chromium, checks real systemd deployment and gathers service diagnostics. Thus the assertions overlap, but the browser/service environment adds unique coverage and is not redundant.
- `deployment.test.ts` is included by simulation and repeated in Persistent runtime deployment. The latter also installs/checks systemd and a real Caddy proxy; that integration coverage is unique.
- FIELD-LAB replay scripts and simulation's `field-lab.test.ts` both compare frozen modeled days. The replay script creates evidence output and verifies restart hashes; simulation adds fault injection, HTTP/auth controls, separate-process contention and hard kill. Neither replaces the other.
- Fixture-based manufacturing/units/combat/victory tests do not pay for real acquisition/inspection/manufacturing. The long integration scripts intentionally prove those outputs feed subsequent operations. Similar names are not redundant coverage.
- Scene-authoring, geospatial, camera/vision and OpenCAD handoff workflows have different assertions and environments; no safe suite removal follows from this audit.

## Parallel execution safety

- Every Game runtime scenario creates a unique `mkdtemp` root. SQLite filenames repeat only within these different roots. Competing writers intentionally share only the current scenario's DB.
- Authentication usernames are DB scoped; repeated alice/bob names do not create cross-suite state.
- The MCP game service binds `ASTRA_GAME_PORT=0`; simulation services bind `port: 0`; MCP rooms uses isolated `ASTRA_ROOT` and stdio. The local viewer probes an ephemeral port and releases/rebinds it, which has an existing small TOCTOU race, but no fixed common port is shared.
- Native fixtures and package dist are read-only once built. Material-science is built before suite concurrency starts. Only the simulation suite builds/reads the local viewer output, so it has no concurrent writer. `tsconfig.simulation.json` is noEmit; Vite writes `dist-field-lab`.
- Test helper files, fixtures and source are read-only. `game-robots` snapshot copies stay within its mkdtemp root. The Game runtime suites do not write shared deliverables; FIELD-LAB replay scripts do, but are in separate runners.
- Child process launchers use `process.execPath`; no shell npm executable portability is needed if launching node directly. Tests own and terminate their children. Avoid fail-fast cancellation that strands children or interleaved stdout that destroys failure attribution; retain suite-prefixed output, per-command timings, and aggregate nonzero exits. The existing concurrently CLI provides these without a new runner framework.
- The long scenarios are predominantly synchronous CPU work with simulated clocks, not sleeping in real time. Concurrent jobs/processes can contend for limited CPU and memory; bounded concurrency must be measured on actual runners. Node's simulation runner already parallelizes test files, so nesting unrestricted suite concurrency risks oversubscription.
- `mcp-game-test.ts` has 1.2s +20s deliberate real-service waits for autonomous progress/completion; they are only a small fraction of total CPU-heavy suite time and represent unique disconnected-client behavior.

