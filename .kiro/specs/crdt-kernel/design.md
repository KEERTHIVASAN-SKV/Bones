# CRDT Kernel - Technical Design Document

## Overview

The CRDT Kernel is a deterministic, pure TypeScript implementation of a Replicated Growable Array (RGA) sequence CRDT designed for offline-first collaborative applications. It manages causal consistency, duplicate suppression, membership-based eviction, and memory-efficient garbage collection through a clean API surface.

**Key Design Principles:**
- **Pure & Deterministic**: No `logicalIndex`, `Math.random()`, DOM, network, or storage inside `/kernel`
- **Correctness-First**: Extensive property-based testing with fast-check; comprehensive unit tests
- **Memory-Efficient**: Stage 1 GC reclaims payload of causally stable deletes while retaining structural anchors
- **API Simplicity**: Clean public interface hiding implementation complexity
- **Educational Value**: Well-documented, from-scratch implementation suitable for learning

---

## Components and Interfaces

The CRDT Kernel is composed of seven core modules that work together to provide deterministic, memory-efficient collaborative editing:

### Module Overview

1. **RGA Module**: Maintains the replicated growable array data structure, handling insert/delete operations and deterministic conflict resolution through Op ID ordering
2. **VersionVector (VV) Module**: Tracks causal dependencies using contiguous Version Vectors; enables dependency detection and stable frontier computation
3. **OpLog Module**: Maintains an append-only log of operations; supports deduplication and per-replica querying
4. **Membership Module**: Manages active replica sets and membership epochs; enables membership-based eviction and fencing of stale operations
5. **Garbage Collector (GC) Module**: Performs Stage 1 payload reclamation for deleted elements that are causally stable; preserves structural anchors
6. **Snapshot Module**: Serializes and deserializes kernel state; enables rejoin-from-snapshot workflows
7. **CRDT Coordinator Class**: Orchestrates all modules; provides public API; emits events for application integration

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

### OpId (Unique Operation Identifier)

```typescript
interface OpId {
  replicaId: string;  // Format: "${siteId}.${incarnation}" (e.g., "abc123.0")
  seq: number;        // Monotonically increasing sequence number from this replica
}

// Lexicographic comparison (used in RGA ordering)
function compareOpIds(a: OpId, b: OpId): number {
  if (a.replicaId !== b.replicaId) {
    return a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : 0;
  }
  return a.seq - b.seq;
}
```

**Invariants:**
- No two operations from the same replica share the same `seq`
- Op IDs are globally unique across all replicas
- Op IDs establish a total order (deterministically sortable)

### Element (Sequence Item)

```typescript
interface Element<T = any> {
  id: OpId;                  // Unique identifier of this element
  value?: T;                 // Payload data (null/undefined if deleted)
  deleted: boolean;          // True if marked as deleted (tombstone)
  deletedAt?: OpId;          // Op ID of the delete operation (if deleted)
  payloadReclaimed: boolean; // True if payload was GC'd (retained anchor)
  epoch?: number;            // Epoch when this element was created/deleted
}
```

