# Bones

A small, educational CRDT kernel: a Replicated Growable Array (RGA) with version vectors, membership and fencing, and tombstone reclamation, plus two demo apps. Built for the Kiroween 2026 hackathon (Skeleton Crew category) with spec-driven development in Kiro.

**Live demo:** <https://keerthivasan-skv.github.io/Bones/>. The Cursed Checklist is at [`/cursed-checklist/`](https://keerthivasan-skv.github.io/Bones/cursed-checklist/) and its control page (the coordinator) at [`/cursed-checklist/control.html`](https://keerthivasan-skv.github.io/Bones/cursed-checklist/control.html). Open the control page in one window and the app in two more windows of the same browser (tabs sync through `BroadcastChannel`, so other browsers and devices are not connected). Without the control page open, nothing is reclaimed, and the app's panel says so.

## Status

Last verified numbers (tests, coverage) are in [STATUS.md](STATUS.md). Summary:

| Part | State |
|------|-------|
| Kernel setup, types, utilities, event emitter (KER-001 to KER-005) | done |
| Kernel RGA: insert, delete and tombstones, sequence queries, payload reclamation primitive (KER-006 to KER-010) | done, with seeded property tests |
| Kernel version-vector rules (`advanceContiguous`, `stableFrontier`), append-only op log with replay, dependency buffer (KER-011, 013 to 017) | done, tested; mutation-checked |
| Kernel `CRDT` class: local insert/delete, the `applyOp` pipeline (validation, duplicates, buffering, no-op handling, Lamport absorption, iterative unblocking), queries (including `opsSince` for catch-up and `getAllElements` for tombstones), events, Lamport-time limit | working and tested (fencing: see the membership row below) |
| Kernel membership, epochs and fencing by author and cutoff (KER-018 to KER-022) | done, 108 tests, mutation-checked |
| Kernel stable frontier, Stage 1 GC (payloads only; the tombstones stay) and the operation-log redaction that makes the freed memory real (KER-023 to KER-026) | done, tested, mutation-checked |
| Kernel eviction prepare phase (`holdAuthor`), snapshots and rejoin as a new incarnation (KER-027 to KER-033) | done, tested, mutation-checked |
| Gate A property tests: frontier safety, GC safety including the redacted log, fencing, snapshot rejoin (22 + 6 properties) | done, seeded |
| `coordinator/` | the pure decision core (membership, frontier, manual two-phase eviction) is built and tested (104 tests); it runs in the browser on the Checklist's control page. No Node service |
| `apps/cursed-checklist` | works: sync across tabs, the control page (Exorcise), the Graveyard panel, Stall and Stress buttons (207 tests; the demo script D1 to D5 passed on the deployed site in real Edge, driven by a script). Live at the URL above. Rejoin is not built in the app yet |
| `apps/graveyard-whiteboard` | placeholder (the second app folder the Skeleton Crew category requires) |

