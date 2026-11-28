# Demo Apps Tasks

Every task traces to a demo step (D1 to D7 in `requirements.md`). Build in the order of the demo story, not in task-number order. A box is ticked only when its tests pass and the step works; keep this file in step with `STATUS.md`.

Decision filter before starting anything: does it appear in the demo script, a property test or a README claim? If not, skip it.

## Gates

| Gate | Evidence |
|------|----------|
| A: kernel safety | Property tests (seeded, 100+ runs): frontier safety, GC safety including the redacted log, fencing. `node scripts/quality-gate.mjs` passes. |
| B: the story works | In 3 tabs: stall a tab, the panel shows the frontier stuck and 0 bytes reclaimed; exorcise it, the frontier moves and bytes are reclaimed; the stalled tab's later edits are rejected. A deployed URL exists. |
| C: rejoin | An evicted tab rejoins from a snapshot with a new ID and shows the same list; the deployed URL still works. |
| D: second app | The Whiteboard works through the same flow; both apps deployed. |
| E: package | Video public; README, benchmark table and limits final. |

## Tasks

- [x] DA-0. **Spec from the demo script** (M0)
  - This folder.

- [x] DA-1. **Checklist: add, bury, live sync, late tab catch-up** (D1, R1)
  - `apps/cursed-checklist`: `replica.ts`, `transport.ts`, `sync.ts`, `session.ts`, `App.tsx`. 124 tests; three real Edge tabs checked.
  - Dependencies: kernel `applyOp`, `opsSince`.

- [x] DA-2. **Kernel pieces the demo needs** (Gate A; kernel tasks KER-018 to KER-033)
  - Done: membership with fencing by author and cutoff, Stage 1 GC with log redaction (D-A), `CRDT.updateMembership`, `updateStableFrontier(frontier, epoch)`, the eviction prepare hold (`holdAuthor`/`releaseAuthor`), queries, and the 22 Gate A property tests (frontier safety, GC safety including the redacted log, fencing). Snapshots (KER-027 to KER-029) are part of DA-9, not here.
  - Tracked in `.kiro/specs/crdt-kernel/tasks.md`.

- [x] DA-3. **Coordinator core** (D3, D4; R5)
  - Done: `coordinator/src/core.ts` (`CoordinatorCore`: `onHello`, `startEviction`, `onPrepared`, `abortEviction`, `getStatus`), pure (checked by `scripts/check-purity.mjs`), 116 tests: 104 on the core including 8 that drive it with real kernel replicas (stall, exorcise, reclaim, fence, a live target, lost messages), plus a 12-seed whole-stack test over a lossy network (`coordinator/tests/chaos.integration.test.ts`), 47 mutants caught.
  - Not here yet: the adapters that turn effects into messages (DA-4, DA-5).
  - Dependencies: DA-2.

- [x] DA-4. **Wire v2 and `pause()`** (D3, D5; R3, R5)
  - Done in `apps/cursed-checklist`: `protocol.ts` (one parser and the encoders for every message), `hello` carries `from` and `epoch`, `view`, `frontier`, `prepare`, `prepared`, `release`, `rejected`; `sync.ts` carries them to the kernel and has `pause()`/`resume()`, an unsent-edits counter and a per-author count of operations refused by fencing (`getStats`, `subscribe`). 179 app tests (55 new), 42 mutants caught; the three-tab Edge check still passes 16 of 16.
  - Not here yet: nothing in the running app SENDS the coordinator's messages until the control page exists (DA-5), and no button calls `pause()` yet (DA-6).
  - Dependencies: DA-2.

- [x] DA-5. **`/control` page** (D4; R5)
  - Done in `apps/cursed-checklist`: `control.html` is a second entry of the same Vite build (same origin as the app), `coordinatorAdapter.ts` runs the pure core on a transport with an injected clock, `ControlApp.tsx` lists members with last-heard time, the epoch, the frontier, an **Exorcise** button per member, an in-progress block with **Abort**, and the exorcised tabs with their cutoff and whether every tab holds them. The app page now shows a banner when its tab was exorcised, shows a notice instead of crashing when an edit is refused, and links to the control page.
  - Tested: 17 adapter tests, 4 of them drive the real tab code on one bus (stall, exorcise, reclaim, refusal counters, a live target, a stalled survivor and abort). 22 mutants of the adapter were caught. A throwaway real-Edge check with the control page and three tabs passed 15 of 15: join, epoch 3 then 4, Exorcise, cutoff shown, the exorcised tab shows the banner and refuses edits, survivors keep syncing, no console errors. That check exorcises a LIVE tab: the Stall button comes with DA-6, so the stall-then-exorcise story is not yet checked in a browser.
  - Dependencies: DA-3, DA-4.

