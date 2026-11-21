# Bones Project — Start Here

## ✅ Pre-Implementation Checklist COMPLETE

All submission blockers and code-blocking issues have been fixed. You are **ready to start implementation**.

---

## Quick Reference

| Item | Location | Status |
|------|----------|--------|
| **Project Spec** | `BONES_PROJECT_SPEC.md` | ✅ Reference only (don't modify) |
| **Formal Requirements** | `.kiro/specs/crdt-kernel/requirements.md` | ✅ Fixed and verified |
| **Design & Algorithms** | `.kiro/specs/crdt-kernel/design.md` | ✅ Fixed and verified |
| **80 Implementation Tasks** | `.kiro/specs/crdt-kernel/tasks.md` | ✅ Fixed and verified |
| **Product Context** | `.kiro/steering/product.md` | ✅ Created |
| **Tech Stack & Conventions** | `.kiro/steering/tech.md` | ✅ Created |
| **Build Files** | `LICENSE`, `.gitignore`, `README.md` | ✅ Complete |
| **Fixes Applied** | `SPEC_REVIEW_FIXES_APPLIED.md` | ✅ Documented |

---

## Phase 1: Get Set Up (Days 1–2)

**Tasks: KER-001 to KER-005** (Est. 8–12 hours)

```bash
cd /Bones/kernel

# 1. Initialize repo structure (KER-001)
npm init -y
npm install --save-exact typescript@5.3.3 vitest@1.1.0 fast-check@4.1.0

# 2. Create TypeScript config (KER-001)
npx tsc --init --strict

# 3. Set up Vitest (KER-002)
npm install --save-exact @vitest/ui
npm run test  # Should run (no tests yet, should pass)

# 4. Test fast-check setup (KER-003)
# Write a simple property test to verify setup

# 5. Implement types.ts (KER-004)
# Core interfaces: Operation, Element, OpIdKey, VersionVector, etc.

# 6. Implement utils.ts + events.ts (KER-005)
# Deterministic comparison, serialization, simple event emitter
```

**Acceptance Criteria Checklist:**
- [ ] TypeScript compiles with `npm run build`
- [ ] `npm run test` passes (no tests yet)
- [ ] ESLint configured and runs clean
- [ ] Seeded tests produce deterministic results
- [ ] All 7 core types exported from `src/index.ts`

---

## Phase 2: Core Modules (Days 3–10)

**Tasks: KER-006 to KER-029** (Est. 60–80 hours)

Work through each module in dependency order (see `tasks.md` waves 1–4):

1. **Lamport Clock** (KER-006) — local clock, increment, update
2. **RGA** (KER-007 to KER-010) — insert, delete, position, tombstones
3. **Version Vector** (KER-011 to KER-014) — merge, partial order, contiguity
4. **OpLog** (KER-015 to KER-017) — append, dedup, replay
5. **Membership** (KER-018 to KER-022) — epochs, eviction, cutoffs
6. **GC** (KER-023 to KER-026) — frontier, reclamation, stats
7. **Snapshot** (KER-027 to KER-029) — serialization, rejoin

**Each module task has:**
- ✅ Acceptance Criteria (what "done" means)
- ✅ Dependencies (what to build first)
- ✅ Validation Strategy (how to test)

**Key Rules:**
- **Kernel Purity**: NO `Date.now()`, `Math.random()`, DOM, network, storage
- **String Op IDs**: Always use `` `${replicaId}:${seq}` ``, never objects
- **Code-Unit Comparison**: Use `a < b ? -1 : a > b ? 1 : 0`, never `localeCompare()`
- **Immutability**: Return new objects; document copy-on-write patterns

---

## Phase 3: Orchestrator & Testing (Days 11–18)

**Tasks: KER-030 to KER-037** (Est. 40–50 hours)

1. **CRDT Class** (KER-030 to KER-033) — orchestrate all modules
2. **Testing Infrastructure** (KER-034 to KER-037) — network sim, arbitraries, fixtures

**Then run Unit Tests (KER-038 to KER-046) in parallel as modules complete**

---

## Phase 4: Properties & Integration (Days 19–24)

**Tasks: KER-047 to KER-069** (Est. 40–50 hours)

- **18 Property-Based Tests** (KER-047 to KER-064) — correctness verification
- **5 Integration Tests** (KER-065 to KER-069) — multi-replica convergence

**Coverage Goal**: > 85% for core modules

---

## Phase 5: Documentation & Apps (Days 25–27)

**Tasks: KER-070 to KER-080** (Est. 30–40 hours)

1. **Documentation** (KER-070 to KER-073) — API docs, guides, rationale
2. **Graveyard Whiteboard** (KER-079) — collaborative drawing with Graveyard panel
3. **Cursed Checklist** (KER-080) — collaborative to-do with membership status

---

## Key Design Decisions (Already Made)

| Decision | Value | Rationale |
|----------|-------|-----------|
| **Op IDs** | `` `${replicaId}:${seq}` `` strings | Serializable, hashable, no conversion bugs |
| **CRDT API** | `insert(anchorId, value)` (no replicaId) | Instance already knows its replica |
| **Fencing** | Author + cutoff, NOT epoch | Simpler, more direct, epoch is diagnostic-only |
| **Frontier** | min(active members' VVs) | Ensures no blocked GC while active |
| **GC Strategy** | Stage 1 only (payload reclaim, keep anchors) | Simpler than Stage 2; anchors preserve structure |
| **RGA Sort** | Ascending by (lamport, replicaId) | Deterministic concurrent ordering |

---

## Success Metrics (Target: Dec 3, 2026)

- ✅ 80 tasks completed (0 cutting MUST tasks)
- ✅ 18 property-based tests pass (≥100 iterations each)
- ✅ 2 demo apps sync across tabs with Graveyard panel
- ✅ Unit test coverage > 85%
- ✅ Zero `Date.now()`, `Math.random()` in `/kernel/src/`
- ✅ All Devpost submission rules met
- ✅ Kiro spec-driven workflow documented (hooks + steering visible)

---

## Debugging Tips

1. **Determinism Failures**: Use `fc.seed(12345)` to reproduce exact sequence
2. **Type Errors**: All Op IDs must be strings `` `replicaId:seq` ``; never objects
3. **Stack Overflow in Tests**: Use iterative work queue for buffer unblocking, not recursion
4. **Flaky Tests**: No `setTimeout` or real clocks; use deterministic simulation
5. **Circular Imports**: Keep types.ts import-free; import types FROM types.ts, not from it

---

## Reference Files

| File | Purpose | Read First? |
|------|---------|------------|
| `BONES_PROJECT_SPEC.md` | Full project brief (40+ pages) | ✅ Yes (context) |
| `README.md` | Project overview | ✅ Yes (quick start) |
| `requirements.md` | 18 formal requirements | ✅ Yes (before coding) |
| `design.md` | 8 algorithms + data structures | ✅ Yes (during implementation) |
| `tasks.md` | 80 actionable tasks | ✅ Yes (use daily) |
| `.kiro/steering/product.md` | Spooky framing & principles | ✅ Check before demo |
| `.kiro/steering/tech.md` | API signatures & conventions | ✅ Yes (code guidelines) |
| `SPEC_REVIEW_FIXES_APPLIED.md` | Summary of all fixes | Read for understanding |

---

## Ready to Begin?

**Start with KER-001 in `tasks.md`:**

```
### Phase 1: Project Setup

- [ ] 1. **Repository Structure and TypeScript Configuration** (KER-001)
  - Initialize `/kernel` directory...
  - Configure `tsconfig.json`...
  - Set up `package.json`...
```

---

## Questions During Implementation?

1. **Spec unclear?** → Check `.kiro/specs/crdt-kernel/` (requirements + design)
2. **API design?** → Check `.kiro/steering/tech.md` (type signatures)
3. **Code style?** → Check `.kiro/steering/tech.md` (conventions)
4. **Task stuck?** → Check acceptance criteria + validation in `tasks.md`
5. **Need examples?** → Check `README.md` (usage examples)

---

**Good luck! The spec is solid. Focus on clean code, comprehensive tests, and the honest claims table. You've got this.** 🦴👻

---

*Last updated: 2026-11-22 (spec review fixes applied)*
