# CRDT Kernel - Technical Design Document

## Overview

The CRDT Kernel is a deterministic, pure TypeScript implementation of a Replicated Growable Array (RGA) sequence CRDT designed for offline-first collaborative applications. It manages causal consistency, duplicate suppression, membership-based eviction, and memory-efficient garbage collection through a clean API surface.

**Key Design Principles:**
- **Pure & Deterministic**: No `Date.now()`, `Math.random()`, DOM, network, or storage inside `/kernel`
- **Correctness-First**: Extensive property-based testing with fast-check; comprehensive unit tests
- **Memory-Efficient**: Stage 1 GC reclaims payload of causally stable deletes while retaining structural anchors
- **API Simplicity**: Clean public interface hiding implementation complexity
- **Educational Value**: Well-documented, from-scratch implementation suitable for learning

**Implementation Notes**:
- **Source of truth for names and types**: `kernel/src/types.ts` and `.kiro/steering/tech.md` (see its "Type Mapping" table). This document uses those names (`OpIdKey`, `anchor`, `target`, `activeMembers`, ...).
- **RGA is a tree**: each element hangs off its anchor; sequence order is an iterative depth-first traversal with siblings ordered newest-first. See Algorithm 1.
- **Unblocking buffered operations** uses an **iterative work queue**, never recursion. See Algorithm 3.
- **No-op operations are applied operations**: they are logged and advance the VV even when they change no state. See Algorithm 3.
- **Two separate fencing mechanisms**: edit operations are fenced by author + cutoff; control messages by epoch + membership. See requirements.md §10 "Fencing Architecture".

---

## Components and Interfaces

The CRDT Kernel is composed of eight core modules that work together to provide deterministic, memory-efficient collaborative editing:

### Module Overview

1. **Lamport Clock Module**: Tracks logical time for each replica; each op carries a Lamport timestamp computed as `max(local_clock, received_max) + 1`.
2. **RGA Module**: Maintains the replicated growable array as an anchor tree, handling insert/delete operations and deterministic conflict resolution by ordering siblings newest-first on `(lamport, replicaId)`; the sequence is a depth-first traversal of the tree.
3. **VersionVector (VV) Module**: Tracks causal dependencies using contiguous Version Vectors; enables dependency detection and stable frontier computation.
4. **OpLog Module**: Maintains an append-only log of operations; supports deduplication and per-replica querying.
5. **Membership Module**: Manages active replica sets and membership epochs with eviction cutoffs; enables membership-based fencing and safe garbage collection.
6. **Garbage Collector (GC) Module**: Performs Stage 1 payload reclamation for deleted elements based on the stable frontier; preserves structural anchors.
7. **Snapshot Module**: Serializes and deserializes kernel state; enables rejoin-from-snapshot workflows.
8. **CRDT Coordinator Class**: Orchestrates all modules; provides public API; emits events for application integration; manages operation buffering and dependency resolution.

### Module Interactions

```
Application Layer
  ↓ (insert, delete, applyOp, events)
CRDT Coordinator (orchestrator)
  ├→ RGA Module (sequence management)
  ├→ VersionVector Module (dependency tracking)
  ├→ OpLog Module (operation history)
  ├→ Membership Module (epoch and eviction)
  ├→ GC Module (payload reclamation)
  └→ Snapshot Module (serialization)
```

---

## Architecture

### High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                      Application Layer                       │
│  (Graveyard Whiteboard, Cursed Checklist)                    │
└───────────────────────┬──────────────────────────────────────┘
                        │ insert(), delete(), on()
                        │ getSequence(), snapshot()
┌───────────────────────▼──────────────────────────────────────┐
│                     CRDT Kernel (Pure)                        │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐   │
│  │   RGA Module   │  │  VersionVector │  │  OpLog       │   │
│  │   ────────     │  │  (VV) Module   │  │  Module      │   │
│  │ • Insert      │  │  ────────────  │  │  ────────    │   │
│  │ • Delete      │  │ • Contiguous   │  │ • Append-only│   │
│  │ • Traverse    │  │   tracking     │  │ • Dedup      │   │
│  │ • Sort by ID  │  │ • Partial order│  │ • Query by   │   │
│  │ • Anchoring   │  │ • Merge        │  │   replica    │   │
│  └────────────────┘  └────────────────┘  └──────────────┘   │
│           │                    │                │             │
│  ┌────────▼────────────────────▼──────────────▼──────────┐  │
│  │          CRDT Coordinator Class                       │  │
│  │  • Orchestrates all modules                          │  │
│  │  • Emits events (sequenceChanged, etc.)              │  │
│  │  • Manages state consistency                         │  │
│  └─────────┬────────────┬────────────┬──────────────────┘  │
│            │            │            │                     │
│  ┌─────────▼──┐  ┌──────▼─────┐  ┌──▼──────────────────┐  │
│  │ Membership  │  │  Garbage   │  │ Snapshot Module    │  │
│  │ Module      │  │  Collector │  │ ──────────────────  │  │
│  │ ───────────│  │  ────────  │  │ • Serialize state  │  │
│  │ • Epochs   │  │ • Stage 1  │  │ • Deserialize      │  │
│  │ • Eviction │  │   reclaim  │  │ • Rejoin logic     │  │
│  │ • Fencing  │  │ • Frontier │  │ • Metadata         │  │
│  │            │  │   tracking │  │                    │  │
│  └────────────┘  └────────────┘  └────────────────────┘  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                        ▲
                        │ applyOp(), membership updates
                        │ (from Transport/Coordinator)
┌───────────────────────┴──────────────────────────────────────┐
│        Transport & Coordinator Layer (Outside Kernel)        │
│  • BroadcastChannel / WebSocket                             │
│  • Coordinator Service (Node.js): membership, epoch mgmt    │
└──────────────────────────────────────────────────────────────┘
```

### Communication Paths

1. **Local Operations**: App calls `insert()` / `delete()` → RGA updates → Op added to OpLog → Event fired
2. **Remote Operations**: Transport calls `applyOp()` → Dependency buffering (VV checks) → RGA applies → Event fired
3. **Membership Changes**: Coordinator broadcasts membership update → Kernel updates Membership module → Fencing applied to future ops
4. **Stable Frontier**: Coordinator computes frontier from acked VVs → Kernel queries frontier → GC reclaims stable deletes
5. **Snapshots**: App calls `snapshot()` → Kernel serializes state → App transmits to rejoining replica → Rejoining replica calls `rejoinFromSnapshot()` + applies post-snapshot ops

---

## Data Models

This section defines the core data structures used throughout the CRDT Kernel. All data models are immutable or use copy-on-write semantics to maintain determinism and enable efficient testing.

### OpIdKey (Unique Operation Identifier)

```typescript
// Canonical Op ID: ALWAYS this string, never an object. Used directly as Map keys,
// Set members, and in serialization. Replica ID format: "${siteId}.${incarnation}".
type OpIdKey = `${string}:${number}`;   // e.g. "abc123.0:42"

// Helpers (kernel/src/utils.ts)
//   createOpId(replicaId, seq): OpIdKey
//   parseOpId(id): { replicaId, seq } | null     (splits on the LAST ':')
//   compareOpIds(a, b): -1 | 0 | 1                (plain code-unit string comparison)
```

**Invariants:**
- No two operations from the same replica share the same `seq`
- Op IDs are globally unique across all replicas
- Op IDs establish a total order (deterministically sortable) via string comparison
- RGA sibling order does NOT use `compareOpIds`; it uses the key `(lamport, replicaId)` (see Algorithm 1)

### Element (Sequence Item)

```typescript
interface Element<T = unknown> {
  id: OpIdKey;                   // Op ID of the insert that created it; globally unique
  anchor: OpIdKey | undefined;   // Parent in the RGA tree (undefined = HEAD); never changes
  lamport: number;               // Lamport clock of the insert
  value?: T;                     // Payload (undefined once reclaimed)
  deleted: boolean;              // True if marked as deleted (tombstone)
  deletedAt?: OpIdKey;           // SMALLEST Op ID among applied deletes of this element (deterministic across replicas)
  payloadReclaimed: boolean;     // True if payload was GC'd (retained anchor)
}
```

**Invariants:**
- If `deleted === true`, the element is a tombstone and invisible to user traversal
- If `payloadReclaimed === true`, `value` is no longer accessible (GC'd)
- If `payloadReclaimed === false` and `deleted === false`, `value` is the active payload
- `anchor` is set when the element is created and never changes; a child's `lamport` is always greater than its parent's (Lamport causality)

### Operation (Op)

```typescript
interface Operation<T = unknown> {
  id: OpIdKey;                // "${replicaId}:${seq}"; seq = parseOpId(id).seq
  type: 'insert' | 'delete';
  anchor?: OpIdKey;           // insert: element after which to insert (undefined = HEAD)
  target?: OpIdKey;           // delete: element to delete
  value?: T;                  // insert only
  lamport: number;            // Lamport clock timestamp
  replicaId: string;          // Author; equals the replica part of id
  epoch?: number;             // Diagnostic only; NEVER used for fencing
}