**Invariants:**
- If `deleted === true`, the element is a tombstone and invisible to user traversal
- If `payloadReclaimed === true`, `value` is no longer accessible (GC'd)
- If `payloadReclaimed === false` and `deleted === false`, `value` is the active payload

### Operation (Op)

```typescript
type OperationType = 'insert' | 'delete';

interface Operation<T = any> {
  type: OperationType;
  replicaId: string;          // Replica that created this op
  seq: number;                // Sequence number (part of Op ID)
  value?: T;                  // Payload (for inserts)
  anchorId?: OpId;            // Element after which to insert (undefined = HEAD)
  elementId?: OpId;           // Element to delete (for delete ops)
  epoch?: number;             // Membership epoch when created (for fencing)
  timestamp?: number;         // Logical timestamp (optional, for reference)
}

// Computed Op ID
function opId(op: Operation): OpId {
  return { replicaId: op.replicaId, seq: op.seq };
}
```

### VersionVector (VV)

```typescript
type VersionVector = Map<string, number>;  // replicaId -> contiguous sequence number

// VV Comparison: partial order
function isVVLessOrEqual(vv1: VV, vv2: VV): boolean {
  for (const [replicaId, seq] of vv1.entries()) {
    if ((vv2.get(replicaId) ?? 0) < seq) {
      return false;
    }
  }
  return true;
}

// VV Merge: component-wise maximum
function mergeVV(vv1: VV, vv2: VV): VV {
  const merged = new Map(vv1);
  for (const [replicaId, seq] of vv2.entries()) {
    merged.set(replicaId, Math.max(merged.get(replicaId) ?? 0, seq));
  }
  return merged;
}

// VV Increment: advance one replica's entry (used only for contiguous prefix)
function advanceVV(vv: VV, replicaId: string, newSeq: number): VV {
  const updated = new Map(vv);
  updated.set(replicaId, newSeq);
  return updated;
}
```

**Contiguous Prefix Rule**: `VV[replicaId]` must equal the highest sequence `seq` from that replica such that all operations `(replicaId, 1), ..., (replicaId, seq)` have been applied.

### MembershipView

```typescript
interface MembershipView {
  activeReplicas: Set<string>;  // Set of active replica IDs
  epoch: number;                 // Current membership epoch
}
```

**Invariants:**
- Epoch increments by exactly 1 on each membership change
- Epochs never decrease
- A replica is active only if its ID is in `activeReplicas`

### Snapshot

```typescript
interface Snapshot<T = any> {
  sequence: Element<T>[];           // Complete RGA sequence (including tombstones)
  vv: VersionVector;                // Current VV at snapshot time
  membership: MembershipView;        // Current membership view at snapshot time
  metadata: SnapshotMetadata;        // Additional info for diagnostics
}

interface SnapshotMetadata {
  replicaId?: string;               // Snapshot creator (for reference)
  gcStats?: {                        // GC state at snapshot time
    bytesReclaimed: number;
    tombstonesRetained: number;
    reclaimableOps: number;
  };
  logicalIndex?: number;            // Logical index or frontier reference (derived from kernel state, not wall-clock)
}
```

### OperationBuffer (Internal)

```typescript
// Used to buffer out-of-order operations until dependencies are available
interface OperationBuffer {
  buffer: Map<string, Map<number, Operation>>;  // replicaId -> (seq -> Op)
  missingOps: Map<string, Set<number>>;         // replicaId -> set of missing seqs
}

// Check if dependencies are satisfied
function areDependenciesSatisfied(op: Operation, vv: VersionVector): boolean {
  const opId = { replicaId: op.replicaId, seq: op.seq };
  return (vv.get(op.replicaId) ?? 0) >= op.seq - 1;
}
```

---

## Module Structure (Proposed File Organization)

```
/kernel
  /src
    index.ts                     # Main exports
    types.ts                     # Shared interfaces and types
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

### Algorithm 1: Insert Operation

**Input**: `replicaId`, `anchorId` (optional), `value`
**Output**: `Operation` (to be applied locally and broadcast)
**Side Effects**: Increments replica's sequence number

```typescript
function insert<T>(
  replicaId: string,
  anchorId: OpId | undefined,
  value: T,
  currentSeq: number,  // Current sequence for this replica
  currentEpoch: number
): Operation<T> {
  const newSeq = currentSeq + 1;
  const op: Operation<T> = {
    type: 'insert',
    replicaId,
    seq: newSeq,
    value,
    anchorId,
    epoch: currentEpoch,
  };
  return op;
}

// Application (local or remote):
function applyInsert(
  rga: Element[],
  op: Operation,
  opIndex: Map<OpId, number>  // Maps OpId to index in RGA
): { rga: Element[]; changed: boolean } {
  const newElement: Element = {
    id: { replicaId: op.replicaId, seq: op.seq },
    value: op.value,
    deleted: false,
    epoch: op.epoch,
  };

  // Find anchor position (or start if no anchor)
  let insertAt = 0;
  if (op.anchorId) {
    insertAt = (opIndex.get(op.anchorId) ?? -1) + 1;
  }

  // Find correct position by sorting concurrent inserts by Op ID
  // Scan includes tombstones; insertion proceeds until Op ID is >= current element.
  // Tombstones are structural anchors and are traversed during position calculation.
  while (
    insertAt < rga.length &&
    compareOpIds(rga[insertAt].id, newElement.id) < 0
  ) {
    insertAt++;
  }

  // Insert and maintain index
  rga.splice(insertAt, 0, newElement);
  updateOpIndex(opIndex, rga);

  return { rga, changed: true };
}
```

**Complexity**: O(n) where n is sequence length (scan for anchor + sort position)

**Correctness**: Two concurrent inserts with the same anchor are ordered deterministically by Op ID, ensuring eventual consistency.

---

### Algorithm 2: Delete Operation

**Input**: `replicaId`, `elementId` (Op ID of element to delete), current epoch
**Output**: `Operation` with type 'delete'

```typescript
function delete_(
  replicaId: string,
  elementId: OpId,
  currentSeq: number,
  currentEpoch: number
): Operation {
  const newSeq = currentSeq + 1;
  const op: Operation = {
    type: 'delete',
    replicaId,
    seq: newSeq,
    elementId,
    epoch: currentEpoch,
  };
  return op;
}

// Application:
function applyDelete(
  rga: Element[],
  op: Operation,
  opIndex: Map<OpId, number>
): { rga: Element[]; changed: boolean } {
  const idx = opIndex.get(op.elementId!);
  if (idx === undefined) {
    // Element not found; silently skip (may arrive before element creation)
    return { rga, changed: false };
  }

  const element = rga[idx];
  if (element.deleted) {
    // Already deleted; idempotent
    return { rga, changed: false };
  }

  // Mark as deleted (tombstone), retain structural position
  element.deleted = true;
  element.deletedAt = { replicaId: op.replicaId, seq: op.seq };

  return { rga, changed: true };
}
```

**Complexity**: O(1) average (map lookup)

**Correctness**: Tombstones remain to allow concurrent inserts to place elements correctly.

---

### Algorithm 3: Apply Remote Operation (with Dependency Buffering)

**Input**: `op` (remote operation), `currentVV`, `buffer`, `membershipView`, `opEpoch`
**Output**: Updated state and/or buffered operations

```typescript
function applyOp(
  op: Operation,
  currentVV: VersionVector,
  buffer: OperationBuffer,
  membershipView: MembershipView,
  appliedOps: Map<OpId, boolean>
): {
  applied: boolean;
  buffered: boolean;
  fenced: boolean;
  unblocked: Operation[];
} {
  const opId = { replicaId: op.replicaId, seq: op.seq };

  // 1. Fencing: Check epoch and membership
  if (op.epoch !== undefined && op.epoch < membershipView.epoch) {
    // Stale epoch; reject silently
    return { applied: false, buffered: false, fenced: true, unblocked: [] };
  }

  if (!membershipView.activeReplicas.has(op.replicaId)) {
    // Replica not in active membership; reject
    return { applied: false, buffered: false, fenced: true, unblocked: [] };
  }

  // 2. Deduplication
  if (appliedOps.has(opId)) {
    // Already applied; idempotent suppression
    return { applied: false, buffered: false, fenced: false, unblocked: [] };
  }

  // 3. Contiguity check
  const contiguousSeq = currentVV.get(op.replicaId) ?? 0;
  if (op.seq > contiguousSeq + 1) {
    // Out of order; buffer it
    bufferOp(buffer, op);
    recordMissingOps(buffer, op.replicaId, contiguousSeq + 1, op.seq - 1);
    return { applied: false, buffered: true, fenced: false, unblocked: [] };
  }

  // 4. Apply operation (code elided for brevity; calls applyInsert or applyDelete)
  const { rga, changed } = applyOpToRga(op);
  appliedOps.set(opId, true);
  const newVV = advanceVV(currentVV, op.replicaId, op.seq);

  // 5. Unblock buffered operations
  const unblocked: Operation[] = [];
  let nextSeq = op.seq + 1;
  while (hasBufferedOp(buffer, op.replicaId, nextSeq)) {
    const bufferedOp = getBufferedOp(buffer, op.replicaId, nextSeq);
    unblocked.push(bufferedOp);
    removeBufferedOp(buffer, op.replicaId, nextSeq);
    nextSeq++;
  }

  return { applied: true, buffered: false, fenced: false, unblocked };
}
```

**Complexity**: O(1) for buffering decision; O(b) to unblock buffered ops (b = number of buffered ops)

**Correctness**: Out-of-order operations are buffered; causality is never violated.

---

### Algorithm 4: Contiguous Version Vector Update

**Input**: `currentVV`, `replicaId`, `incomingSeq`, `buffer`
**Output**: Updated VV (only if prefix is contiguous)

```typescript
function updateVVWithContiguousPrefixRule(
  currentVV: VersionVector,
  replicaId: string,
  incomingSeq: number,
  buffer: OperationBuffer
): VersionVector {
  const currentSeq = currentVV.get(replicaId) ?? 0;

  // Only advance if all operations from 1..incomingSeq are applied or buffered
  if (incomingSeq > currentSeq + 1) {
    // Gap detected; wait for missing operations
    return currentVV;
  }

  // Advance to incomingSeq
  return advanceVV(currentVV, replicaId, incomingSeq);
}
```

**Invariant**: VV[replicaId] is always the highest contiguous sequence from that replica.

---

### Algorithm 5: Stable Frontier Computation

**Input**: Acknowledged VVs from all active replicas
**Output**: Stable Frontier (component-wise minimum)

```typescript
function computeStableFrontier(
  acknowledgedVVs: Map<string, VersionVector>,
  activeReplicas: Set<string>
): VersionVector {
  const frontier = new Map<string, number>();

  for (const replicaId of activeReplicas) {
    const vv = acknowledgedVVs.get(replicaId);
    if (vv === undefined) {
      // Replica hasn't acked; frontier entry is 0 (no ops stable from that replica yet)
      frontier.set(replicaId, 0);
    } else {
      frontier.set(replicaId, vv.get(replicaId) ?? 0);
    }
  }

  // Component-wise minimum (only among active replicas)
  let minSeq = Infinity;
  for (const seq of frontier.values()) {
    minSeq = Math.min(minSeq, seq);
  }

  return frontier;
}

function isCausallyStable(opId: OpId, stableFrontier: VersionVector): boolean {
  return (stableFrontier.get(opId.replicaId) ?? 0) >= opId.seq;
}
```

**Monotonicity**: Frontier only advances or stays the same (never regresses).
**Safety**: An operation is causally stable only if all active replicas have applied it.

---

### Algorithm 6: Stage 1 Garbage Collection (Payload Reclamation)

**Input**: RGA, stable frontier, GC policy
**Output**: Updated RGA with reclaimed payloads; retained anchors remain

```typescript
function performStage1GC(
  rga: Element[],
  stableFrontier: VersionVector,
  gcStats: GCStats
): { rga: Element[]; bytesReclaimed: number } {
  let bytesReclaimed = 0;

  for (const element of rga) {
    // Only reclaim deleted elements that are causally stable
    if (
      element.deleted &&
      !element.payloadReclaimed &&
      isCausallyStable(element.deletedAt!, stableFrontier)
    ) {
      const payloadSize = estimatePayloadSize(element.value);
      element.value = undefined;
      element.payloadReclaimed = true;
      bytesReclaimed += payloadSize;
      gcStats.bytesReclaimed += bytesReclaimed;
      gcStats.tombstonesRetained += 1;
    }
  }

  return { rga, bytesReclaimed };
}

function estimatePayloadSize(value: any): number {
  // Rough estimation; in production, use actual serialization size
  return JSON.stringify(value).length;
}
```

**Complexity**: O(n) where n is sequence length (scan all elements)

**Correctness**: 
- Reclaimed payloads are never accessed again (retained anchor has no value)
- Structural integrity is preserved (anchor position unchanged)
- Non-breaking for applications (invisible change)

---

### Algorithm 7: Snapshot Creation

**Input**: Current RGA, VV, membership, epoch
**Output**: Serializable snapshot

```typescript
function createSnapshot<T>(
  rga: Element<T>[],
  vv: VersionVector,
  membership: MembershipView,
  gcStats: GCStats
): Snapshot<T> {
  // Deep copy RGA to avoid external mutations
  const sequenceCopy = rga.map((elem) => ({
    ...elem,
    id: { ...elem.id },
  }));

  // Copy VV
  const vvCopy = new Map(vv);

  // Copy membership
  const membershipCopy = {
    activeReplicas: new Set(membership.activeReplicas),
    epoch: membership.epoch,
  };

  return {
    sequence: sequenceCopy,
    vv: vvCopy,
    membership: membershipCopy,
    metadata: {
      creator: "replicaId",
      logicalIndex: rga.length,  // Derived from kernel state; number of applied operations
      gcStats,
    },
  };
}
```

**Determinism**: Deep copies ensure no shared mutable references.

---

### Algorithm 8: Snapshot Rejoin

**Input**: Snapshot, post-snapshot operations
**Output**: Initialized CRDT state

```typescript
function rejoinFromSnapshot<T>(
  snapshot: Snapshot<T>,
  postSnapshotOps: Operation<T>[]
): {
  rga: Element<T>[];
  vv: VersionVector;
  membership: MembershipView;
} {
  // Initialize from snapshot
  let rga = [...snapshot.sequence];
  let vv = new Map(snapshot.vv);
  let membership = {
    activeReplicas: new Set(snapshot.membership.activeReplicas),
    epoch: snapshot.membership.epoch,
  };

  // Apply post-snapshot operations in order
  for (const op of postSnapshotOps) {
    // Dedup: skip if already in snapshot VV
    if ((vv.get(op.replicaId) ?? 0) >= op.seq) {
      continue;
    }

    // Apply operation (simplified; actual code would use full applyOp logic)
    if (op.type === 'insert') {
      const { rga: updated } = applyInsert(rga, op, buildOpIndex(rga));
      rga = updated;
    } else if (op.type === 'delete') {
      const { rga: updated } = applyDelete(rga, op, buildOpIndex(rga));
      rga = updated;
    }

    // Update VV (with contiguity check)
    const currentSeq = vv.get(op.replicaId) ?? 0;
    if (op.seq === currentSeq + 1) {
      vv = advanceVV(vv, op.replicaId, op.seq);
    }
  }

  return { rga, vv, membership };
}
```

**Correctness**: Snapshot + post-ops produce the same state as continuous application.

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
   * @param replicaId Replica creating this operation
   * @param anchorId Op ID of element to insert after (undefined = HEAD)
   * @param value Data to insert
   * @returns Operation that was applied locally and should be broadcast
   */
  insert(replicaId: string, anchorId: OpId | undefined, value: T): Operation<T>;

  /**
   * Delete an element (mark as tombstone).
   * @param replicaId Replica creating this operation
   * @param elementId Op ID of element to delete
   * @returns Operation that was applied locally and should be broadcast
   */
  delete(replicaId: string, elementId: OpId): Operation<T>;

  /**
   * Apply a remote operation to this replica's state.
   * May buffer if dependencies are missing.
   * @param op Operation from another replica
   * @param fromEpoch Optional epoch context for fencing
   */
  applyOp(op: Operation<T>, fromEpoch?: number): void;

  // ==================== Query Methods ====================

  /**
   * Get the current sequence (non-deleted elements only).
   * Visible elements are ordered by their anchor-based placement in the RGA, with concurrent 
   * inserts at the same anchor ordered deterministically by Op ID (replicaId first, then sequence).
   * All replicas applying the same operations in any order produce identical visible sequences.
   * @returns Array of non-deleted elements, deterministically ordered by anchor and Op ID
   */
  getSequence(): Element<T>[];

  /**
   * Get the current Version Vector.
   * @returns VV mapping replica ID to contiguous sequence number
   */
  getVV(): VersionVector;

  /**
   * Get the current membership view (active replicas and epoch).
   * @returns MembershipView with active replicas and epoch
   */
  getMembershipView(): MembershipView;

  /**
   * Check if a given element is marked as deleted.
   * @param elementId Op ID of element
   * @returns true if deleted (tombstone), false if active
   */
  isElementDeleted(elementId: OpId): boolean;

  /**
   * Check if an operation is causally stable (safe for GC).
   * @param opId Op ID to check
   * @returns true if at or below stable frontier, false otherwise
   */
  isCausallyStable(opId: OpId): boolean;

  /**
   * Get the current stable frontier (for coordinator use).
   * @returns VersionVector representing the stable frontier
   */
  getStableFrontier(): VersionVector;

  /**
   * Get garbage collection statistics.
   * @returns GC stats: bytes reclaimed, tombstones retained, reclaimable ops count
   */
  getGCStats(): {
    bytesReclaimed: number;
    tombstonesRetained: number;
    reclaimableOps: number;
  };

  // ==================== Snapshots ====================

  /**
   * Create a snapshot of the current state.
   * @returns Snapshot including sequence, VV, membership, and metadata
   */
  snapshot(): Snapshot<T>;

  /**
   * Initialize from a snapshot (typically called on rejoin).
   * @param snapshot Snapshot to restore from
   */
  rejoinFromSnapshot(snapshot: Snapshot<T>): void;

  // ==================== Membership ====================

  /**
   * Update the membership view (called by coordinator).
   * Increments epoch on change.
   * @param newActiveReplicas New set of active replica IDs
   */
  updateMembership(newActiveReplicas: Set<string>): void;

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
// Operations are serializable to JSON with deterministic key order
function serializeOperation<T>(op: Operation<T>): string {
  const ordered = {
    type: op.type,
    replicaId: op.replicaId,
    seq: op.seq,
    ...(op.value !== undefined && { value: op.value }),
    ...(op.anchorId && { anchorId: op.anchorId }),
    ...(op.elementId && { elementId: op.elementId }),
    ...(op.epoch !== undefined && { epoch: op.epoch }),
  };
  return JSON.stringify(ordered);
}

function deserializeOperation<T>(json: string): Operation<T> {
  return JSON.parse(json);
}

// Snapshots are similarly JSON-serializable
function serializeSnapshot<T>(snapshot: Snapshot<T>): string {
  return JSON.stringify(snapshot);
}

function deserializeSnapshot<T>(json: string): Snapshot<T> {
  return JSON.parse(json);
}
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: RGA Convergence

For any set of operations applied in the same order across multiple replicas, the resulting sequences are byte-identical.

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

For any replica and any received operation, the Version Vector entry for that replica advances only when all operations from sequence 1 through that operation's sequence have been applied or are causally stable.

**Validates: Requirements 4.3, 4.4**

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

### Property 11: Stale-Epoch Fencing

For any operation from a replica with an epoch lower than the current active epoch, that operation is rejected and does not mutate state, VV, or membership.

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
2. **Stale-Epoch Operations**: Silently rejected, diagnostic event emitted
3. **Out-of-Order Operations**: Buffered, never dropped
4. **Invalid Anchors**: Treated as HEAD (insert at beginning)
5. **Non-Existent Elements**: Delete operations on missing elements are skipped (no-op)

### Graceful Degradation

- **Network Partition**: Replicas continue to operate locally; stable frontier stalls (expected behavior)
- **Evicted Replica**: Recognizes itself as evicted, stops applying its own ops, can rejoin with new incarnation
- **Stale Coordinator**: Replicas continue; frontier does not advance (safe stall)

### Diagnostic Events

- `'staleEpochOp'`: Emitted when an operation from an evicted replica is received
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

- **Operation Sequences**: Arbitrary operations with varying anchors, values, deletes
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
| `insert()` | O(n) | n = sequence length; scan for anchor + find sort position |
| `delete()` | O(1) | Map lookup + flag mutation |
| `applyOp()` | O(1) avg | O(b) if unblocking buffered ops (b = buffer size) |
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
- Clear semantics (elements retain creation order)
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