- [x] DA-6. **Graveyard panel in the Checklist** (D2, D3, D4; R4)
  - Done: `panel.ts` (`panelModel`, the numbers; `runStress`, 200 items of 100 characters added then buried through the normal `insert`/`delete`/`sendOp` path) and `GraveyardPanel.tsx` (renders them, plus the **Stall this tab** / **Resume** and **Stress** buttons). Labels: `tombstones (structure kept)`, `payloads reclaimed`, `payload bytes reclaimed`, `stable frontier`, `epoch`, `members`, `evicted`. It says plainly when no control page is running (nothing can be reclaimed then).
  - Tested: 11 panel tests, 20 mutants caught. A throwaway real-Edge check of the whole demo script D1 to D5 (control page and three windows) passed 21 of 21: with C stalled, bytes reclaimed stays 0 on A and B after a 200-item stress run; after Exorcise it jumps to 22,200 and "200 of 200" payloads are reclaimed while the tombstone count stays 200.
  - Order matters for the recording: stall C BEFORE pressing Stress. With every tab live the frontier catches up within a few seconds and the zeros never show.
  - Dependencies: DA-2, DA-4.

- [x] DA-7. **Fencing made visible** (D5; R6)
  - Done: the survivors' panel shows "Refused N operations from <tab>: it was exorcised, and what it wrote beyond its cutoff is rejected" (counted once per distinct operation, from `sync.getStats().fenced`), and the exorcised tab shows a banner and a notice when an edit is refused. Covered by the DA-6 browser check (D5 steps).
  - Dependencies: DA-4, DA-6.

- [x] DA-8. **Early deploy** (all steps; R9; Gate B)
  - Done and live at `https://keerthivasan-skv.github.io/Bones/` (app at `/cursed-checklist/`, control page at `/cursed-checklist/control.html`). `.github/workflows/pages.yml` (steps checked against the current GitHub Pages documentation: `configure-pages@v5`, `upload-pages-artifact@v4`, `deploy-pages@v4`, `pages: write` and `id-token: write` on the deploy job, the `github-pages` environment), `scripts/assemble-site.mjs` (one folder per built app plus a landing page; fails if nothing was built), and a validated `BASE_PATH` for the Vite `base`. The GitHub Actions API shows `pages` and `ci` completed with `success` on `main` at `b7c6bbf` (2026-11-27).
  - Gate B evidence, 2026-11-28: the whole demo D1 to D5 was run against the deployed URL in Microsoft Edge (Chromium), driven by a script (headless, not a person watching windows): 21 of 21 checks passed. A manual run in three real windows is still to do for the video.
  - Dependencies: DA-1.

- [x] DA-9. **Snapshot and Rejoin** (D6; R7; Gate C)
  - Kernel snapshot tasks KER-027 to KER-029, `CRDT.snapshot()`, `CRDT.fromSnapshot(snapshot, newReplicaId)`, UI Rejoin button.
  - Done (2026-11-28): `rejoin.ts`, `rejoinSession.ts`, the two wire messages in `protocol.ts`, the Rejoin banner in `App.tsx`; see the Rejoin bullet in `STATUS.md`. 12 new tests (219 in the app), 35 mutants caught. Demo D6 in real Edge, driven by a script, on a local build of the Pages artifact: 39 of 39 checks, two cycles (`.0` to `.1` to `.2`), same list, edits accepted again.
  - **Gate C is NOT yet met on the deployed URL:** the live site still serves `b7c6bbf`, which has no Rejoin. After the next push has deployed, run D6 on the live site and record it.
  - Dependencies: DA-2, DA-6.

- [ ] DA-10. **Benchmark** (D7; R10)
  - `kernel/scripts/bench-gc.mjs`: N operations with one stalled replica versus the same run after eviction.
  - Dependencies: DA-2.

- [ ] DA-11. **Extract `shared/`** (R8; S5)
  - Transport, sync, panel and control page move to `shared/`, imported by alias. Both app folders must still exist.
  - Dependencies: DA-5, DA-6.

- [ ] DA-12. **Graveyard Whiteboard** (R8; Gate D)
  - Strokes as sequence elements (arrays of points), live drawing in two windows, undo by burying, the same panel and `/control`. Redeploy both apps.
  - Dependencies: DA-11.

- [ ] DA-13. **Package** (Gate E)
  - Bug-bash on the deployed URLs, README (one-minute explainer, screenshots, benchmark table, honest limits), video under 3 minutes, blog post, Kiro write-up.
  - Dependencies: DA-12, DA-10.

## Spill rule

If a day runs over, cut in this order: panel styling, the Whiteboard's extras, the benchmark's extra rows, snapshot UI polish. Never cut fencing, GC safety, payload redaction, the property tests or the Graveyard panel.
