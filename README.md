# Bones

A small, educational CRDT kernel: a Replicated Growable Array (RGA) with version vectors, membership and fencing, and tombstone reclamation, plus two demo apps. Built for the Kiroween 2026 hackathon (Skeleton Crew category) with spec-driven development in Kiro.

## Status

Last verified numbers (tests, coverage) are in [STATUS.md](STATUS.md). Summary:

| Part | State |
|------|-------|
| Kernel setup, types, utilities, event emitter (KER-001 to KER-005) | done |
| Kernel RGA: insert, delete and tombstones, sequence queries, payload reclamation primitive (KER-006 to KER-010) | done, with seeded property tests |
| Kernel op log, dependency buffering, membership and fencing, GC, snapshots, and the `CRDT` class | not started |
| `coordinator/` | placeholder |
| `apps/graveyard-whiteboard`, `apps/cursed-checklist` | placeholders (the two separate app folders the Skeleton Crew category requires) |

The `CRDT` class shown below is the planned public API. It does not exist yet.

## Run it

Requires Node.js 20 or newer.

```bash
# from the repo root
cd kernel
npm ci          # install the pinned dependencies
npm test        # run the kernel tests
cd ..
node scripts/quality-gate.mjs   # purity check, typecheck (src + tests), lint, tests
```

Other kernel scripts (run inside `kernel/`): `npm run typecheck`, `npm run build`, `npm run lint`, `npm run coverage`.

## Folder map

| Path | What it is |
|------|------------|
| `kernel/` | The pure TypeScript CRDT kernel (no DOM, network, storage, clocks or randomness in `kernel/src`) |
| `apps/graveyard-whiteboard/` | Collaborative drawing app (placeholder) |
| `apps/cursed-checklist/` | Collaborative to-do app (placeholder) |
| `coordinator/` | Small Node.js coordinator service (placeholder) |
| `scripts/` | Guard scripts used by the hooks and by hand: `check-purity.mjs`, `check-submission.mjs`, `quality-gate.mjs` |
| `.kiro/specs/crdt-kernel/` | Requirements, design and task list the code is built from |
| `.kiro/steering/` | Project context and technical conventions for the Kiro agent |
| `.kiro/hooks/` | Kiro agent hooks |
| `STATUS.md` | The single current-status document |
| `docs/archive/` | Older status documents, kept as history only |
| `BONES_PROJECT_SPEC.md` | The full project brief |

## What this is, and what it is not

Allowed claims, from the project spec (section 3.4):

- A small, educational CRDT kernel.
- The RGA is tested with seeded property-based tests (fast-check). More properties are specified and still to be written.
- It aims to make tombstone reclamation, membership and fencing visible (the Graveyard panel in the apps).
- It uses a small coordinator for membership and compaction authorization; edits are peer-to-peer. (Design; the coordinator is not built yet.)
- Evicted peers must rejoin from a snapshot. (Design; snapshots are not built yet.)

It is **not** a new CRDT algorithm, **not** production-ready, **not** a replacement for Yjs, Automerge or Loro, **not** fully decentralized (membership needs the coordinator), and **not** formally proven correct.

## Design in brief

- **Op IDs** are strings `` `${replicaId}:${seq}` `` (type `OpIdKey`), never objects.
- **The RGA is an anchor tree.** Each element is a child of the element it was inserted after (or of HEAD). The sequence is an iterative depth-first traversal. Siblings are ordered **newest first** by `(lamport, replicaId)`, compared by code unit (never `localeCompare`). A local insert therefore lands immediately after its anchor, and an element's descendants always stay contiguous.
- **Version vectors** track the highest *contiguous* applied sequence per replica; buffered operations never advance them. An operation that changes nothing (for example a second concurrent delete of the same element) still counts as applied.
- **Fencing** of edit operations is by author and eviction cutoff, never by the operation's `epoch` field. Control messages are fenced separately by epoch and membership.
- **Eviction** is manual only (an operator action), in two phases: publish the new membership with a per-author cutoff, then complete once every surviving replica has confirmed it holds the evicted replica's operations up to that cutoff.
- **Garbage collection (Stage 1)** reclaims the payload of a deleted element once any delete of it is causally stable, and keeps the structural node so it still works as an anchor.
- **Kernel purity:** no `Date.now()`, `Math.random()`, DOM, network or storage in `kernel/src`. `scripts/check-purity.mjs` enforces it.