// There is no separate `seq` field and no opId() converter: op.id IS the Op ID.
function seqOf(op: Operation): number {
  return parseOpId(op.id)!.seq;
}
```

### VersionVector (VV)

```typescript
type VersionVector = Map<string, number>;  // replicaId -> contiguous sequence number

// VV Comparison: partial order
function isVVLessOrEqual(vv1: VersionVector, vv2: VersionVector): boolean {
  for (const [replicaId, seq] of vv1.entries()) {
    if ((vv2.get(replicaId) ?? 0) < seq) {
      return false;
    }
  }
  return true;
}

// VV Merge: component-wise maximum
function mergeVV(vv1: VersionVector, vv2: VersionVector): VersionVector {
  const merged = new Map(vv1);
  for (const [replicaId, seq] of vv2.entries()) {
    merged.set(replicaId, Math.max(merged.get(replicaId) ?? 0, seq));
  }
  return merged;
}

// VV Set entry: returns a NEW map. Low-level; it does not check contiguity.
// The applyOp pipeline must only call it through advanceContiguous (Algorithm 4).
function advanceVV(vv: VersionVector, replicaId: string, newSeq: number): VersionVector {
  const updated = new Map(vv);
  updated.set(replicaId, newSeq);
  return updated;
}
```

**Contiguous Prefix Rule**: `VV[replicaId]` must equal the highest sequence `seq` from that replica such that all operations `(replicaId, 1), ..., (replicaId, seq)` have been **applied**. Buffered operations do not count and never advance the VV. Applied no-op operations do count (Algorithm 3).

**Consequence (duplicate detection)**: because operations from a replica are applied only in contiguous order, the set of applied ops from replica `r` is exactly `{1..VV[r]}`. So "already applied" is simply `seq <= VV[r]`, an O(1) check that needs no separate applied-ops set and survives snapshot restore without materializing one.

### MembershipView

```typescript
interface MembershipView {
  activeMembers: Set<string>;            // Active replica IDs
  evictedMembers: Map<string, number>;   // Evicted replica ID -> cutoff (max seq of its ops still accepted)
  epoch: number;                         // Current membership epoch
}
```

**Invariants:**
- Epoch increments by exactly 1 on each membership change
- Epochs never decrease
- A replica is active only if its ID is in `activeMembers`
- A replica is in at most one of `activeMembers` and `evictedMembers`; an evicted ID never returns (a rejoin is a new incarnation with a new replica ID)

**Edit-operation fencing** (judged by AUTHOR, not epoch; requirements.md §10.0):

```typescript
function isFenced(m: MembershipView, replicaId: string, seq: number): boolean {
  if (m.activeMembers.has(replicaId)) return false;
  const cutoff = m.evictedMembers.get(replicaId);
  return cutoff === undefined || seq > cutoff;   // unknown author, or beyond the cutoff
}
```

### Snapshot

```typescript
interface Snapshot<T = unknown> {
  elements: readonly Element<T>[];  // All elements incl. tombstones, in traversal order; each carries its anchor
  vv: VersionVector;                // VV at snapshot time
  membership: MembershipView;       // Active members, evicted members with cutoffs, epoch
  lamportClock: number;             // Logical timestamp (no wall-clock time anywhere in a snapshot)
  replicaId: string;                // Replica that created the snapshot
  gcStats?: GCStats;                // For the Graveyard panel (requirements.md §13.7)
  stableFrontier?: VersionVector;   // Set for rejoin snapshots
}
```

### GCStats

```typescript
interface GCStats {
  tombstoneCount: number;       // Deleted elements currently in the structure
  payloadsReclaimed: number;    // Of those, how many are retained anchors (payload reclaimed)
  bytesSaved: number;           // Cumulative estimated bytes freed
  replicasEvicted: number;      // Evicted replicas
  stableFrontier: VersionVector; // Copy of the frontier when the stats were taken
}
```

### OperationBuffer (Internal)

```typescript
// Buffers operations whose dependencies are not yet applied. Nothing is ever dropped
// (except an op that becomes fenced while waiting, which is rejected explicitly).
interface OperationBuffer<T = unknown> {
  readonly ops: Map<OpIdKey, Operation<T>>;     // Buffered ops keyed by Op ID
  readonly missing: Map<string, Set<number>>;   // replicaId -> missing seqs (for sync requests)
  readonly waiting: Map<OpIdKey, Set<OpIdKey>>; // absent anchor/target element -> buffered ops waiting for it
}

// An op is READY when ALL of these hold (checked by Algorithm 3):
//   1. seq === VV[replicaId] + 1            (all earlier ops from this author are applied)
//   2. insert: anchor is undefined (HEAD) or the anchor element exists
//   3. delete: the target element exists
function isReady<T>(state: ReplicaState<T>, op: Operation<T>): boolean {
  const seq = seqOf(op);
  if (seq !== (state.vv.get(op.replicaId) ?? 0) + 1) return false;
  if (op.type === 'insert') return op.anchor === undefined || state.rga.elements.has(op.anchor);
  return state.rga.elements.has(op.target!);
}
```

### ReplicaState (Internal)

```typescript
// The mutable state the CRDT orchestrator owns. Algorithms 1-4 and 8 operate on it.
interface ReplicaState<T> {
  rga: RGAState<T>;                              // Algorithm 1
  vv: VersionVector;                             // replaced (copy-on-write) on every advance
  buffer: OperationBuffer<T>;
  opLog: Operation<T>[];                         // append-only; applied ops in causal order
  membership: MembershipView;
  lamportClock: number;
}
```

---

## Module Structure (Proposed File Organization)

```
/kernel
  /src
    index.ts                     # Main exports
    types.ts                     # Shared interfaces and types
    lamport.ts                   # Lamport clock
    rga.ts                       # RGA data structure and logic
    vv.ts                        # VersionVector operations
    oplog.ts                     # Operation log
    membership.ts                # Membership and epochs
    gc.ts                        # Garbage collection (Stage 1)
    snapshot.ts                  # Snapshot serialization/deserialization
    crdt.ts                      # Main CRDT class (orchestrator)
    utils.ts                     # Helpers, serialization, comparison
    events.ts                    # Event emission system

  /tests
    lamport.test.ts              # Lamport clock tests
    rga.test.ts                  # RGA unit and property tests
    vv.test.ts                   # VersionVector tests
    oplog.test.ts                # Operation log tests
    membership.test.ts           # Membership and fencing tests
    gc.test.ts                   # GC tests
    snapshot.test.ts             # Snapshot tests
    integration.test.ts          # Multi-replica convergence tests
    pbt.test.ts                  # Property-based tests (fast-check)

  /testing
    deterministicNetwork.ts      # Simulated network for tests
    fixtures.ts                  # Test setup and helpers
    arbitraries.ts               # fast-check generators

  README.md                       # Architecture and integration guide
