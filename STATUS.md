# Bones: Status

Last updated: 2026-11-26 (after the CRDT pipeline, fixes F1 to F4 and the first working Cursed Checklist). Submission deadline: Dec 3, 2026.

This is the only status document. Older ones are in `docs/archive/` and are historical.

## Verify it yourself

```bash
cd kernel
npm install
npm run typecheck   # src + tests
npm run build
npm run lint
npm test
npm run coverage    # writes kernel/coverage/coverage-final.json
node ../scripts/quality-gate.mjs   # purity + typecheck + lint + tests
```

Last verified run: typecheck, build, lint and purity clean; 560 tests pass; line coverage of `kernel/src` only is 99.12% (`crdt.ts` 99.18%, `rga.ts` 98.63%, `utils.ts` 97.95%, `events.ts` 97.5%; `buffer.ts`, `gc.ts`, `membership.ts`, `oplog.ts`, `vv.ts`, `index.ts` 100%). `src/types.ts` is excluded because it has no runtime code.

## Cursed Checklist (`apps/cursed-checklist`, KER-080)

```bash
cd apps/cursed-checklist
npm ci
npm test       # 124 tests: replica 11, transport 4, sync 109
npm run build  # tsc --noEmit + vite build
```

Last verified run: 124 tests pass, `tsc` clean, build succeeds, `npm audit` reports 0 vulnerabilities. In real Edge, three tabs on one `BroadcastChannel` were driven by a throwaway script (not in the repo): 16 of 16 checks passed (live sync both ways, concurrent adds in the same order, late tab and reloaded tab catch up, a reloaded tab gets a new replica ID, HTML in an item shown as text, hostile messages on the channel ignored, no console errors).

- **Works:** add, complete (= delete, leaves a tombstone), sync across tabs of one browser, catch-up through a hello every 3 s.
- **Not built:** Graveyard panel, membership and eviction, stable frontier, GC, other browsers or devices, persistence. Limits are listed in the app README.
- **S4 scope collapse (Nov 26, collapsed for schedule):** the unit-test group (KER-038 to KER-47) is not tracked separately because each module ships with its tests; the property-test group (KER-48 to KER-65, the 18 properties in `design.md`) is reduced to 8 properties (convergence, idempotence, VV contiguity, delete-before-insert, frontier safety, GC safety, fencing, snapshot rejoin); the network simulator (KER-034) is replaced by seeded shuffle/duplicate helpers inside the tests; integration tests (KER-66 to KER-70) are reduced to two; documentation tasks (KER-71 to KER-74) are covered by the README, `design.md` and this file instead of separate documents. The task IDs here are checked against `tasks.md`: the plan text gave KER-047 to KER-064, KER-065 to KER-069 and KER-070 to KER-073, which are one lower than the headers in this repo.
- **Finding (A5):** the document asked for `vitest` 5.1.1. That release was 8 days old on Nov 26, which fails the document's own two-week rule. Also, with npm 10.9.2, every `vitest` 4.1.x and 5.x release except 5.1.2 (1 day old) crashed the dependency resolver (`Cannot read properties of null (reading 'edgesOut')`). Chosen: `vitest` 5.1.0 (23 days old) with `legacy-peer-deps=true` in `apps/cursed-checklist/.npmrc`; `npm ci` works and `npm audit` is clean. `vitest` 4.0.18 was rejected (critical advisory).
- **CI:** the `checklist` job runs on Node 22 (Vitest 5 needs `^22.12 || ^24 || >=26`); the `kernel` job now runs on Node 22 as well, so both jobs match (the kernel itself still only needs Node 20 or newer). Both jobs were simulated from a fresh clone of `4c0989e` (kernel gate; app `npm ci`, `npm test`, `npm run build`, `npm audit`; all exit 0).
- **Design choice:** `sync.ts` applies every valid operation and hides values that are not items at render time. Ignoring an operation with a bad value would leave a gap in its author's sequence and stall all later operations from that author.

## Coordinator (`coordinator/`, KER-077, demo-apps task DA-3)

```bash
cd coordinator
npm ci
npm run typecheck
npm run lint
npm test
```

Last verified run: typecheck and lint clean; 104 tests pass; `core.ts` has 100% line coverage. `npm audit` reports the same dev-tooling advisories as the kernel (vitest, vite, esbuild, ESLint plugins; no runtime dependencies). `@types/node` is pinned to 22.20.5, the newest 22.x that is at least two weeks old.

