# Bones

A small, educational CRDT kernel: a Replicated Growable Array (RGA) with version vectors, membership and fencing, and tombstone reclamation, plus two demo apps. Built for the Kiroween 2026 hackathon (Skeleton Crew category) with spec-driven development in Kiro.

## Status

Last verified numbers (tests, coverage) are in [STATUS.md](STATUS.md). Summary:

| Part | State |
|------|-------|
| Kernel setup, types, utilities, event emitter (KER-001 to KER-005) | done |
| Kernel RGA: insert, delete and tombstones, sequence queries, payload reclamation primitive (KER-006 to KER-010) | done, with seeded property tests |
| Kernel version-vector rules (`advanceContiguous`, `stableFrontier`), append-only op log with replay, dependency buffer (KER-011, 013 to 017) | done, tested; mutation-checked |
| Kernel `CRDT` class: local insert/delete, the `applyOp` pipeline (validation, duplicates, buffering, no-op handling, Lamport absorption, iterative unblocking), queries (including `opsSince` for catch-up and `getAllElements` for tombstones), events, Lamport-time limit | working and tested; **fencing is a stub** (accepts everything) until membership exists |
| Kernel membership and eviction, stable frontier, Stage 1 GC, snapshots and rejoin | not started |
| `coordinator/` | placeholder |
| `apps/graveyard-whiteboard`, `apps/cursed-checklist` | placeholders (the two separate app folders the Skeleton Crew category requires) |

Two replicas can already exchange operations and converge (see the example below). Membership, eviction, GC and snapshots are the next pieces; until they exist, `CRDT` accepts operations from any author.

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

## Public API (kernel/src/index.ts)

Working today:

```typescript
import { CRDT } from './kernel/src/index.js';

const alice = new CRDT<string>('site1.0');
const bob = new CRDT<string>('site2.0');

const h = alice.insert(undefined, 'H');   // insert at the start; returns the operation to broadcast
const i = alice.insert(h.id, 'i');        // insert right after h

bob.applyOp(h);                           // returns { status, changed, unblocked, fenced }
bob.applyOp(i);                           // out-of-order or duplicate delivery is fine: buffered or ignored

bob.getSequence();                        // visible elements, in order (copies)
bob.getVV();                              // highest contiguous applied seq per replica
bob.getAllElements();                     // every element INCLUDING tombstones (for the Graveyard panel)
alice.opsSince(bob.getVV());              // what bob still lacks, in causal order (catch-up)
bob.delete(i.id);                         // tombstone an element; returns the operation to broadcast
bob.on('sequenceChanged', () => render());
```

`applyOp` outcomes: `applied` (possibly unblocking buffered operations), `buffered` (a dependency is missing; never dropped, version vector not advanced), `duplicate`, `fenced` (not produced yet: fencing is a stub). Malformed operations throw `TypeError` and change nothing; that includes a Lamport time above `MAX_LAMPORT` (2^48), and a replica whose own clock reaches that limit refuses further local operations (`RangeError`). Use `deserializeOp` for operations received as JSON and `assertValidOperation` for any other untrusted operation.

Catch-up: a transport that does not replay old messages (for example `BroadcastChannel`) should have each replica send its version vector now and then and answer a peer's vector with `opsSince(thatVector)`. A peer holding buffered operations can only send what it has applied, so catching up can take more than one round; repeating the exchange converges.

Planned, not implemented yet:

```typescript
const snapshot = alice.snapshot();
const rejoined = CRDT.fromSnapshot(snapshot, 'site1.1'); // a returning replica uses a NEW replica ID
alice.getStableFrontier();
alice.getGCStats();
alice.getMembershipView();
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

18 correctness properties are specified in `design.md`. Implemented so far (all seeded, 150 to 200 runs each). RGA:

- Convergence: any causal delivery order gives the identical sequence.
- Idempotence: re-applying operations changes nothing.
- Subtree contiguity at any depth.
- Sibling-order invariant (newest first, child newer than parent).
- A delete changes visibility only, never structural order.
- A local insert at visible index k lands at visible index k.

`CRDT` (multi-replica, with partial syncs, concurrent edits and concurrent duplicate deletes):

- Convergence: any shuffle of the same operations, with duplicates, gives identical replicas, including the original authors.
- Idempotence: delivering everything again changes nothing and emits no event.
- Version-vector contiguity: it never skips, never regresses, equals the applied prefix, and buffered operations never advance it.
- Delete-before-insert converges to the same result as insert-before-delete.
- The log holds each operation once, in an order that replays without buffering.
- A local insert at visible index k lands at index k after convergence, on both replicas (this fails without Lamport-clock absorption).
- Catch-up: repeating the `opsSince` exchange converges two or three replicas (and a late joiner), whatever order the catch-up operations arrive in.

The test suite was also mutation-checked by hand: each guard in the RGA, version-vector rules, op log, buffer, validator and `CRDT` pipeline was removed in turn (about 75 distinct deliberate bugs in total), and a test had to fail. Survivors found this way were fixed by adding tests, not by weakening the check.

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
- The kernel assumes replicas do not forge or alter operations. For example, `applyInsert` ignores a second operation that reuses an existing ID even if its contents differ. That is correct for honest replicas but gives no protection against a buggy or malicious peer. The coordinator's frontier likewise assumes replicas report their version vectors honestly. The kernel also does not limit the size of the dependency buffer: a peer that sends many operations with a gap before them makes all of them stay buffered (5,000 were tried), so it assumes peers are honest.
- Educational scope: not optimized for production performance.

## Prior art

crdt.tech, the RGA paper (Roh et al.), Kleppmann and Beresford's JSON CRDT paper, Shapiro et al.'s CRDT paper, Yjs, Automerge and Loro. This project is an independent, from-scratch implementation for learning.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Keerthivasan S.