```

---

## Key Algorithms

### Algorithm 1: Insert Operation (RGA as an anchor tree)

**Structure.** Every element is a child of its anchor (or of HEAD). The sequence order is the **depth-first pre-order traversal** of this tree. Children of the same parent are kept **newest first** by the key `(lamport, replicaId)`. The position of a new element is found among its parent's children only, never by scanning the flat array: a flat scan that compares keys alone cannot tell a sibling from a descendant, and can place an element inside another sibling's subtree. Example: `A` is a child of HEAD; `B` is a child of `A` with key `(2, r2)`; `C` is a child of `B` with key `(3, r3)`; a concurrent `D` is a child of `A` with key `(2, r4)`. `D` is newer than `B` (same lamport, `r4 > r2`), so the order is `[A, D, B, C]`: `B` and its child `C` stay together. The oldest-first flat scan in an earlier draft of this document produced `[A, B, D, C]`, which separates `C` from its parent `B` (it violates subtree contiguity) and also places an insert in the middle of a sequence after the anchor's existing children instead of right after the anchor.

```typescript
type ParentKey = OpIdKey | 'HEAD';

interface RGAState<T> {
  elements: Map<OpIdKey, Element<T>>;   // every element, including tombstones, by Op ID
  children: Map<ParentKey, OpIdKey[]>;  // parent -> child IDs, ALWAYS sorted newest-first
  deleteOps: Map<OpIdKey, Set<OpIdKey>>; // element -> ALL delete ops targeting it, incl. no-ops (Algorithms 2, 6)
}

// Sibling key: lamport (numeric), then replicaId (code-unit). The Op ID string is a final
// tie-break only so the order stays total even on malformed input; it never decides
// anything for well-formed ops (lamport strictly increases per replica).
// Returns > 0 when `a` is NEWER than `b`.
function compareSiblingKeys<T>(a: Element<T>, b: Element<T>): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  const ra = parseOpId(a.id)!.replicaId;
  const rb = parseOpId(b.id)!.replicaId;
  if (ra !== rb) return ra < rb ? -1 : 1;           // code-unit comparison, no localeCompare
  return compareOpIds(a.id, b.id);
}
```

**Local operation creation:**

One options object, not positional numbers: `clock`, `seq` and `epoch` are all plain numbers, and swapping them positionally compiles but silently produces wrong Op IDs and Lamport values.

```typescript
function insert<T>(p: {
  replicaId: string;
  anchor: OpIdKey | undefined;  // undefined = HEAD
  value: T;
  clock: number;                // current Lamport clock of this replica; op.lamport = clock + 1
  seq: number;                  // highest seq this replica has ALREADY issued; op seq = seq + 1
  epoch: number;                // diagnostic only
}): { operation: Operation<T>; newLamport: number } {
  const newSeq = p.seq + 1;
  const newLamport = p.clock + 1;
  const operation: Operation<T> = {
    id: createOpId(p.replicaId, newSeq),
    type: 'insert',
    anchor: p.anchor,
    value: p.value,
    lamport: newLamport,
    replicaId: p.replicaId,
    epoch: p.epoch,
  };
  return { operation, newLamport };
}
```

**Application (local or remote).** Precondition, guaranteed by `isReady` in Algorithm 3: the anchor is HEAD or already present.

```typescript
function applyInsert<T>(rga: RGAState<T>, op: Operation<T>): boolean {
  if (rga.elements.has(op.id)) return false;   // defensive: never create an element twice

  const element: Element<T> = {
    id: op.id,
    anchor: op.anchor,
    lamport: op.lamport,
    value: op.value,
    deleted: false,
    payloadReclaimed: false,
  };
  rga.elements.set(op.id, element);

  // Insert into the parent's child list, newest first: skip siblings that are NEWER.
  const parent: ParentKey = op.anchor ?? 'HEAD';
  const siblings = rga.children.get(parent) ?? [];
  let pos = 0;
  while (pos < siblings.length && compareSiblingKeys(rga.elements.get(siblings[pos])!, element) > 0) {
    pos++;
  }
  siblings.splice(pos, 0, op.id);
  rga.children.set(parent, siblings);
  return true;   // an insert always changes state
}
```

**Traversal** (`getSequence` is this, filtered to non-deleted elements). It is iterative, because typing a long string produces a chain as deep as the string and a recursive DFS would overflow the call stack:

```typescript
function traverse<T>(rga: RGAState<T>): Element<T>[] {
  const out: Element<T>[] = [];
  const stack: OpIdKey[] = [];
  const pushChildrenReversed = (parent: ParentKey) => {
    const kids = rga.children.get(parent);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);  // first child ends on top
  };
  pushChildrenReversed('HEAD');
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(rga.elements.get(id)!);   // pre-order: parent, then each child's whole subtree
    pushChildrenReversed(id);
  }
  return out;
}
```

**Complexity**: `applyInsert` is O(c) for c siblings under the anchor (binary search would make the position search O(log c)); traversal is O(n).

**Correctness**:
- *Convergence*: the final tree depends only on the set of applied inserts (each element's parent is fixed), and each child list is ordered purely by element keys, not by arrival order; the traversal depends only on the tree. Replicas that applied the same operations therefore produce identical sequences, at any nesting depth.
- *Subtree contiguity*: pre-order traversal emits an element's entire subtree before its next sibling.
- *Local insert lands where intended* (Requirement 1.8): a local insert has the highest Lamport value the replica has seen, so it becomes the FIRST child of its anchor and lands immediately after it. To insert at visible index `k`, anchor on the visible element at index `k - 1` (or HEAD for `k = 0`).

---

### Algorithm 2: Delete Operation

**Input**: one options object `{ replicaId, target (element Op ID), clock, seq, epoch }`, with the same meaning of `clock` / `seq` / `epoch` as in Algorithm 1
**Output**: `Operation` with type 'delete'

```typescript
function delete_(p: {
  replicaId: string;
  target: OpIdKey;
  clock: number;                // current Lamport clock; op.lamport = clock + 1
  seq: number;                  // highest seq already issued; op seq = seq + 1
  epoch: number;                // diagnostic only
}): { operation: Operation; newLamport: number } {
  const newSeq = p.seq + 1;
  const newLamport = p.clock + 1;
  const operation: Operation = {
    id: createOpId(p.replicaId, newSeq),
    type: 'delete',
    target: p.target,
    lamport: newLamport,
    replicaId: p.replicaId,
    epoch: p.epoch,
  };
  return { operation, newLamport };
}

// Application. Precondition, guaranteed by isReady in Algorithm 3: the target exists.
// Returns true only if the element transitioned from visible to deleted.
function applyDelete<T>(rga: RGAState<T>, op: Operation<T>): boolean {
  const target = op.target!;

  // ALWAYS record the delete op against its target, even if it turns out to be a no-op:
  // Stage 1 GC reclaims when ANY delete op of the element is stable (Requirement 12.2).
  let ops = rga.deleteOps.get(target);
  if (ops === undefined) { ops = new Set(); rga.deleteOps.set(target, ops); }
  ops.add(op.id);

  const element = rga.elements.get(target)!;
  if (element.deleted) {
    // No-op: a concurrent/earlier delete already tombstoned it. Keep `deletedAt`
    // deterministic across replicas: it is the SMALLEST delete Op ID applied so far,
    // not "whichever arrived first".
    if (element.deletedAt === undefined || compareOpIds(op.id, element.deletedAt) < 0) {
      element.deletedAt = op.id;
    }
    return false;
  }

  element.deleted = true;           // tombstone; structural position and children are retained
  element.deletedAt = op.id;
  return true;
}
```

**Complexity**: O(1) average (map lookups).

**Correctness**: tombstones stay in the tree, so concurrent inserts anchored on them still place correctly. A repeated or concurrent delete is idempotent for the visible state.

---

### Algorithm 3: Apply Remote Operation (with Dependency Buffering)

**Input**: `state` (a `ReplicaState`), `op`
**Output**: an `ApplyResult`; `state` is updated in place by the orchestrator (the VV is replaced copy-on-write)

```typescript
interface ApplyResult {
  status: 'applied' | 'buffered' | 'duplicate' | 'fenced';
  changed: boolean;       // did applying this op (or any op it unblocked) change the sequence?
  unblocked: OpIdKey[];   // buffered ops that were applied as a consequence of this call
  fenced: OpIdKey[];      // buffered ops rejected because they became fenced while waiting
}