- **Built:** `coordinator/src/core.ts`, the pure decision logic (`CoordinatorCore`). A hello is the acknowledgement; the stable frontier is the kernel's `computeStableFrontier` over active members, kept monotonic and re-broadcast so a lost message cannot strand GC; eviction is manual and two-phase (prepare, cutoff = max of the survivors' replies, publish, pending until every active member holds the target's operations up to the cutoff); stale-epoch and non-member control messages are refused; nothing is evicted automatically.
- **Tested:** 104 tests. Eight drive the core together with real kernel replicas: stall, exorcise, reclaim, fence; a live target; a stalled survivor and abort; a lost prepare; a missed view. 45 mutants of `core.ts` were applied, all caught.
- **Guard rails:** `scripts/check-purity.mjs` and the purity hook now also cover `coordinator/src/core.ts` (checked: a planted `Date.now`, `Math.random`, timer, `console` or `fetch` is reported). CI has a `coordinator` job on Node 22 (parsed, not yet run on GitHub).
- **Deviation from the Nov 26 plan:** the plan's wire list has no prepare round, but requirement 10.3 needs one (survivors must freeze the target and report their seq, or a live target splits them). `prepare`, `prepared`, `release` and `rejected` were added; there is still no separate confirm message (the hello is the confirmation). Recorded in `.kiro/specs/demo-apps/design.md`.
- **Not built:** the adapters that carry it to real tabs (the `/control` page and `sync.ts` wire v2; DA-4, DA-5), so nothing talks to a real tab yet.

## Tasks (`.kiro/specs/crdt-kernel/tasks.md`)

