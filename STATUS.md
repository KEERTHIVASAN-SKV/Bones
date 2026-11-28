# Bones: Status

Last updated: 2026-11-28 (after the audit review: Gate B checked on the deployed site, stale documentation corrected). Submission deadline: Dec 3, 2026.

Live site: <https://keerthivasan-skv.github.io/Bones/> (Cursed Checklist at `/cursed-checklist/`, control page at `/cursed-checklist/control.html`).

## Gates

| Gate | State | Evidence |
|------|-------|----------|
| A: kernel safety | passed | `node scripts/quality-gate.mjs` (purity, typecheck, lint, 702 tests); 28 property tests for frontier, GC, fencing and snapshot rejoin; a 12-seed whole-stack test (coordinator, real replicas, lossy network, stall and eviction) |
| B: the story works | passed on the deployed URL (see Deploy below) | 2026-11-28, Microsoft Edge (Chromium) driven by a script: demo D1 to D5, 21 of 21 checks, against the site built from `b7c6bbf` |
| C: rejoin | built; passed on a LOCAL build of the Pages artifact, not yet on the deployed URL | `CRDT.fromSnapshot` and 6 snapshot-rejoin properties; the Rejoin button (DA-9); demo D6 in real Edge, driven by a script, two cycles (`.0` to `.1` to `.2`), 39 of 39 checks. The live site still serves `b7c6bbf`, which has no Rejoin: Gate C is met on the deployed URL only after the next push has deployed and D6 has been run there |
| D: second app | not started | `apps/graveyard-whiteboard/` has only a `package.json` and a README |
| E: package | not started | demo video, README pass, write-up, blog, social post |

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

Last verified run (2026-11-28): typecheck, build, lint and purity clean; 702 tests pass in 29 files; line coverage of `kernel/src` only is 99.29% (`crdt.ts` 99.27%, `rga.ts` 98.63%, `utils.ts` 97.95%, `events.ts` 97.5%; `buffer.ts`, `gc.ts`, `membership.ts`, `oplog.ts`, `snapshot.ts`, `vv.ts`, `index.ts` 100%). `src/types.ts` is excluded because it has no runtime code.

## Cursed Checklist (`apps/cursed-checklist`, KER-080)

```bash
cd apps/cursed-checklist
npm ci
npm test       # 219 tests: replica 13, transport 4, sync 109, protocol 45, sync.coordinator 12, coordinatorAdapter 17, panel 11, rejoin 8
npm run build  # tsc --noEmit + vite build
```

Last verified run (2026-11-28): 219 tests pass, `tsc` clean, build succeeds, `npm audit` reports 0 vulnerabilities. In real Edge, three tabs on one `BroadcastChannel` were driven by a throwaway script (not in the repo): 16 of 16 checks passed (live sync both ways, concurrent adds in the same order, late tab and reloaded tab catch up, a reloaded tab gets a new replica ID, HTML in an item shown as text, hostile messages on the channel ignored, no console errors).