function applyOp<T>(state: ReplicaState<T>, op: Operation<T>): ApplyResult {
  const seq = seqOf(op);

  // 1. Fencing: judge by AUTHOR + cutoff, never by epoch (requirements.md §10.0, mechanism 1)
  if (isFenced(state.membership, op.replicaId, seq)) {
    return { status: 'fenced', changed: false, unblocked: [], fenced: [] };
  }

  // 2. Duplicate suppression. Applied ops from a replica are exactly 1..VV[replica]
  //    (contiguous prefix rule), so "already applied" is `seq <= VV`. A copy already
  //    waiting in the buffer is a duplicate too.
  if (seq <= (state.vv.get(op.replicaId) ?? 0) || state.buffer.ops.has(op.id)) {
    return { status: 'duplicate', changed: false, unblocked: [], fenced: [] };
  }

  // 3. Dependencies: previous seq of this author, and anchor (insert) or target (delete).
  if (!isReady(state, op)) {
    bufferOp(state.buffer, op, (id) => state.rga.elements.has(id));   // never dropped
    return { status: 'buffered', changed: false, unblocked: [], fenced: [] };
  }

  // 4. Apply, then unblock with an ITERATIVE work queue (no recursion: a long chain of
  //    dependent ops must not grow the call stack).
  const queue: Operation<T>[] = [op];
  const unblocked: OpIdKey[] = [];
  const fenced: OpIdKey[] = [];
  let changed = false;
  for (let head = 0; head < queue.length; head++) {   // index, not shift(): O(1) dequeue
    const next = queue[head];
    if (applyReadyOp(state, next)) changed = true;
    if (next !== op) unblocked.push(next.id);
    for (const ready of takeReadyFromBuffer(state.buffer, next, bufferChecks(state), fenced)) queue.push(ready);
  }
  return { status: 'applied', changed, unblocked, fenced };
}

// Applies one op that is ready and not fenced.
function applyReadyOp<T>(state: ReplicaState<T>, op: Operation<T>): boolean {
  const changed = op.type === 'insert' ? applyInsert(state.rga, op) : applyDelete(state.rga, op);

  // ALWAYS, whether or not state changed. A no-op (e.g., a second concurrent delete of the
  // same element) is still an applied op: if it were skipped, VV[replica] would stay one
  // short and every later op from that replica (seq + 1 never equals VV + 1) would sit in
  // the buffer forever.
  state.opLog.push(op);
  state.vv = advanceContiguous(state.vv, op.replicaId, seqOf(op));
  state.lamportClock = Math.max(state.lamportClock, op.lamport);

  return changed;   // used only to decide whether to emit 'sequenceChanged'
}

// The buffer helpers are implemented in kernel/src/buffer.ts. They know nothing about the RGA
// or the version vector: the orchestrator passes predicates.
function bufferChecks<T>(state: ReplicaState<T>): BufferChecks<T> {
  return {
    isReady: (op) => isReady(state, op),
    isFenced: (op) => isFenced(state.membership, op.replicaId, seqOf(op)),
  };
}

//   bufferOp(buffer, op, hasElement)
//       Store the op by ID; if its anchor/target is not applied yet, index it in `waiting`.
//
//   takeReadyFromBuffer(buffer, applied, { isReady, isFenced }, fenced): Operation[]
//       After `applied` was applied, only two things can make a waiting op ready, and each has
//       a direct lookup (no rescan of the whole buffer):
//         1. the next seq from the same author -> buffer.ops.get(createOpId(author, seq + 1))
//         2. ops waiting for the element this op created (if it was an insert) -> buffer.waiting.get(applied.id)
//       A fenced candidate is removed and reported in `fenced` (an explicit rejection, not a
//       silent loss). A ready candidate is removed and returned. A candidate still blocked by
//       its OTHER dependency stays buffered; that dependency's own trigger reconsiders it.
//
//   purgeFencedBuffered(buffer, isFenced): OpIdKey[]
//       On a membership change: remove and report every buffered op that is now fenced.
//       (A full scan is fine; membership changes are rare.)
//
//   refreshMissing(buffer, vv, limit = 1000): void
//       Rebuilds the `missing` field: per replica, the seqs after VV[r] and before its highest
//       buffered seq that are not buffered. `missing` is a CACHE refreshed ON DEMAND (when a
//       sync request is built), NOT on every buffer change: refreshing on every change rescans
//       the buffer each time and makes draining quadratic. The list is capped per replica
//       (lowest first) so a peer claiming seq 2,000,000,000 cannot allocate billions of entries.
```

**Notes**
- `isReady` is defined with `OperationBuffer` in Data Models; `buffer.ts` receives it (and `isFenced`) as predicates. Readiness only ever becomes true over time (the VV and the element set only grow), so an op that is ready when queued is still ready when applied.
- Events (orchestrator): emit `sequenceChanged` only when `changed`; emit the diagnostic `bufferUnblocked` when `unblocked` is non-empty.
- When membership changes (`updateMembership`), call `purgeFencedBuffered` so buffered ops from newly evicted authors beyond their cutoff are rejected. (Membership changes never make an op ready that was not, so nothing needs draining.)
- The op is appended to the OpLog when it is applied (not when it is merely buffered), so log order is always a valid causal replay order (Requirement 3.3).

**Complexity**: O(1) to decide to buffer. Draining examines only the directly unblocked candidates (next seq of the author, ops waiting on the new element), so applying k ops costs O(k) plus the cost of the ops themselves. Why this matters: rescanning the whole buffer after every applied op is O(k · b); a prototype of this design on a 10,000-op dependency chain delivered in reverse order took about 19.6 s with the rescan and about 53 ms with the index.

**Correctness**: operations with missing dependencies are never dropped; they stay in the buffer until every dependency is applied, or until they are explicitly rejected by fencing. Each loop iteration removes one op from the buffer and applies it, so the loop terminates.

---

### Algorithm 4: Contiguous Version Vector Update

**Input**: `vv`, `replicaId`, `seq` (the seq of an op that has just been applied)
**Output**: Updated VV (a new Map), or the same VV if it must not move

```typescript
function advanceContiguous(vv: VersionVector, replicaId: string, seq: number): VersionVector {
  const current = vv.get(replicaId) ?? 0;
  if (seq !== current + 1) {
    // seq > current + 1: a gap, wait for the missing ops.
    // seq <= current:    already counted; never move the VV backwards.
    return vv;
  }
  return advanceVV(vv, replicaId, seq);
}
```

**Invariants**:
- `VV[replicaId]` is always the highest contiguous seq of **applied** operations from that replica. Buffered operations do not count.
- It never decreases and never skips a value.
- It advances for every applied op, including no-ops (Algorithm 3).

**Where the check lives**: `isReady` (seq must equal `VV + 1`) and `advanceContiguous` are used by the orchestrator; `updateVersionVector` in `utils.ts` is max-based and does NOT enforce contiguity, so it must not be used to advance the VV when applying operations (KER-013).

---

### Algorithm 5: Stable Frontier Computation

**Input**: Acknowledged VVs from all active replicas
**Output**: Stable Frontier (component-wise minimum over active members)

```typescript
function computeStableFrontier(
  acknowledgedVVs: Map<string, VersionVector>,
  activeReplicas: Set<string>
): VersionVector {
  const frontier = new Map<string, number>();

  // Collect all replica IDs that appear in any acknowledgment
  const allReplicaIds = new Set<string>();
  for (const vv of acknowledgedVVs.values()) {
    for (const rid of vv.keys()) {
      allReplicaIds.add(rid);
    }
  }

  // Compute frontier[r] = min over active members m of ack_m[r]
  for (const replicaId of allReplicaIds) {
    let minSeq = Infinity;
    for (const activeMember of activeReplicas) {
      const vv = acknowledgedVVs.get(activeMember);
      const seq = vv ? (vv.get(replicaId) ?? 0) : 0;
      minSeq = Math.min(minSeq, seq);
    }
    if (minSeq !== Infinity) {
      frontier.set(replicaId, minSeq);
    }
  }

  return frontier;
}

