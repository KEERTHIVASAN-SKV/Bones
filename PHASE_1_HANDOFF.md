# Phase 1 Handoff Summary

**Status**: ✅ All Phase 1 tasks completed and verified  
**Date**: November 22, 2026  
**Next**: Phase 2 (KER-006: Lamport Clock)

---

## What You Have

### Repo Structure (Real on Disk)
```
Bones/
├── kernel/
│   ├── src/
│   │   ├── index.ts              [export all public APIs]
│   │   ├── types.ts              [core interfaces: OpIdKey, Operation, Element, etc.]
│   │   ├── utils.ts              [deterministic helpers: parseOpId, compareVersionVectors, etc.]
│   │   ├── events.ts             [EventEmitter class]
│   │   └── [lamport, rga, vv, etc.] [to be implemented in Phase 2+]
│   ├── tests/
│   │   ├── utils.test.ts         [7 passing tests]
│   │   └── [lamport.test.ts, ...] [to be added in Phase 2+]
│   ├── testing/                   [shared test infrastructure - to be added]
│   ├── package.json              [TS 5.6, Vitest 2.0, fast-check 3.19]
│   ├── tsconfig.json             [strict mode, ES2020]
│   ├── vitest.config.ts          [Node.js environment]
│   └── README.md                 [kernel-specific docs]
├── apps/
│   ├── graveyard-whiteboard/src
│   └── cursed-checklist/src
├── coordinator/src
├── .kiro/
│   ├── specs/crdt-kernel/
│   │   ├── requirements.md       [14 formal requirements]
│   │   ├── design.md             [8 algorithms, BUT OpId type is stale]
│   │   ├── tasks.md              [80 tasks across 10 phases]
│   │   └── .config.kiro
│   ├── steering/
│   │   ├── tech.md               [SOURCE OF TRUTH for types/APIs]
│   │   └── product.md            [graveyard metaphor, core principles]
│   └── hooks/
│       └── validate-spec-exists.json [pre-commit validation]
├── LICENSE, .gitignore, README.md
└── PHASE_1_COMPLETE.md           [this phase's summary]
```

### Build & Test Status

```bash
$ npm run build      # ✅ 0 errors, 0 warnings
$ npm test           # ✅ 7/7 tests passing, 696ms
```

### Key Decisions Made in Phase 1

| Decision | Why | Reference |
|----------|-----|-----------|
| **OpIdKey is a string** `` `${replicaId}:${seq}` `` | Eliminates object conversion bugs, enables Map keys directly | steering/tech.md ✅ (design.md ❌ stale) |
| **CRDT.insert(anchorId, value)** no replicaId param | Instance already knows its replica; prevents mismatches | steering/tech.md ✅ (design.md ❌ stale) |
| **Deterministic utilities** (no randomization) | Enables reproducible testing with fast-check seeds | types.ts, utils.ts JSDoc |
| **EventEmitter with insertion-order delivery** | Deterministic callback execution | events.ts |
| **Immutability default** | Return new objects; never mutate input | types.ts JSDoc |

### Source of Truth Hierarchy

When implementing Phases 2–5, follow this order:

1. **`.kiro/steering/tech.md`** ← PRIMARY (types, APIs, conventions)
2. **`.kiro/specs/crdt-kernel/design.md`** ← SECONDARY (algorithms, BUT OpId type is stale)
3. **`.kiro/specs/crdt-kernel/requirements.md`** ← Reference (14 formal requirements)

**Warning**: `design.md` has stale OpId definition (object instead of string). Use steering/tech.md's OpIdKey everywhere.

---

## What's NOT Done (By Design)

- `/kernel/src/lamport.ts` — Lamport clock (Phase 2, KER-006)
- `/kernel/src/rga.ts` — Replicated Growable Array (Phase 2–3, KER-006–019)
- `/kernel/src/vv.ts` — Version Vector wrapper (Phase 2–3)
- `/kernel/src/oplog.ts` — Operation log (Phase 3)
- `/kernel/src/membership.ts` — Membership management (Phase 4)
- `/kernel/src/gc.ts` — Garbage collection (Phase 4)
- `/kernel/src/snapshot.ts` — Snapshots & rejoin (Phase 5)
- `/kernel/src/crdt.ts` — Main CRDT orchestrator (Phase 5)
- `/kernel/testing/` — Test infrastructure (arbitraries, fixtures, builders)
- `/apps/*/` and `/coordinator/` — App implementations (later phases)