| Task | State |
|------|-------|
| KER-001 repo, tsconfig, eslint | done |
| KER-002 Vitest + coverage | done |
| KER-003 fast-check setup | partly done: fast-check runs seeded; arbitraries for Operation/Element/VV/MembershipView are not written yet |
| KER-004 types | done (`kernel/src/types.ts`) |
| KER-005 utils + events | done |
| KER-006 RGA anchor tree + insert + traversal | done (kernel/src/rga.ts) |
| KER-007 delete + tombstones | done |
| KER-008 getSequence / isElementDeleted | done |
| KER-009 concurrent ordering | done: seeded property tests (convergence, idempotence, subtree contiguity, sibling order, Req 1.8). Mutation-checked: an oldest-first ordering fails 10 tests |
| KER-010 payload reclamation primitive | done (markPayloadReclaimed; the GC decision logic is KER-023) |
| KER-011 VV create / clone / merge / update | done (helpers in `utils.ts`; `updateVersionVector` now always returns a new Map) |
| KER-012 VV partial order | done (`compareVersionVectors`: equal / before / after / concurrent, transitivity tested; `computeVVDifference` in `vv.ts` checked against a brute-force count) |
| KER-013 contiguous prefix | done (`advanceContiguous` in `kernel/src/vv.ts`; never skips, never regresses) |
| KER-014 VV serialization | done (keys inserted in code-unit order; mutation-checked with `advanceContiguous` and `stableFrontier`) |
| `stableFrontier` helper | done (`kernel/src/vv.ts`; component-wise minimum, missing = 0). Callers must pass one VV per ACTIVE member |
| KER-015 op log append / query | done (`kernel/src/oplog.ts`; append-only, application order) |
| KER-016 op log dedup | done (Op ID set, O(1); 20,000 appends + checks tested) |
| KER-017 deterministic replay | done (`replayLog`, plus `cloneRGA` in `rga.ts`; split replay equals full replay) |
| dependency buffer (`kernel/src/buffer.ts`) | done: indexed unblocking, fence purge, capped `missing` cache. A 5,000-op reverse chain needs <= 3n readiness checks. 12 mutants caught |
| `assertValidOperation` (`utils.ts`) | done: validates operations that never passed `deserializeOp`; `CRDT.applyOp` uses it. 8 mutants caught |
| KER-030 CRDT init | **partly done**, not ticked: replicaId, RGA, VV, log, buffer, clock, membership (optional constructor view; open mode without one), frontier and GC state exist. Open: snapshot-based init (`CRDT.fromSnapshot`, KER-027 to KER-029) |
| KER-031 insert / delete / applyOp | done: pipeline, buffering, no-ops, Lamport absorption, events, and real fencing by author + cutoff (never `op.epoch`). A fenced operation changes nothing. Local operations skip the author fence; an evicted replica refuses to create operations beyond its own cutoff. 38 mutants for membership, frontier and GC caught (20 earlier for the pipeline) |
| KER-032 query methods | done: `getSequence`, `getAllElements`, `getVV`, `getOps`, `opsSince`, `getPendingCount`, `getLamportClock`, `isElementDeleted`, `getMembershipView`, `isCausallyStable`, `getStableFrontier`, `getGCStats` (all return copies) |
| F1 Lamport limit | done: `MAX_LAMPORT` = 2^48; `assertValidOperation` rejects larger Lamport times (and unsafe epochs); a replica at the limit refuses local operations. Reproduced first: a forged `2**53` froze the clock (`clock + 1 === clock`) |
| F3 catch-up | done: `computeVVDifference`, `CRDT.opsSince`; sync property tests. Finding: a peer holding buffered operations can only send what it has applied, so catch-up can take more than one round; repeating the exchange converges |
| F4 tombstones | done: `CRDT.getAllElements()` returns every element including deleted ones, as copies |
| KER-018 to KER-022 membership, epochs, fencing, cutoffs, serialization | done (`kernel/src/membership.ts`, 108 tests incl. the public entry point). Edit ops are fenced by author + cutoff, control messages by epoch; `applyMembershipView` ignores a non-increasing epoch and ignores a higher-epoch view that contradicts known state. 42 mutants, all caught. Wired into `CRDT` (author fence in `applyOp`, `updateMembership`) |
| KER-023 Stage 1 GC + decision D-A (log redaction) | done (`kernel/src/gc.ts`, `redactReclaimedPayloads` in `oplog.ts`; 29 + 9 tests; 18 + 7 mutants caught). Reclaims the payload when ANY delete of the element is stable. The tombstone count never goes down (structure is kept). The RGA and the log share one payload object, so `bytesSaved` counts each reclaimed payload once, and it is only true because GC clears both. Called from `CRDT.updateStableFrontier` (tests in `crdt.gc.test.ts`) |
| KER-024, KER-025 frontier and causal stability | done (`computeStableFrontier`, `isCausallyStable` in `vv.ts`, 25 tests, 11 mutants caught) |
| KER-026 GC stats | done: `buildGCStats` and `CRDT.getGCStats()` |
| KER-033 events and membership updates | **partly done**, not ticked: `membershipChanged`, `gcEvent`, `sequenceChanged`; `updateMembership(view)` returns whether it was installed and ends the hold of an author it evicts; `updateStableFrontier(frontier, epoch)` applies the frontier only at the current epoch (requirement 11.8), merges it monotonically, runs GC and redacts the log. Open: `snapshot()` and `rejoinFromSnapshot` |
| Eviction prepare phase (requirements 10.3) | done: `CRDT.holdAuthor(id)` buffers an author's operations (never drops them) and returns the contiguous applied seq to reply to `evict-prepare` with; `releaseAuthor(id)` ends a hold; installing the view that evicts the author ends it by itself (operations beyond the cutoff are purged, those within it are applied). Without it a survivor could keep an operation of a LIVE target that the others fence, and they would diverge for good (a test reproduces that). 29 + 7 unit tests, 1 property test (the target keeps writing between prepare and publish), 16 + 3 mutants caught |
| Gate A property tests (KER-58 to KER-61) | done: 22 properties in `frontier.properties.test.ts` (6), `gc.properties.test.ts` (10) and `fencing.properties.test.ts` (6), seeded, 150 runs each; also run at 400 runs with seeds 777, 424242 and 99, all passing. Frontier safety (stable means every member applied it, closed under causality, never regresses, an un-acked member holds it back). GC safety (same history with and without GC gives identical visible sequence, structure, VVs and log order; a payload is reclaimed only when every member has the element deleted; a fresh replica replaying the REDACTED log, or a mix of redacted and full copies, converges). Fencing (beyond the cutoff or unknown author: always fenced and nothing changes; at or below: never fenced; `epoch` has no effect). 21 of 22 deliberate bugs in `gc.ts`, `vv.ts`, `oplog.ts` and `crdt.ts` are caught by these property tests alone; the 22nd (reclaim a live element when the bookkeeping is corrupt) is caught by a unit test. KER-57 (epoch monotonicity) is covered by unit tests only |
| KER-027 to KER-029 snapshots and rejoin | not started. Next: snapshot creation, validating serialization, `CRDT.fromSnapshot`, then the property tests |