function isCausallyStable(opId: OpIdKey, stableFrontier: VersionVector): boolean {
  const parsed = parseOpId(opId);               // splits on the last ':'
  if (parsed === null) return false;
  return (stableFrontier.get(parsed.replicaId) ?? 0) >= parsed.seq;
}
```

**Trust assumption**: the frontier is only as safe as the acks it is computed from. It assumes replicas report their VVs honestly; a Byzantine replica could claim ops it has not applied. That is out of scope for this educational kernel (requirements.md §11).

**Correctness**: Frontier = component-wise minimum over ALL active members for EVERY replicaId in any ack.
**Monotonicity**: Frontier only advances or stays the same (never regresses).
**Safety**: An operation is causally stable only if all active replicas have applied it.

---

### Algorithm 6: Stage 1 Garbage Collection (Payload Reclamation)

**Input**: `state`, stable frontier, current GC stats
**Output**: payloads reclaimed in place; new `GCStats`. Structural nodes (the tree) are never touched, so retained anchors keep working.

```typescript
function performStage1GC<T>(
  state: ReplicaState<T>,
  stableFrontier: VersionVector,
  stats: GCStats
): { stats: GCStats; bytesReclaimed: number } {
  let bytesReclaimed = 0;
  let tombstoneCount = 0;
  let payloadsReclaimed = 0;

  for (const element of state.rga.elements.values()) {
    if (!element.deleted) continue;
    tombstoneCount++;

    if (!element.payloadReclaimed) {
      // Reclaimable if ANY delete op targeting the element is causally stable
      // (rga.deleteOps includes delete ops that were no-ops; Algorithm 2).
      const deleteOps = state.rga.deleteOps.get(element.id);
      let reclaimable = false;
      if (deleteOps !== undefined) {
        for (const deleteOpId of deleteOps) {
          if (isCausallyStable(deleteOpId, stableFrontier)) { reclaimable = true; break; }
        }
      }
      if (reclaimable) {
        bytesReclaimed += estimatePayloadSize(element.value);   // counted once per element
        element.value = undefined;
        element.payloadReclaimed = true;
      }
    }
    if (element.payloadReclaimed) payloadsReclaimed++;
  }

  return {
    bytesReclaimed,
    stats: {
      ...stats,
      tombstoneCount,
      payloadsReclaimed,
      bytesSaved: stats.bytesSaved + bytesReclaimed,
      stableFrontier: new Map(stableFrontier),
    },
  };
}
```

**Complexity**: O(n · d) where n is the number of elements and d the average number of delete ops per deleted element.

**Correctness**:
- Reclaimed payloads are never read again; the element stays in the tree with its `id`, `anchor`, `lamport` and `deleted` flag, so it still orders its children and serves as an anchor for concurrent inserts.
- A payload is reclaimable if ANY delete op for the element is at or below the frontier: that op has been applied by every active replica, so the element is deleted everywhere and no replica will read its payload.
- Bytes are added once per element, when it is reclaimed.
- The visible sequence is identical with GC on or off.

**Decision D-A: GC also redacts the operation log** (found in review: reclaiming only the RGA payload frees nothing while the log still holds the insert operation with its full value, and `opsSince` would hand a "reclaimed" payload to any late tab).

- When `performStage1GC` reclaims an element, `CRDT` calls `redactReclaimedPayloads(log, reclaimedIds)` (`oplog.ts`): each matching insert entry is REPLACED by a copy without `value` (id, type, anchor, lamport and author stay, so the log keeps its length, order and replay). The original operation object is never edited.
- Why it is safe: a delete only becomes stable when every active member has applied it, and a delete comes after its insert, so every active member already has the insert. A replica that joins later receives the insert without a value, then the delete, and ends with the same visible sequence. `assertValidOperation` does not require `value`, so a redacted operation is valid on the wire.
- The RGA and the log normally share ONE payload object (`applyInsert` stores `op.value` by reference), so memory is only freed when BOTH references are dropped. That is why GC clears both. `GCStats.bytesSaved` counts each reclaimed payload once, using `estimatePayloadSize`. It is not the sum of "bytes cleared from the sequence" and "bytes cleared from the log", because that would count one payload twice. Benchmarks that report the bytes held in the sequence and in the log separately must say so.
- A replica restored from a snapshot starts a FRESH log (Algorithm 7), so it can only answer a hello with operations after the snapshot point. This is a README limitation.
- GC also forgets `rga.deleteOps` for a reclaimed element (it is never read again; Algorithm 8 seeds it only for elements that still hold a payload), including an entry that a late delete re-created.
- The frontier is applied only with the replica's current epoch (requirement 11.8): `CRDT.updateStableFrontier(frontier, epoch)`.

---

### Algorithm 7: Snapshot Creation

**Input**: `state`, `replicaId`, GC stats
**Output**: serializable snapshot (deep copies; no shared mutable references; no wall-clock time)

```typescript
function createSnapshot<T>(
  state: ReplicaState<T>,
  replicaId: string,
  gcStats: GCStats
): Snapshot<T> {
  return {
    elements: traverse(state.rga).map((e) => ({ ...e })),   // depth-first order, tombstones included
    vv: new Map(state.vv),
    membership: {
      activeMembers: new Set(state.membership.activeMembers),
      evictedMembers: new Map(state.membership.evictedMembers),   // cutoffs travel with the snapshot
      epoch: state.membership.epoch,
    },
    lamportClock: state.lamportClock,                       // logical timestamp
    replicaId,
    gcStats: { ...gcStats, stableFrontier: new Map(gcStats.stableFrontier) },
  };
}
```

**Not included, by design**: the OpLog (a restored replica starts a fresh log from the snapshot point) and the dependency buffer. Buffered ops are not covered by the snapshot's VV, so peers re-send them through the normal missing-op exchange (Requirement 6.6); nothing is lost.

**Determinism**: deep copies prevent aliasing; `lamportClock` replaces any wall-clock timestamp.

---

### Algorithm 8: Snapshot Rejoin

**Input**: `snapshot`, `newReplicaId` (a NEW incarnation when an evicted replica returns), `postSnapshotOps`
**Output**: a CRDT whose state equals that of a continuously connected replica once all ops are delivered

Rejoin has two parts: restore the snapshot state, then feed **every** post-snapshot op through the normal `applyOp` pipeline (Algorithm 3). There is no simplified apply path for rejoin.

```typescript
// Restore state only (no ops applied yet). Used by CRDT.fromSnapshot / rejoinFromSnapshot.
function restoreFromSnapshot<T>(snapshot: Snapshot<T>): ReplicaState<T> {
  const rga: RGAState<T> = { elements: new Map(), children: new Map(), deleteOps: new Map() };
  for (const e of snapshot.elements) {          // snapshot is in depth-first order, so each parent's
    const element = { ...e };                    // children appear newest-first: appending preserves the invariant
    rga.elements.set(element.id, element);
    const parent: ParentKey = element.anchor ?? 'HEAD';
    const list = rga.children.get(parent);
    if (list) list.push(element.id); else rga.children.set(parent, [element.id]);
  }

  // Seed delete-op tracking from deletedAt. Conservative: GC may reclaim later than on the
  // snapshotting replica, never earlier.
  for (const element of rga.elements.values()) {
    if (element.deleted && !element.payloadReclaimed && element.deletedAt !== undefined) {
      rga.deleteOps.set(element.id, new Set([element.deletedAt]));
    }
  }

  return {
    rga,
    vv: new Map(snapshot.vv),                   // everything at or below it counts as applied
    buffer: { ops: new Map(), missing: new Map(), waiting: new Map() },
    opLog: [],
    membership: {
      activeMembers: new Set(snapshot.membership.activeMembers),
      evictedMembers: new Map(snapshot.membership.evictedMembers),
      epoch: snapshot.membership.epoch,
    },
    lamportClock: snapshot.lamportClock,
  };
}

