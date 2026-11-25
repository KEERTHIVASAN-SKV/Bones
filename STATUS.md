# Bones: Status

Last updated: 2026-11-24 (after KER-010). Submission deadline: Dec 3, 2026.

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

Last verified run: typecheck, build, lint and purity clean; 82 tests pass; line coverage of `kernel/src` only is 96.33% (`rga.ts` 98.5%, `utils.ts` 94.44%, `events.ts` 97.5%). `src/types.ts` is excluded because it has no runtime code. Earlier figures (95.7%) also counted test and config files and are superseded.

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
| KER-011 onward | not started. Next: KER-011 (VV module), then KER-015 (OpLog) and KER-018 (membership) |

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

## Submission checklist (Devpost / Skeleton Crew)

- [x] MIT `LICENSE` at repo root
- [x] `.kiro/` committed (specs, steering, hooks); not gitignored
- [x] Two separate app folders: `apps/graveyard-whiteboard`, `apps/cursed-checklist` (placeholders)
- [x] `coordinator/` folder (placeholder)
- [ ] Working kernel, two working apps, public URL(s)
- [ ] Demo video, write-up covering specs, hooks and steering
- [ ] README states limitations plainly: educational implementation, not production-ready, not a new algorithm, not a Yjs/Automerge/Loro replacement