## Source of truth

1. `kernel/src/types.ts` and `.kiro/steering/tech.md` for names and types.
2. `.kiro/specs/crdt-kernel/design.md` for algorithms (synced to the above).
3. `.kiro/specs/crdt-kernel/requirements.md` for behavior.

## Decisions that are easy to get wrong

- **Op IDs** are strings `` `${replicaId}:${seq}` `` (`OpIdKey`). `compareOpIds` is plain string order, so `"a:10" < "a:9"`. Never use it to order one replica's ops by seq.
- **Replica IDs** look like `site.incarnation` (dots allowed); `:` is not allowed.
- **RGA is an anchor tree.** Sequence = iterative depth-first traversal. Siblings are ordered **newest first** by `(lamport, replicaId)`. Do not implement it as a flat-array scan.
- **No-op ops are applied ops**: they are logged and advance the VV.
- **Unblocking buffered ops** uses an iterative queue with direct lookups (`buffer.waiting` + the author's next seq). Rescanning the whole buffer took ~20 s on 10,000 ops in a prototype.
- **Fencing**: edit ops by author + cutoff (never by `op.epoch`); control messages by epoch + membership.
- **Eviction** is manual and two-phase: publish (pending), survivors backfill and confirm, then complete.
- **VV deserialization throws** on invalid entries instead of dropping them.

## Hooks (`.kiro/hooks/`, active from the next Kiro session)

| Hook | Trigger | Does |
|------|---------|------|
| `kernel-purity-guard` | PostFileSave on `kernel/src/**/*.ts` and `coordinator/src/core.ts` | `node scripts/check-purity.mjs` |
| `kernel-quality-gate` | Stop | `node scripts/quality-gate.mjs --hook` (reports a failure on stdout and exits 0; without the flag, manual and CI runs exit 1) |
| `submission-check` | SessionStart | `node scripts/check-submission.mjs` |
| `task-done-bookkeeping` | PostTaskExec | asks the agent to run the gate, tick `tasks.md` honestly, update this file, commit |

Coverage limit: per the Kiro docs, file-event hooks (`PostFileSave`) fire on files **the agent** changes, not on your own saves in the editor, so the purity guard protects agent edits only. CI (`.github/workflows/ci.yml`) runs the same gate on every push and covers hand edits.

The hooks run from the repo root (confirmed: the Stop hook found `scripts/` and ran). Kiro launches them with a lowercase drive letter (`c:\...`); the scripts canonicalize the path with `realpathSync.native`, because otherwise Vitest loads two copies of itself and every test file fails with "No test suite found".

## Open issues

- `tasks.md`: list numbers 23 to 39 are one higher than their KER IDs; headers KER-40 to KER-80 are not 3-digit padded; dependency lines mix padded and unpadded IDs; the waves JSON has not been re-verified against the task bodies.
- `requirements.md` headings skip number 16 (15 then 17); `design.md` "Validates" lines cite 16.x for the API requirement.
- README does not mention Algorithm 4 or the `/apps` folders.
- `npm audit` reports advisories in dev dependencies (not fixed; no `--force`).
- `BONES_NEXT_STEPS.md` (the plan the schedule comes from) is not in the repo.
- A replica restored from a snapshot starts a fresh operation log (design.md Algorithm 7), so it can only answer a hello with operations after the snapshot point. Snapshots are not built yet; this will be a README limitation.

## Submission checklist (Devpost / Skeleton Crew)

- [x] MIT `LICENSE` at repo root
- [x] `.kiro/` committed (specs, steering, hooks); not gitignored
- [x] Two separate app folders: `apps/graveyard-whiteboard` (placeholder), `apps/cursed-checklist` (first working version, no Graveyard panel yet)
- [x] `coordinator/` folder (the pure core is built and tested; the adapters that connect it to the apps are not built yet)
- [ ] Working kernel, two working apps, public URL(s)
- [ ] Demo video, write-up covering specs, hooks and steering
- [ ] README states limitations plainly: educational implementation, not production-ready, not a new algorithm, not a Yjs/Automerge/Loro replacement