function rejoinFromSnapshot<T>(
  snapshot: Snapshot<T>,
  newReplicaId: string,
  postSnapshotOps: Operation<T>[]
): CRDT<T> {
  // restoreFromSnapshot + own seq counter. A NEW incarnation starts its own seq at 0;
  // a plain restart of the same replica (replicaId defaulting to snapshot.replicaId)
  // continues from VV[replicaId].
  const crdt = CRDT.fromSnapshot(snapshot, newReplicaId);
  for (const op of postSnapshotOps) {
    crdt.applyOp(op);   // full pipeline: author fencing (snapshot membership + cutoffs), duplicate
  }                      // suppression (seq <= VV), dependency buffering, contiguous VV advance, logging
  return crdt;
}
```

**What the shared pipeline guarantees** (and a loop that applied ops directly would not):
- Ops from an evicted author beyond its cutoff are fenced.
- An out-of-order post-snapshot op is buffered, not skipped; it applies when its predecessors arrive.
- Non-contiguous duplicates are detected (`seq <= VV[r]` is exact because applied ops are always a contiguous prefix).
- A no-op op still advances the VV, so it cannot stall later ops.

**Correctness**: snapshot state + post-snapshot ops delivered in any order and any number of times produce the same state as continuous application (Property 15).

---

## Public API Surface

### Main CRDT Class

```typescript
class CRDT<T = any> {
  constructor(
    replicaId: string,
    initialMembership?: MembershipView,
    initialSnapshot?: Snapshot<T>
  );

  // ==================== Core Operations ====================

  /**
   * Insert a new element after the specified anchor (or at HEAD if undefined).
   * The replica ID is already known from the CRDT constructor.
   * @param anchorId Op ID of element to insert after (undefined = HEAD)
   * @param value Data to insert
   * @returns Operation that was applied locally and should be broadcast
   */
  insert(anchorId: OpIdKey | undefined, value: T): Operation<T>;

  /**
   * Delete an element (mark as tombstone).
   * The replica ID is already known from the CRDT constructor.
   * @param elementId Op ID of element to delete
   * @returns Operation that was applied locally and should be broadcast
   */
  delete(elementId: OpIdKey): Operation<T>;

  /**
   * Apply a remote operation to this replica's state (Algorithm 3).
   * Fenced by author membership + cutoff only; the op's `epoch` field is never consulted.
   * Duplicates are ignored; ops with missing dependencies are buffered, never dropped;
   * no-op operations are still logged and advance the VV.
   * @param op Operation from another replica
   */
  applyOp(op: Operation<T>): void;

  // ==================== Query Methods ====================

  /**
   * Get the current sequence (non-deleted elements only).
   * This is the depth-first traversal of the RGA anchor tree (Algorithm 1) with deleted
   * elements filtered out: siblings (inserts at the same anchor) appear newest first by
   * (lamport, replicaId), and every element's descendants follow it contiguously.
   * All replicas that applied the same operations, in any order, return identical sequences.
   * @returns Array of non-deleted elements in sequence order
   */
  getSequence(): Element<T>[];

  /**
   * Get the current Version Vector.
   * @returns VV mapping replica ID to contiguous sequence number
   */
  getVV(): VersionVector;

  /**
   * Get the current membership view.
   * @returns MembershipView: activeMembers, evictedMembers (replicaId -> cutoff), epoch
   */
  getMembershipView(): MembershipView;

  /**
   * Check if a given element is marked as deleted.
   * @param elementId Op ID of element
   * @returns true if deleted (tombstone), false if active
   */
  isElementDeleted(elementId: OpIdKey): boolean;

  /**
   * Check if an operation is causally stable (safe for GC).
   * @param opId Op ID to check
   * @returns true if at or below stable frontier, false otherwise
   */
  isCausallyStable(opId: OpIdKey): boolean;

  /**
   * Get the current stable frontier (for coordinator use).
   * @returns VersionVector representing the stable frontier
   */
  getStableFrontier(): VersionVector;

  /**
   * Get garbage collection statistics.
   * @returns GCStats: tombstoneCount, payloadsReclaimed, bytesSaved, replicasEvicted, stableFrontier
   */
  getGCStats(): GCStats;

  // ==================== Snapshots ====================

  /**
   * Create a snapshot of the current state (Algorithm 7).
   * @returns Snapshot: elements (with anchors), VV, membership with cutoffs, lamportClock, gcStats
   */
  snapshot(): Snapshot<T>;

  /**
   * Restore state from a snapshot (Algorithm 8, restore step). Instances are normally
   * created with `CRDT.fromSnapshot(snapshot, replicaId?)`; a returning evicted replica
   * MUST use a NEW replicaId. This restores state only: post-snapshot operations must then
   * be delivered through `applyOp`, which applies full fencing, dedup, buffering and VV rules.
   * @param snapshot Snapshot to restore from
   */
  rejoinFromSnapshot(snapshot: Snapshot<T>): void;

  // ==================== Membership ====================

  /**
   * Install a new membership view published by the coordinator.
   * The coordinator assigns the epoch (previous epoch + 1) and supplies the cutoffs of
   * evicted replicas; the kernel needs the cutoffs to keep accepting an evicted author's
   * ops up to its cutoff. A view whose epoch is not greater than the current epoch is ignored.
   * Afterwards, buffered ops that are now fenced are rejected (Algorithm 3 notes).
   * @param newView New membership view (activeMembers, evictedMembers with cutoffs, epoch)
   */
  updateMembership(newView: MembershipView): void;

  /**
   * Update the stable frontier (called by coordinator).
   * Triggers GC for newly stable deletes.
   * @param frontier New stable frontier VV
   */
  updateStableFrontier(frontier: VersionVector): void;

  // ==================== Events ====================

  /**
   * Register a callback for sequence changes.
   * @param callback Fired when sequence changes due to local or remote ops
   */
  on(
    event: 'sequenceChanged',
    callback: (detail: { added: Element<T>[]; removed: Element<T>[]; updated: Element<T>[] }) => void
  ): void;

  /**
   * Register a callback for membership changes.
   * @param callback Fired when membership or epoch changes
   */
  on(
    event: 'membershipChanged',
    callback: (detail: { oldEpoch: number; newEpoch: number; changeType: 'join' | 'evict' }) => void
  ): void;

  /**
   * Register a callback for garbage collection events.
   * @param callback Fired when payload is reclaimed
   */
  on(
    event: 'gcEvent',
    callback: (detail: { reclaimedBytes: number; reclaimedOps: number; reclaimer: 'self' | 'frontier' }) => void
  ): void;

  /**
   * Unregister event callbacks.
   * @param event Event name
   * @param callback Callback to remove
   */
  off(event: string, callback: Function): void;
}
```

### Event Payloads

```typescript
interface SequenceChangedPayload<T> {
  added: Element<T>[];      // Newly inserted elements
  removed: Element<T>[];    // Newly deleted elements
  updated: Element<T>[];    // Updated elements (e.g., payload reclaimed)
}

interface MembershipChangedPayload {
  oldEpoch: number;
  newEpoch: number;
  changeType: 'join' | 'evict';
  affectedReplicaId?: string;
}

interface GCEventPayload {
  reclaimedBytes: number;
  reclaimedOps: number;
  reclaimer: 'self' | 'frontier';  // 'self' = local GC, 'frontier' = update via coordinator
}
```

### Serialization

```typescript
// Operations: implemented in kernel/src/utils.ts.
//   serializeOp(op): string        deterministic JSON: keys sorted by code unit at every
//                                  nesting level, undefined fields omitted
//   deserializeOp(json): Operation validates the structure (trust boundary) and throws on
//                                  malformed input
//
// Snapshots contain Map and Set values, which JSON.stringify turns into `{}` (silent data
// loss). serializeSnapshot MUST convert them to plain JSON first, in a fixed order:
function serializeSnapshot<T>(s: Snapshot<T>): string {
  return stableStringify({
    elements: s.elements,                                   // array order is part of the data
    vv: Object.fromEntries(s.vv),                           // keys sorted by stableStringify
    membership: {
      activeMembers: [...s.membership.activeMembers].sort(compareStrings),
      evictedMembers: Object.fromEntries(s.membership.evictedMembers),
      epoch: s.membership.epoch,
    },
    lamportClock: s.lamportClock,
    replicaId: s.replicaId,
    gcStats: s.gcStats && { ...s.gcStats, stableFrontier: Object.fromEntries(s.gcStats.stableFrontier) },
    stableFrontier: s.stableFrontier && Object.fromEntries(s.stableFrontier),
  });
}
// deserializeSnapshot is the exact inverse (validates input, rebuilds Map/Set) and
// serialize(deserialize(json)) === json.
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: RGA Convergence