- **Works:** add, complete (= delete, leaves a tombstone), sync across tabs of one browser, catch-up through a hello every 3 s.
- **Wire v2 (DA-4):** `protocol.ts` parses and encodes every message in one place; `hello` carries `from` and `epoch`; `sync.ts` carries `view`, `frontier`, `prepare` and `release` to the kernel, replies to `prepare` with the frozen seq, and has `pause()`/`resume()` (a stalled tab sends and hears nothing, its edits are counted and sent on resume) plus a per-author count of operations refused by fencing. 55 new tests, 42 mutants caught; the three-tab Edge check was re-run on the rebuilt app (16 of 16). The control page (below) sends them.
- **Not built:** the Whiteboard, other browsers or devices, persistence. Limits are listed in the app README.
- **S4 scope collapse (Nov 26, collapsed for schedule):** the unit-test group (KER-038 to KER-47) is not tracked separately because each module ships with its tests; the property-test group (KER-48 to KER-65, the 18 properties in `design.md`) is reduced to 8 properties (convergence, idempotence, VV contiguity, delete-before-insert, frontier safety, GC safety, fencing, snapshot rejoin); the network simulator (KER-034) is replaced by seeded shuffle/duplicate helpers inside the tests; integration tests (KER-66 to KER-70) are reduced to two; documentation tasks (KER-71 to KER-74) are covered by the README, `design.md` and this file instead of separate documents. The task IDs here are checked against `tasks.md`: the plan text gave KER-047 to KER-064, KER-065 to KER-069 and KER-070 to KER-073, which are one lower than the headers in this repo.
- **Finding (A5):** the document asked for `vitest` 5.1.1. That release was 8 days old on Nov 26, which fails the document's own two-week rule. Also, with npm 10.9.2, every `vitest` 4.1.x and 5.x release except 5.1.2 (1 day old) crashed the dependency resolver (`Cannot read properties of null (reading 'edgesOut')`). Chosen: `vitest` 5.1.0 (23 days old) with `legacy-peer-deps=true` in `apps/cursed-checklist/.npmrc`; `npm ci` works and `npm audit` is clean. `vitest` 4.0.18 was rejected (critical advisory).
- **CI:** the `checklist` job runs on Node 22 (Vitest 5 needs `^22.12 || ^24 || >=26`); the `kernel` job now runs on Node 22 as well, so both jobs match (the kernel itself still only needs Node 20 or newer). Both jobs were simulated from a fresh clone of `4c0989e` (kernel gate; app `npm ci`, `npm test`, `npm run build`, `npm audit`; all exit 0).
- **Control page (DA-5):** `control.html` is a second entry of the same Vite build (same origin as the app, so it shares the channel). `coordinatorAdapter.ts` runs the pure core with an injected clock; `ControlApp.tsx` lists members (last heard, silent flag), the epoch and frontier, an **Exorcise** button per member, **Abort** while an eviction is being prepared, and each exorcised tab with its cutoff and whether every tab holds its operations. The app page shows a banner when its tab was exorcised and a notice instead of crashing when an edit is refused. 17 adapter tests (4 drive the real tab code on one bus), 22 mutants caught. A throwaway real-Edge check with the control page and three tabs passed 15 of 15 (join, epoch 3 then 4, Exorcise, cutoff, banner, refused edit, survivors still sync, no console errors). It exorcises a LIVE tab: the Stall button is DA-6, so stall-then-exorcise has only been run against the real tab code, not in a browser.
- **Graveyard panel, Stall and Stress (DA-6, DA-7):** `panel.ts` computes the numbers (`panelModel`) and runs the stress (`runStress`: 200 items of 100 characters, then buried, through the normal path); `GraveyardPanel.tsx` renders them with the labels `tombstones (structure kept)`, `estimated payload bytes reclaimed` (renamed on Nov 28: the number is the JSON length of the payloads, not memory), `stable frontier`, `epoch`, `members`, `evicted`, plus the Stall/Resume and Stress buttons; a survivor's panel counts the operations it refused from an exorcised tab. 11 panel tests, 20 mutants caught. **A throwaway real-Edge check of the whole demo script D1 to D5 (control page plus three windows) passed 21 of 21**: with C stalled, payload bytes reclaimed stayed 0 on A and B after a 200-item stress run; after Exorcise it jumped to 22,200 with "200 of 200" payloads reclaimed while the tombstone count stayed 200; C resumed, learned it was exorcised, and A and B each showed "Refused 1 operation". Stall C BEFORE pressing Stress when recording, or the zeros never show.
- **Deploy (DA-8): live.** `.github/workflows/pages.yml` builds and tests the app with `BASE_PATH=/<repo>/cursed-checklist/`, `scripts/assemble-site.mjs` lays out `_site/` (one folder per built app plus a landing page, fails if nothing was built), and the official Pages actions publish it. The GitHub Actions API shows the `pages` workflow and `ci` both completed with `success` on `main` at `b7c6bbf` (2026-11-27, 13:27 UTC). **Gate B, checked on the deployed URL on 2026-11-28:** `https://keerthivasan-skv.github.io/Bones/`, `/cursed-checklist/` and `/cursed-checklist/control.html` answer 200 and every JS asset they reference loads under `/Bones/cursed-checklist/assets/`. The whole demo D1 to D5 was run against that URL in Microsoft Edge (Chromium), driven by a throwaway script that is not in the repo: 21 of 21 checks passed (with C stalled, 0 estimated payload bytes reclaimed after a 200-item stress run; after Exorcise 22,200 and "200 of 200" payloads reclaimed while the tombstone count stayed 200; C's edit after resuming was refused and both survivors showed it; no page or console errors). It was a headless script, not a person watching windows, so the manual run in three real windows for the video is still to do. A pull request that the GitHub Copilot cloud agent opened on Nov 27 about the Pages setup (#1) was closed without being merged; `main` has no change from it.
- **Rejoin (DA-9, demo D6), Nov 28:** the exorcised tab's banner has a **Rejoin** button and says how many of its offline edits were not accepted (`vv[self] - cutoff`) and will be discarded. Two new wire messages, `snapshot-request` and `snapshot` (`protocol.ts`; the coordinator ignores them). `rejoin.ts` holds the rules: a tab answers only if it is an active member in its own view, is not stalled, and sees the requester as evicted; it waits a random 0 to 300 ms and drops its answer if another tab answers first; the requester keeps the first reply that passes the kernel's `deserializeSnapshot` and shows its own old ID as evicted, ignores the rest, and says so after 5 seconds without one. Rejoin is by reload: `rejoinSession.ts` stores the snapshot in `sessionStorage`, the page reloads, and at startup `createSessionReplica` restores it with `CRDT.fromSnapshot` under the next incarnation of the old ID (`tab-1a2b3c4d.0` to `.1`); the stored copy is removed before it is used, and anything unusable gives a fresh random replica. The replica is never swapped under the running page. No kernel or coordinator change was needed: the new ID joins through its first hello. **Tests:** 12 new (2 parser tests, 2 for the ID helper, 8 in `rejoin.test.ts`, one of which is the smoke test with the real tab code and the real coordinator, including a second cycle); 35 deliberate bugs in the five files touched were applied one at a time. **Browser:** the demo script extended with D6 and a second cycle passed 39 of 39 in real Edge on a local build of the Pages artifact, and a separate script checked the no-answer path (waiting message, disabled button, "No tab answered" after 5.1 s with no reload, then a successful rejoin once one survivor resumed): 15 of 15. Both scripts are throwaway and not in the repo. **Found while testing:** a mutant that changed the discarded-edits count survived until the smoke scenario had a tab with a non-zero cutoff; the count is now checked with cutoff 1 and 2 refused edits. **Limits:** it needs another running, non-stalled member tab and the control page (until a view lists the new ID, the others refuse its edits); the offline edits are discarded, not merged; the restored tab starts with an empty log.
- **Control page limits:** it IS the coordinator, so reloading it resets it (open tabs keep their view); a reloaded app tab leaves its old replica ID behind as a silent member that holds the frontier back until exorcised.
- **Design choice:** `sync.ts` applies every valid operation and hides values that are not items at render time. Ignoring an operation with a bad value would leave a gap in its author's sequence and stall all later operations from that author.

## Coordinator (`coordinator/`, KER-077, demo-apps task DA-3)

```bash
cd coordinator
npm ci
npm run typecheck
npm run lint
npm test
```

Last verified run (2026-11-28): typecheck and lint clean; 116 tests pass (104 on the core, 12 whole-stack); `core.ts` has 100% line coverage (99.07% branch). `npm audit` reports the same dev-tooling advisories as the kernel (vitest, vite, esbuild, ESLint plugins; no runtime dependencies). `@types/node` is pinned to 22.20.5, the newest 22.x that is at least two weeks old.

- **Built:** `coordinator/src/core.ts`, the pure decision logic (`CoordinatorCore`). A hello is the acknowledgement; the stable frontier is the kernel's `computeStableFrontier` over active members, kept monotonic and re-broadcast so a lost message cannot strand GC; eviction is manual and two-phase (prepare, cutoff = max of the survivors' replies, publish, pending until every active member holds the target's operations up to the cutoff); stale-epoch and non-member control messages are refused; nothing is evicted automatically.
- **Tested:** 116 tests. 104 are on the core; eight of those drive it together with real kernel replicas: stall, exorcise, reclaim, fence; a live target; a stalled survivor and abort; a lost prepare; a missed view. 47 mutants of `core.ts` were applied, all caught.
- **Whole-stack test (KER-066), `coordinator/tests/chaos.integration.test.ts`:** 12 seeds, nothing mocked. Real `CRDT` replicas and the real `CoordinatorCore` are joined by a seeded lossy network (25% of messages dropped, 15% duplicated, delivered 0 to 3 rounds late). Per seed, three replicas edit and join by hello, one is stalled but keeps editing offline, the coordinator evicts it with the two-phase protocol, the survivors keep editing, and everything settles. It checks that the survivors converge; that a survivor's redacted log, replayed into a replica that never ran GC, gives the same visible sequence; that every reclaimed element has a delete that every active member has really applied (checked against the replicas' version vectors, before the eviction with the stalled replica counted as active, and after); that after the eviction every tombstone is reclaimed and more bytes were saved than before; that the log keeps no payload of a reclaimed element; and that the evicted replica's offline edits are refused. Four deliberate kernel bugs were applied one at a time and each made all 12 seeds fail, for the intended reason: `isCausallyStable` always true ("GC unsafe: ... was reclaimed but no delete of it was applied by all"), `isFenced` always false (`expected 'applied' to be 'fenced'`), log redaction removed (the payload is still in the log), and GC never reclaiming (`expected 0 to be 24`). The test was supplied by the audit review and copied in unchanged. **KER-067 stays open:** it asks for 3, 5 and 10+ replicas and this test always runs three (two survivors and one stalled).
- **Guard rails:** `scripts/check-purity.mjs` and the purity hook now also cover `coordinator/src/core.ts` (checked: a planted `Date.now`, `Math.random`, timer, `console` or `fetch` is reported). CI has a `coordinator` job on Node 22 (parsed, not yet run on GitHub).
- **Deviation from the Nov 26 plan:** the plan's wire list has no prepare round, but requirement 10.3 needs one (survivors must freeze the target and report their seq, or a live target splits them). `prepare`, `prepared`, `release` and `rejected` were added; there is still no separate confirm message (the hello is the confirmation). Recorded in `.kiro/specs/demo-apps/design.md`.
- **Not built:** a Node service around the core, and the same control page for the Whiteboard (it arrives with the shared-code extraction, DA-11). In the Cursed Checklist the core runs in the browser on the control page (DA-5).

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
| KER-030 CRDT init | done: replicaId, RGA, VV, log, buffer, clock, membership (optional constructor view; open mode without one), frontier and GC state, and snapshot-based init (`CRDT.fromSnapshot`) |
| KER-031 insert / delete / applyOp | done: pipeline, buffering, no-ops, Lamport absorption, events, and real fencing by author + cutoff (never `op.epoch`). A fenced operation changes nothing. Local operations skip the author fence; an evicted replica refuses to create operations beyond its own cutoff. 38 mutants for membership, frontier and GC caught (20 earlier for the pipeline) |
| KER-032 query methods | done: `getSequence`, `getAllElements`, `getVV`, `getOps`, `opsSince`, `getPendingCount`, `getLamportClock`, `isElementDeleted`, `getMembershipView`, `isCausallyStable`, `getStableFrontier`, `getGCStats` (all return copies) |
| F1 Lamport limit | done: `MAX_LAMPORT` = 2^48; `assertValidOperation` rejects larger Lamport times (and unsafe epochs); a replica at the limit refuses local operations. Reproduced first: a forged `2**53` froze the clock (`clock + 1 === clock`) |
| F3 catch-up | done: `computeVVDifference`, `CRDT.opsSince`; sync property tests. Finding: a peer holding buffered operations can only send what it has applied, so catch-up can take more than one round; repeating the exchange converges |
| F4 tombstones | done: `CRDT.getAllElements()` returns every element including deleted ones, as copies |
| KER-018 to KER-022 membership, epochs, fencing, cutoffs, serialization | done (`kernel/src/membership.ts`, 108 tests incl. the public entry point). Edit ops are fenced by author + cutoff, control messages by epoch; `applyMembershipView` ignores a non-increasing epoch and ignores a higher-epoch view that contradicts known state. 42 mutants, all caught. Wired into `CRDT` (author fence in `applyOp`, `updateMembership`) |
| KER-023 Stage 1 GC + decision D-A (log redaction) | done (`kernel/src/gc.ts`, `redactReclaimedPayloads` in `oplog.ts`; 29 + 9 tests; 18 + 7 mutants caught). Reclaims the payload when ANY delete of the element is stable. The tombstone count never goes down (structure is kept). The RGA and the log share one payload object, so `bytesSaved` counts each reclaimed payload once, and it is only true because GC clears both. Called from `CRDT.updateStableFrontier` (tests in `crdt.gc.test.ts`) |
| KER-024, KER-025 frontier and causal stability | done (`computeStableFrontier`, `isCausallyStable` in `vv.ts`, 25 tests, 11 mutants caught) |
| KER-026 GC stats | done: `buildGCStats` and `CRDT.getGCStats()` |
| KER-033 events and membership updates | done: `membershipChanged`, `gcEvent`, `sequenceChanged`; `updateMembership(view)` returns whether it was installed and ends the hold of an author it evicts; `updateStableFrontier(frontier, epoch)` applies the frontier only at the current epoch (requirement 11.8), merges it monotonically, runs GC and redacts the log. The task text's `rejoinFromSnapshot` instance method is the static `CRDT.fromSnapshot` here (a restored replica starts with an empty log and buffer) |
| Eviction prepare phase (requirements 10.3) | done: `CRDT.holdAuthor(id)` buffers an author's operations (never drops them) and returns the contiguous applied seq to reply to `evict-prepare` with; `releaseAuthor(id)` ends a hold; installing the view that evicts the author ends it by itself (operations beyond the cutoff are purged, those within it are applied). Without it a survivor could keep an operation of a LIVE target that the others fence, and they would diverge for good (a test reproduces that). 29 + 7 unit tests, 1 property test (the target keeps writing between prepare and publish), 16 + 3 mutants caught |
| Gate A property tests (KER-58 to KER-61) | done: 22 properties in `frontier.properties.test.ts` (6), `gc.properties.test.ts` (10) and `fencing.properties.test.ts` (6), seeded, 150 runs each; also run at 400 runs with seeds 777, 424242 and 99, all passing. Frontier safety (stable means every member applied it, closed under causality, never regresses, an un-acked member holds it back). GC safety (same history with and without GC gives identical visible sequence, structure, VVs and log order; a payload is reclaimed only when every member has the element deleted; a fresh replica replaying the REDACTED log, or a mix of redacted and full copies, converges). Fencing (beyond the cutoff or unknown author: always fenced and nothing changes; at or below: never fenced; `epoch` has no effect). 21 of 22 deliberate bugs in `gc.ts`, `vv.ts`, `oplog.ts` and `crdt.ts` are caught by these property tests alone; the 22nd (reclaim a live element when the bookkeeping is corrupt) is caught by a unit test. KER-57 (epoch monotonicity) is covered by unit tests only |
| Snapshot rejoin property (KER-62, the eighth property) | done: 6 properties in `snapshot.properties.test.ts`, seeded, 150 runs. Snapshot + later operations, in any order and redelivered, equals the replica that stayed connected (with and without GC); the restored replica is identical through serialize/deserialize; a restart of the same replica continues its own sequence and converges; a snapshot after an eviction keeps fencing the evicted author at its cutoff; GC after a restore reclaims what GC on the original does |
| KER-027 to KER-029 snapshots and rejoin | done (`kernel/src/snapshot.ts`, `CRDT.snapshot()`, `CRDT.fromSnapshot(snapshot, replicaId?)`): deep-copied elements with anchors and tombstones, VV, membership with cutoffs, Lamport clock, GC stats and the stable frontier; deterministic serialization that keeps the Map/Set data; a deserializer that VALIDATES everything (it is a trust boundary: IDs against the VV, flags, sibling order, true depth-first order). Restore sets state only, with an empty log; every later operation goes through `applyOp`. A returning evicted replica passes a NEW ID; the evicted ID and another replica's ID are refused. 92 + 27 tests, 40 + 22 mutants caught. **Limitation:** a restored replica starts a fresh log, so it can only answer a hello with operations after the snapshot point |
| KER-066 whole-stack convergence test | done: `coordinator/tests/chaos.integration.test.ts` (12 seeds, real replicas and the real coordinator core over a lossy network, a stalled replica, a manual eviction); 4 of 4 deliberate kernel bugs make it fail (see the Coordinator section) |
| KER-067 convergence with 3, 5, 10+ replicas | open: every multi-replica test runs 3 replicas; nothing runs 5 or 10+ |

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
- `npm audit` reports advisories in dev dependencies (not fixed; no `--force`).
- `BONES_NEXT_STEPS.md` (the plan the schedule comes from) is not in the repo.
- Fixed while building snapshots: `isValidReplicaId` accepted non-strings that the regex coerces to a match (`5`, `["a.0"]`, `true`), so `new CRDT(5)` and `CRDT.fromSnapshot(snap, 5)` did not throw. It now checks `typeof` first (tests added). Also fixed: `estimatePayloadSize` threw on a cyclic or BigInt payload (it is documented to return 0), which would have aborted a GC pass.
- A replica restored from a snapshot starts a fresh operation log (design.md Algorithm 7), so it can only answer a hello with operations after the snapshot point. Snapshots are built (KER-027 to KER-029); this is listed under the README's known limitations.

## Submission checklist (Devpost / Skeleton Crew)

- [x] MIT `LICENSE` at repo root
- [x] `.kiro/` committed (specs, steering, hooks); not gitignored
- [x] Two separate app folders: `apps/graveyard-whiteboard` (placeholder), `apps/cursed-checklist` (working: control page, Graveyard panel, Stall and Stress, Rejoin; deployed except the Rejoin button, which is on the live site after the next push)
- [x] `coordinator/` folder (the pure core is built and tested; the Checklist's control page is its browser adapter; there is no Node service)
- [ ] Working kernel, two working apps, public URL(s)
- [ ] Demo video, write-up covering specs, hooks and steering
- [ ] README states limitations plainly: educational implementation, not production-ready, not a new algorithm, not a Yjs/Automerge/Loro replacement