**These are explicitly deferred**, not forgotten.

---

## For Phase 2: What to Read First

### Spec Documents
1. `design.md` §2 (Lamport Clock Algorithm) — 2 pages
2. `design.md` §3 (RGA Algorithm) — 3 pages
3. `design.md` Algorithm 1 (Lamport clock pseudocode) — 1 page
4. `design.md` Algorithm 2 (RGA insert/delete) — 2 pages
5. `requirements.md` §2–3 (Lamport, RGA requirements) — 2 pages

### Code to Review
1. `steering/tech.md` §Type Definitions (review OpIdKey, Operation, Element)
2. `kernel/src/types.ts` (all types are defined here)
3. `kernel/src/utils.ts` (helpers like compareVersionVectors already exist)

### New Files to Create (Phase 2–3)
- `kernel/src/lamport.ts` (Lamport clock, ~100 lines)
- `kernel/src/rga.ts` (RGA, ~300 lines)
- `kernel/src/vv.ts` (VersionVector wrapper, ~150 lines)
- `kernel/tests/lamport.test.ts` (unit tests)
- `kernel/tests/rga.test.ts` (unit tests)
- `kernel/tests/vv.test.ts` (unit tests)

---

## Post-Fix Verification Findings (Apply These If Needed)

The post-fix verification document identified a few things still broken in the repo:

| Item | Status | Action |
|------|--------|--------|
| design.md OpId type | ❌ Stale | Don't implement it; use steering/tech.md instead ✅ |
| Algorithm 3 pseudocode | ❌ Recursive | Use iterative work queue instead ✅ |
| tasks.md numbering | ❌ Off by 1 | Not blocking; use task titles not numbers |
| README "79 tasks" | ❌ Should be "80" | Minor cosmetic fix |

**None of these block Phase 2 start.** We've already avoided the OpId pitfall by following steering/tech.md.

---

## Running Tests & Builds (Future Phases)

### After adding new modules (Phases 2+):

```bash
# Update kernel/src/index.ts to export new modules
export { Lamport } from './lamport.js';
export { RGA } from './rga.js';
export { VersionVectorWrapper } from './vv.js';

# Compile
npm run build

# Test
npm test

# Watch mode (for development)
npm run test:watch
```

### Adding tests:

```bash
# File: kernel/tests/lamport.test.ts
import { describe, it, expect, fc } from 'vitest';
import { Lamport } from '../src/lamport.js';

describe('Lamport Clock', () => {
  it('increments on local operations', () => {
    const clock = new Lamport('replica-1');
    const ts1 = clock.tick();
    const ts2 = clock.tick();
    expect(ts2).toBe(ts1 + 1);
  });
  // ... more tests
});

# Run
npm test
```

---

## Immediate Next Steps (For Phase 2)

1. ✅ Read `design.md` §2 (Lamport Clock — 5 mins)
2. ✅ Open `kernel/src/lamport.ts` (create new file)
3. ✅ Implement Lamport class based on Algorithm 1 pseudocode
4. ✅ Write unit tests in `kernel/tests/lamport.test.ts`
5. ✅ Run `npm test` — should all pass
6. ✅ Repeat for RGA (design.md §3, Algorithm 2)

**Estimated duration**: 15–20 hours for all Phase 2–3 tasks.

---

## Questions?

Refer to:
- **Tech decisions**: `steering/tech.md`
- **API signatures**: `steering/tech.md` §CRDT API Signature
- **Algorithms**: `design.md` §Algorithms (1–8)
- **Requirements**: `requirements.md` (14 reqs, numbered)
- **Task tracking**: `tasks.md` (80 tasks, 10 phases, 13 dependency waves)

---

**Happy coding! Phase 1 → 2 handoff complete. 🦴**

---

## Superseded (2026-11-22)

Parts of this handoff are out of date. `design.md` was synced to `kernel/src/types.ts` (it no longer defines an `OpId` object or uses recursion in Algorithm 3), and the spec was corrected for the RGA tree structure, no-op handling, fencing, eviction, and snapshot rejoin. For the current state and the remaining open items, read the addendum at the end of `SPEC_REVIEW_FIXES_APPLIED.md` and `PHASE_1_COMPLETE.md` ("Correction").

When starting KER-006, implement the RGA as an anchor tree per `design.md` Algorithm 1 (not a flat array scan), with siblings ordered newest-first.