For any set of operations delivered to multiple replicas in any order (respecting nothing but eventual delivery), the resulting sequences are byte-identical. This holds at any nesting depth, including concurrent inserts anchored on elements that themselves have concurrent children, and inserts into the middle of an existing sequence. For every element, its descendants appear contiguously after it (subtree contiguity).

**Validates: Requirements 1.8, 14.2**

### Property 2: Op ID Uniqueness and Ordering

For any collection of operations from multiple replicas, no two operations share the same Op ID, and Op ID comparison is deterministic and transitive.

**Validates: Requirements 2.2, 2.3, 2.4, 2.5, 14.3**

### Property 3: Op ID Contiguity

For any replica, the sequence of Op IDs generated follows a monotonic increasing pattern with no gaps, and the sequence number never resets.

**Validates: Requirements 2.6, 3.6**

### Property 4: Operation Log Deterministic Replay

For any operation log and any starting state, replaying all operations in log order produces a deterministic, unique final state regardless of external timing or ordering.

**Validates: Requirements 3.5, 14.4**

### Property 5: Version Vector Partial Order Consistency

For any three Version Vectors A, B, C, if A ≤ B and B ≤ C, then A ≤ C (transitivity). Merge operations compute the component-wise maximum consistently.

**Validates: Requirements 4.7, 4.8, 4.9, 14.5**

### Property 6: Contiguous Prefix Rule

For any replica and any received operation, the Version Vector entry for that replica advances only when all operations from sequence 1 through that operation's sequence have been **applied**. Buffered operations never advance it, applied no-op operations do, and an entry never decreases.

**Validates: Requirements 5.3, 5.4, 5.10, 6.8**

### Property 7: Missing Operation Detection and Recovery

For any set of operations arriving out of order, all replicas eventually apply them in causal order, with no permanent gaps or deadlock, as long as all operations are eventually delivered.

**Validates: Requirements 5.1, 5.2, 5.3, 5.6, 14.6**

### Property 8: Duplicate Suppression Idempotence

For any operation applied k times (k ≥ 1), the final state is identical to applying it exactly once.

**Validates: Requirements 6.1, 6.3, 6.5, 14.7**

### Property 9: Deterministic Network Reproducibility

For any test scenario with a seeded pseudo-random number generator, running the test twice produces identical message sequences, replica states, and final convergence results.

**Validates: Requirements 7.3, 7.4, 7.7, 14.14**

### Property 10: Membership Epoch Monotonicity

For any sequence of membership changes, the epoch number never decreases, increments by exactly 1 on each change, and all active replicas agree on the current epoch after receiving updates.

**Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**

### Property 11: Evicted-Author Fencing

For any edit operation whose author is not active and whose seq exceeds that author's cutoff (or whose author is unknown), the operation is rejected and does not mutate state, VV, or membership. For an evicted author, ops with seq at or below the cutoff are still accepted. The operation's `epoch` field has no effect on the outcome. (Control messages from non-active or stale-epoch senders are rejected by the separate epoch-based mechanism, requirements.md §10.0.)

**Validates: Requirements 10.1, 10.2, 10.4, 10.5, 10.6, 14.8**

### Property 12: Stable Frontier Monotonicity

