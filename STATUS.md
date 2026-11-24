# Bones: Status

Last updated: 2026-11-24. Submission deadline: Dec 3, 2026.

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

Last verified run: typecheck, build and lint clean; 37 tests pass; line coverage 91.55%.

## Tasks (`.kiro/specs/crdt-kernel/tasks.md`)

| Task | State |
|------|-------|
| KER-001 repo, tsconfig, eslint | done |
| KER-002 Vitest + coverage | done |
| KER-003 fast-check setup | partly done: fast-check runs seeded; arbitraries for Operation/Element/VV/MembershipView are not written yet |
| KER-004 types | done (`kernel/src/types.ts`) |
| KER-005 utils + events | done |
| KER-006 onward | not started. Next: KER-006 (RGA) |

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
| `kernel-purity-guard` | PostFileSave on `kernel/src/**/*.ts` | `node scripts/check-purity.mjs` |
| `kernel-quality-gate` | Stop | `node scripts/quality-gate.mjs` |
| `submission-check` | SessionStart | `node scripts/check-submission.mjs` |
| `task-done-bookkeeping` | PostTaskExec | asks the agent to run the gate, tick `tasks.md` honestly, update this file, commit |

The hook commands assume Kiro runs them from the repo root. That has not been confirmed.

## Open issues

- `tasks.md`: list numbers 23 to 39 are one higher than their KER IDs; headers KER-40 to KER-80 are not 3-digit padded; dependency lines mix padded and unpadded IDs; the waves JSON has not been re-verified against the task bodies.
- `requirements.md` headings skip number 16 (15 then 17); `design.md` "Validates" lines cite 16.x for the API requirement.
- README does not mention Algorithm 4 or the `/apps` folders.
- `npm audit` reports advisories in dev dependencies (not fixed; no `--force`).
- `BONES_NEXT_STEPS.md` (the plan the schedule comes from) is not in the repo.

## Submission checklist (Devpost / Skeleton Crew)

- [x] MIT `LICENSE` at repo root
- [x] `.kiro/` committed (specs, steering, hooks); not gitignored
- [x] Two separate app folders: `apps/graveyard-whiteboard`, `apps/cursed-checklist` (placeholders)
- [x] `coordinator/` folder (placeholder)
- [ ] Working kernel, two working apps, public URL(s)
- [ ] Demo video, write-up covering specs, hooks and steering
- [ ] README states limitations plainly: educational implementation, not production-ready, not a new algorithm, not a Yjs/Automerge/Loro replacement