Replicas exchange operations and converge, a stalled replica holds back garbage collection, a manual eviction lets it move, the evicted replica's later edits are refused, and a returning replica rejoins from a snapshot under a new ID (see the examples below). What is NOT done yet: the Rejoin button in the app, the second app, the demo video and the write-up. Numbers are in [STATUS.md](STATUS.md).

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
| `apps/cursed-checklist/` | Collaborative to-do app with the control page and the Graveyard panel (works; see its README) |
| `coordinator/` | The coordinator's pure decision core (membership, frontier, manual eviction); no standalone service |
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
- The kernel is tested with seeded property-based tests (fast-check) and hand-run mutation checks. `design.md` specifies 18 properties; eight property groups are implemented (see STATUS.md for which ones and why the rest were collapsed).
- It aims to make tombstone reclamation, membership and fencing visible (the Graveyard panel in the apps).
- It uses a small coordinator for membership and compaction authorization; edits are peer-to-peer. (Built as a pure core that runs on the Checklist's control page; there is no standalone service.)
- Evicted peers must rejoin from a snapshot, as a new replica. (Built in the kernel; the Rejoin button in the app is not.)

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

`applyOp` outcomes: `applied` (possibly unblocking buffered operations), `buffered` (a dependency is missing; never dropped, version vector not advanced), `duplicate`, `fenced` (the author was evicted and the operation is beyond its cutoff, or the author is not a member; nothing changes. A replica created without a membership view accepts every author). Malformed operations throw `TypeError` and change nothing; that includes a Lamport time above `MAX_LAMPORT` (2^48), and a replica whose own clock reaches that limit refuses further local operations (`RangeError`). Use `deserializeOp` for operations received as JSON and `assertValidOperation` for any other untrusted operation.

Catch-up: a transport that does not replay old messages (for example `BroadcastChannel`) should have each replica send its version vector now and then and answer a peer's vector with `opsSince(thatVector)`. A peer holding buffered operations can only send what it has applied, so catching up can take more than one round; repeating the exchange converges.

Membership, garbage collection and snapshots:

```typescript
import { CRDT, computeStableFrontier, createMembership, removeReplica, serializeSnapshot, deserializeSnapshot } from '@bones/kernel';

const members = createMembership(['alice.0', 'bob.0']);       // epoch 0; edits are fenced by AUTHOR and CUTOFF
const alice = new CRDT<string>('alice.0', members);

// eviction, phase 1: the survivors freeze the target and report how much of it they hold
const seq = alice.holdAuthor('bob.0');                         // contiguous applied seq: the reply to the coordinator
// phase 2: the coordinator publishes the view; the cutoff is the max of the survivors' replies
alice.updateMembership(removeReplica(members, 'bob.0', seq));  // epoch 1; bob's later operations are refused ("fenced")

// garbage collection: payloads (not tombstones) go once every member has applied the delete
const frontier = computeStableFrontier(acks, new Set(['alice.0']));
alice.updateStableFrontier(frontier, alice.getMembershipView().epoch);   // applied only at the current epoch
alice.getGCStats();                                              // tombstoneCount stays; payloadsReclaimed and bytesSaved (estimated: JSON length) grow

// rejoin: a snapshot (validated when read back), restored under a NEW replica ID
const json = serializeSnapshot(alice.snapshot());
const rejoined = CRDT.fromSnapshot(deserializeSnapshot(json), 'bob.1');   // 'bob.0' itself is refused: an evicted ID never returns
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

Membership, garbage collection and snapshots (seeded, 150 runs each, in `frontier.properties.test.ts`, `gc.properties.test.ts`, `fencing.properties.test.ts` and `snapshot.properties.test.ts`): 6 frontier-safety, 10 GC-safety, 6 fencing and 6 snapshot-rejoin properties. They check, for example, that GC never changes what is visible, that a payload is reclaimed only when every member has the delete, and that a replica restored from a snapshot converges with one that stayed connected. These are tests, not a proof.

The test suite was also mutation-checked by hand: each guard in the RGA, version-vector rules, op log, buffer, validator and `CRDT` pipeline was removed in turn (about 75 distinct deliberate bugs for that code alone; 278 caught across the kernel and the coordinator, summed from the commit messages), and a test had to fail. Survivors found this way were fixed by adding tests, not by weakening the check.

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
- The kernel assumes replicas do not forge or alter operations. For example, `applyInsert` ignores a second operation that reuses an existing ID even if its contents differ. That is correct for honest replicas but gives no protection against a buggy or malicious peer. The coordinator's frontier likewise assumes replicas report their version vectors honestly. The kernel also does not limit the size of the dependency buffer: a peer that sends many operations with a gap before them makes all of them stay buffered (5,000 were tried), so it assumes peers are honest. A peer that sends an operation at the Lamport limit stops other replicas from creating local operations.
- A replica that loses its state must come back with a new replica ID. If it reused its old ID, it would issue Op IDs that already exist (for example `alice:1` again, with different content); other replicas drop those as duplicates and silently diverge. The demo apps therefore create a new replica ID on every page load and never store it.
- A replica restored from a snapshot starts a fresh operation log, so it can only answer a hello with operations after the snapshot point.
- The reclaimed-bytes numbers are estimates: the JSON length of a payload, not measured memory.
- The demo apps sync through `BroadcastChannel`: tabs of one browser on one origin. Other browsers and devices are not connected, and nothing is stored between page loads.
- Educational scope: not optimized for production performance.

## Prior art

crdt.tech, the RGA paper (Roh et al.), Kleppmann and Beresford's JSON CRDT paper, Shapiro et al.'s CRDT paper, Yjs, Automerge and Loro. This project is an independent, from-scratch implementation for learning.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Keerthivasan S.