For any sequence of VV acknowledgments and membership updates, the stable frontier (component-wise minimum of active replicas' VVs) advances monotonically and never regresses.

**Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.6, 11.7, 14.9**

### Property 13: Causally Stable Operation Identification

For any operation Op and stable frontier VV, if Op's Op ID is at or below VV, then all causal predecessors of Op have been applied at all active replicas.

**Validates: Requirements 11.7, 12.1**

### Property 14: Stage 1 GC Correctness

For any deleted element whose delete operation is marked as causally stable, reclaiming its payload does not change the visible sequence to the application, and the retained anchor continues to serve as a valid insertion point for new operations.

**Validates: Requirements 12.2, 12.4, 12.5, 12.6, 12.8, 14.10**

### Property 15: Snapshot Fidelity

For any snapshot taken at time T and any set of post-snapshot operations, a replica initialized from the snapshot and then applying all post-snapshot operations converges to the same state as a continuously-connected replica that received all operations.

**Validates: Requirements 13.1, 13.3, 13.4, 13.6, 14.11**

### Property 16: Deterministic Operation Serialization

For any operation or snapshot, JSON serialization is deterministic (same key order, no floating-point precision issues), and deserialization recovers the original object exactly.

**Validates: Requirements 16.3**

### Property 17: Event Callback Consistency

For any sequence of operations, all registered event callbacks are fired in a consistent order, with complete and accurate change information, and no events are lost or duplicated.

**Validates: Requirements 16.2**

### Property 18: API Method Consistency

For any sequence of API calls in the same order across two replicas, the resulting states from `getSequence()`, `getVV()`, `getMembershipView()`, and `getGCStats()` are consistent and reflect the same causal history.

**Validates: Requirements 16.1, 16.4**

---

## Error Handling

### No Exception Throwing

The kernel is designed to never throw exceptions during normal operation. Instead:

1. **Duplicate Operations**: Silently suppressed (idempotent)
2. **Fenced Operations**: An edit op from an author that is not active and is beyond its cutoff (or unknown) is silently rejected; a diagnostic event is emitted. Control messages from non-active or stale-epoch senders get a `rejected` response.
3. **Out-of-Order Operations**: Buffered, never dropped
4. **Unknown Anchors**: An insert whose anchor has not been applied yet is buffered until the anchor arrives (never re-anchored to HEAD, which would break convergence)
5. **Unknown Delete Targets**: A delete whose target has not been applied yet is buffered until the target arrives
6. **No-op Operations**: A ready operation that changes no state (e.g., delete of an already-deleted element) is still logged, counted as applied, and advances the VV
7. **Malformed Input**: `deserializeOp` / `deserializeSnapshot` validate their input and throw; the apply path itself never throws on well-formed operations

### Graceful Degradation

- **Network Partition**: Replicas continue to operate locally; stable frontier stalls (expected behavior)
- **Evicted Replica**: Recognizes itself as evicted, stops applying its own ops, can rejoin with new incarnation
- **Stale Coordinator**: Replicas continue; frontier does not advance (safe stall)

### Diagnostic Events

- `'fencedOp'`: Emitted when an edit operation is rejected by author + cutoff fencing
- `'missingOpDetected'`: Emitted when gaps are detected in op sequence
- `'bufferUnblocked'`: Emitted when buffered operations are unblocked

---

## Testing Strategy

### Unit Tests (Vitest)

Cover every exported function and class method:

- **RGA Operations**: insert, delete, anchor resolution, concurrent ordering
- **Version Vector**: contiguity checks, partial order, merge, increment
- **Operation Log**: append, dedup, query by replica
- **Membership**: epoch tracking, eviction, fencing
- **GC**: payload reclamation, retained anchors, stable frontier filtering
- **Snapshots**: create, serialize, deserialize, rejoin
- **API**: all public methods and events

**Target Coverage**: > 85% overall, > 80% branch coverage

### Property-Based Tests (fast-check)

Generate randomized scenarios using custom arbitraries:

- **Operation Sequences**: Arbitrary operations with varying anchors, values, deletes. Must include deep anchor chains (depth ≥ 3) with concurrent siblings at several levels, inserts into the middle of existing sequences, and concurrent deletes of the same element (no-ops)
- **Multi-Replica Scenarios**: Multiple replicas generating concurrent operations
- **Network Scenarios**: Message reordering, duplication, loss (seeded and deterministic)
- **Membership Changes**: Dynamic epochs, evictions, rejoin scenarios
- **GC Scenarios**: Stable frontier advancement, payload reclamation timing

**Shrinking**: fast-check provides automatic shrinking to minimal failing examples

**Iterations**: Minimum 100 iterations per property test

### Integration Tests

- Two or more replicas with simulated network
- Verify convergence under various message orderings
- Snapshot + rejoin scenarios
- Membership changes with concurrent operations

### Deterministic Network Simulator

```typescript
class DeterministicNetworkSimulator {
  constructor(seed: number);
  
  // Send message from one replica to another (may drop, delay, or reorder)
  send(fromReplica: string, toReplica: string, message: Operation): void;
  
  // Deliver next message from queue (in deterministic order based on seed)
  deliverNext(): { from: string; to: string; message: Operation } | null;
  
  // Deliver all pending messages
  deliverAll(): void;
  
  // Get all sent messages (for replay or inspection)
  getSentMessages(): Message[];
  
  // Reset for next test
  reset(): void;
}
```

---

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `insert()` | O(c) | c = number of siblings under the anchor (element lookup is O(1)) |
| `delete()` | O(1) | Map lookup + flag mutation |
| `applyOp()` | O(1) avg | O(k) when unblocking k buffered ops (indexed lookup, no buffer rescan) |
| `getSequence()` | O(n) | Scan and filter non-deleted elements |
| `getVV()` | O(m) | m = number of replicas (map iteration) |
| VV Comparison | O(m) | Component-wise comparison |
| VV Merge | O(m) | Component-wise max |
| Stable Frontier | O(m) | Min of active replicas' VVs |
| Stage 1 GC | O(n) | Scan all elements; reclaim stable deletes |
| Snapshot Create | O(n + m) | Copy sequence + VV + membership |
| Snapshot Rejoin | O(n + k) | n = sequence, k = post-snapshot ops |

**Memory Usage**: Linear in document size; sub-linear growth post-GC (via Stage 1 payload reclamation)

---

## Integration Points

### Transport Layer (Outside Kernel)

The kernel does not handle network I/O. Instead, applications provide:

1. **Message Delivery**: Transport calls `applyOp()` with received operations
2. **Local Op Broadcasting**: App receives `insert()` / `delete()` return value and broadcasts to peers
3. **Membership Updates**: Coordinator broadcasts membership changes; app calls `updateMembership()`
4. **Stable Frontier Updates**: Coordinator calls `updateStableFrontier()` on each replica

### Coordinator (Node.js Service)

Manages:
- Collecting VV acks from replicas
- Computing stable frontier (component-wise minimum)
- Maintaining a list of stalled peers (those that have not acknowledged for a configurable period) and displaying them in the Graveyard panel
- Broadcasting membership updates and frontiers

**Eviction Policy**: The coordinator maintains a list of stalled peers (those that have not acknowledged for a configurable period) and displays them in the Graveyard panel. Eviction occurs only when the operator explicitly triggers an 'Exorcise' action through the UI. The coordinator never automatically evicts replicas.

**Eviction Protocol (two phases, requirements.md §10.3)**:

```
Operator: Exorcise(target)
1. Coordinator -> all active members: evict-prepare(target)
2. Each member: stop applying NEW ops from target; reply with contiguous applied seq for target
   (kernel: `crdt.holdAuthor(target)` does both: it buffers the target's operations from now on, never dropping
   them, and returns the contiguous applied seq to reply with. The hold ends by itself when the view that evicts
   the target is installed with `updateMembership`: operations beyond the cutoff are purged, those within it are
   applied. If the operator aborts the eviction instead, call `crdt.releaseAuthor(target)`.)
3. Coordinator: cutoff[target] = max(replies)     (waits for every active member)
4. Coordinator -> all: membership(epoch+1, target removed, evictedMembers[target] = cutoff)
   Eviction is now PENDING. Fencing by cutoff is in force.
5. Each survivor: backfill target's ops up to cutoff from peers via applyOp,
   then reply evict-confirm(target, vv) with vv[target] >= cutoff
6. Coordinator: COMPLETE only when every survivor has confirmed.
   Until then: Graveyard shows "exorcism pending"; coordinator re-sends backfill requests;
   non-confirming members are shown as stalled for a MANUAL Exorcise (never automatic).
```

Why the hold in step 2: the cutoff is the max of the replies. A survivor that applied one more of a LIVE target's operations after replying would keep an operation that every other survivor fences, and the survivors would diverge permanently (the target is gone, so nobody can repair it). The hold freezes each survivor at exactly the seq it replied with. A stalled target (the demo) sends nothing, so the hold only matters for a target that is still writing.

Why the barrier: without step 5/6 a survivor that missed some of target's ops below the cutoff would keep a permanent gap, because the target is gone and its ops can no longer be fetched from it. While the eviction is pending the stable frontier stays safe: `Frontier[target] = min over survivors of ack[target]`, so an un-backfilled survivor holds it back and nothing of target's is reclaimed too early. The coordinator's retries and timers live in the coordinator, not in the kernel.

### Applications (Graveyard Whiteboard, Cursed Checklist)

- Call `insert()` / `delete()` to create ops
- Listen to `'sequenceChanged'` event to update UI
- Call `snapshot()` to save state for new replicas
- Handle eviction (detect from `'membershipChanged'` event with `changeType === 'evict'`)

---

## Design Rationale

### Why RGA and Not Other CRDTs?

RGA (Replicated Growable Array) provides:
- Deterministic convergence without central coordination
- Efficient anchor-based insertion (no need for fractional indices)
- Clear semantics (an insert lands immediately after its anchor; concurrent inserts at one anchor are ordered newest first)
- Well-understood algorithm with published proofs

### Why Contiguous VVs?

Contiguous Version Vectors (only tracking the contiguous prefix) provide:
- Compact representation (O(m) vs O(m²) for full vector clocks)
- Clear dependency detection (gap = missing ops)
- Safe GC authorization (frontier computation is simple)

### Why Per-Replica Op Logs?

Operation logs enable:
- Deterministic replay for debugging
- Snapshot + rejoin (restore from snapshot, apply post-snapshot ops)
- Query history without replaying entire state
- Support for future replay-based features (e.g., undo/redo at app layer)

### Why Stage 1 GC (Not Stage 2)?

Stage 1 (payload reclamation) is safe and sufficient for MVP:
- Reclaims most memory (payloads are typically large)
- Retains structural anchors (preserves insertion semantics)
- Simple proof of correctness (no structural changes)

Stage 2 (removing structural anchors entirely) is deferred because it requires:
- Proof that removed anchors cannot be referenced by concurrent inserts
- More complex GC logic
- Higher risk of introducing causal order violations

### Why Single Coordinator?

A single trusted coordinator simplifies:
- Membership management (no split-brain)
- Epoch assignment (guaranteed monotonicity)
- Frontier computation (single point of authority)

For future work, Raft or similar could replicate the coordinator, but MVP opts for simplicity.

---

## Known Limitations and Future Work

### In MVP

1. **No Stage 2 GC**: Tombstones are retained forever; only payload is reclaimed
2. **No Horizontal Sharding**: Entire document at every replica
3. **No Conflict-Free Merge of Documents**: Kernel works on single document only
4. **No Rich Text Support**: Values are opaque; formatting is app-level

### Stretch Goals (If Time Permits)

1. **BroadcastChannel Transport**: Multi-tab demo
2. **IndexedDB Persistence**: Save/restore kernel state
3. **Exportable Orphaned Edits**: Evicted replicas can recover pending ops

### Future Considerations

1. **Stage 2 GC**: Remove tombstones after proving safety
2. **LWW Map**: Last-write-wins metadata (signatures, collaborators)
3. **Compressed Snapshots**: Delta snapshots or incremental checkpoints
4. **Replica Merging**: Combine two independent CRDT instances

---

## References and Inspiration

- **Yjs**: High-performance CRDT library (https://docs.yjs.dev)
- **Automerge**: JSON-like CRDT with rich types (https://automerge.org)
- **Loro**: Rust CRDT library with rich types
- **Academic Papers**:
  - "Replicated Growable Array (RGA)" — Roh et al. (2011)
  - "Conflict-free Replicated Data Types" — Shapiro et al. (2011)
  - "Version Vectors" — Parker et al. (1983)

---

## Document Status

**Phase**: Design (Requirements-First Workflow)

**Next Steps**:
1. Present design for review and feedback
2. Refine based on architectural feedback
3. Proceed to task creation and implementation
4. Run property-based tests during development