Algorithm numbering follows `.kiro/specs/crdt-kernel/design.md`: 1 insert (RGA tree), 2 delete, 3 apply remote operation (fencing, duplicates, dependency buffering), 4 contiguous version-vector update, 5 stable frontier, 6 Stage 1 GC, 7 snapshot creation, 8 snapshot rejoin.

## Kiro hooks, and what they do not cover

Four hooks live in `.kiro/hooks/`:

| Hook | Trigger | Does |
|------|---------|------|
| `kernel-purity-guard` | File Save, on `kernel/src/**/*.ts` | runs `scripts/check-purity.mjs` |
| `kernel-quality-gate` | Agent Stop | runs `scripts/quality-gate.mjs --hook` (purity, typecheck, lint, tests) |
| `submission-check` | Session Start | runs `scripts/check-submission.mjs` |
| `task-done-bookkeeping` | Post Task Execution | asks the agent to run the gate, tick `tasks.md` only when acceptance criteria are met by passing tests, update `STATUS.md`, and commit |

Limits, stated plainly:

- Per the Kiro documentation, the file-event triggers (File Create, File Save, File Delete) fire when **the agent** changes files. The purity guard therefore protects the agent's edits only; it does not see edits you make by hand in the editor.
- That gap is covered by CI (`.github/workflows/ci.yml`), which runs the same quality gate and the submission check on every push and pull request.
- The hooks have not been exercised in a long unattended agent run. Treat them as guard rails, not as proof of correctness.

## Planned public API (not implemented yet)

```typescript
const crdt = new CRDT('site1.0');

const a = crdt.insert(undefined, 'Hello');   // insert at the start
const b = crdt.insert(a.id, ' World');       // insert after element a

crdt.getSequence();                          // visible Element[] in order
crdt.getVV();                                // version vector

crdt.applyOp(remoteOp);                      // apply an operation from another replica

const snapshot = crdt.snapshot();
const rejoined = CRDT.fromSnapshot(snapshot, 'site1.1'); // a returning replica uses a NEW replica ID
```

## Core types

From `kernel/src/types.ts`:

```typescript
type OpIdKey = `${string}:${number}`;

interface Operation<T> {
  id: OpIdKey;
  type: 'insert' | 'delete';
  anchor?: OpIdKey;        // insert: position after this element (undefined = HEAD)
  target?: OpIdKey;        // delete: which element
  value?: T;               // insert only
  lamport: number;
  replicaId: string;
  epoch?: number;          // diagnostic only, never used for fencing
}

interface Element<T> {
  id: OpIdKey;
  anchor: OpIdKey | undefined;   // parent in the RGA tree
  lamport: number;
  value?: T;
  deleted: boolean;
  deletedAt?: OpIdKey;
  payloadReclaimed: boolean;
}

type VersionVector = Map<string, number>;   // replicaId -> highest contiguous applied seq
```

## Property tests

18 correctness properties are specified in `design.md`. Implemented so far (all seeded, 200 runs each), for the RGA:

- Convergence: any causal delivery order gives the identical sequence.
- Idempotence: re-applying operations changes nothing.
- Subtree contiguity at any depth.
- Sibling-order invariant (newest first, child newer than parent).
- A delete changes visibility only, never structural order.
- A local insert at visible index k lands at visible index k.

The test suite was also mutation-checked by hand: flipping the sibling order, or removing the replicaId tie-break, makes tests fail.

## Specification

Full specification documents are in `.kiro/specs/crdt-kernel/`:

- `requirements.md`: the formal requirements
- `design.md`: algorithms, data structures and invariants
- `tasks.md`: 80 implementation tasks in 10 phases

## Known limitations

- A single trusted coordinator (no consensus protocol).
- No Stage 2 GC: tombstones are retained forever; only payloads are reclaimed.
- No sharding: every replica holds the whole document.
- Sequence (RGA) only: no maps, sets or counters.
- An evicted peer cannot merge old edits beyond its cutoff; it must rejoin from a snapshot as a new replica.
- The kernel assumes replicas do not forge or alter operations. For example, `applyInsert` ignores a second operation that reuses an existing ID even if its contents differ. That is correct for honest replicas but gives no protection against a buggy or malicious peer. The coordinator's frontier likewise assumes replicas report their version vectors honestly.
- Educational scope: not optimized for production performance.

## Prior art

crdt.tech, the RGA paper (Roh et al.), Kleppmann and Beresford's JSON CRDT paper, Shapiro et al.'s CRDT paper, Yjs, Automerge and Loro. This project is an independent, from-scratch implementation for learning.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Keerthivasan S.
