# Implementation Plan: CRDT Kernel

## Overview

This implementation plan breaks down the CRDT Kernel design into discrete, actionable tasks organized into 10 major groups: project setup, core modules, orchestrator, testing infrastructure, unit tests, property-based tests, integration tests, documentation, transport & coordinator, and applications. Tasks are prioritized as MUST (core functionality), SHOULD (enhancements), or STRETCH (advanced goals). Each task includes effort estimates, dependencies, acceptance criteria, and validation strategies.

**Target Completion**: Dec 3, 2026 (before Kiroween Dec 4 deadline)

---

## Task Groups and Dependencies

```
Setup (KER-001 to KER-005)
  ↓
Core Modules (KER-006 to KER-029)
  ├→ Lamport Clock Module (KER-006)
  ├→ RGA Module (KER-007 to KER-010)
  ├→ VV Module (KER-011 to KER-014)
  ├→ OpLog Module (KER-015 to KER-017)
  ├→ Membership Module (KER-018 to KER-022)
  ├→ GC Module (KER-023 to KER-026)
  └→ Snapshot Module (KER-027 to KER-029)
  ↓
Orchestrator (KER-030 to KER-033)
  ↓
Testing Infrastructure (KER-034 to KER-037)
  ↓
Unit Tests (KER-038 to KER-046)
  ↓
Property-Based Tests (KER-047 to KER-064)
  ↓
Integration Tests (KER-065 to KER-069)
  ↓
Documentation (KER-070 to KER-073)
  ↓
Transport & Coordinator (KER-074 to KER-077)
  ↓
Applications (KER-078 to KER-080)
```

---

## Tasks

### Phase 1: Project Setup

- [x] 1. **Repository Structure and TypeScript Configuration** (KER-001)
  - Initialize `/kernel` directory with subdirectories: `/src`, `/tests`, `/testing`
  - Configure `tsconfig.json` for TypeScript (strict mode enabled)
  - Set up `package.json` with dependencies: `typescript`, `vitest`, `fast-check`
  - Create `.eslintrc` for code style consistency
  - **Acceptance Criteria**:
    - TypeScript compiles without errors
    - `npm run build` produces `/dist` output
    - ESLint runs cleanly on empty src files
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: None
  - **Validation**: Run `npm run build` and verify output

- [x] 2. **Test Framework Setup (Vitest)** (KER-002)
  - Configure Vitest with `vitest.config.ts`
  - Set up coverage reporting (coverage > 85% goal)
  - Create test utilities for deterministic seeding
  - Add scripts: `npm run test`, `npm run test:watch`, `npm run coverage`
  - **Acceptance Criteria**:
    - `npm run test` runs empty test suite
    - Coverage report generated in JSON format
    - Deterministic seeding works (same seed = same results)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-001
  - **Validation**: Run `npm run test` and verify output format

- [ ] 3. **Property-Based Testing Setup (fast-check)** (KER-003)
  - Install and configure fast-check
  - Create custom arbitraries for Op, Element, VersionVector, MembershipView
  - Set up deterministic seeding in fast-check tests
  - Create test helpers for shrinking and example collection
  - **Acceptance Criteria**:
    - fast-check generates diverse operation sequences
    - Shrinking produces minimal failing examples
    - Seeded tests are reproducible
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-002
  - **Validation**: Write and run a sample fast-check property (always-pass) to verify setup

- [x] 4. **Shared Types and Interfaces** (KER-004)
  - Create `src/types.ts` with all core interfaces:
    - `OpIdKey` (string `` `${replicaId}:${seq}` ``, never an object), `Element<T>` (includes `anchor`), `Operation<T>` (`id`, `anchor`, `target`; no separate `seq`), `VersionVector`, `MembershipView` (`activeMembers`, `evictedMembers` as replicaId → cutoff, `epoch`), `Snapshot<T>` (no wall-clock field), `OperationBuffer`
    - Source of truth: `kernel/src/types.ts` and the Type Mapping table in `.kiro/steering/tech.md`
  - Include JSDoc comments for all interfaces
  - Export types in `src/index.ts`
  - **Acceptance Criteria**:
    - All 7 core types defined with clear semantics
    - No circular imports
    - Types are immutable or documented as COW
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-001
  - **Validation**: TypeScript compiles; import types in a test file and verify

- [x] 5. **Utility Functions and Helpers** (KER-005)
  - Create `src/utils.ts` with helpers:
    - `compareOpIds(a, b)`: lexicographic comparison
    - (`opId(op)` is obsolete: `Operation.id` already is the `OpIdKey`)
    - `stableStringify(value)`: deterministic JSON (keys sorted at every level; rejects Map/Set)
    - `serializeOp(op)`: deterministic JSON serialization
    - `deserializeOp(json)`: parse and VALIDATE operation (trust boundary; throws on malformed input)
    - `buildOpIndex(rga)`: map OpId → index
    - `estimatePayloadSize(value)`: rough estimate
  - Create `src/events.ts` with event emitter logic (simple publish-subscribe)
  - **Acceptance Criteria**:
    - All helper functions produce deterministic output
    - Op ID comparison is transitive and consistent
    - Serialization/deserialization round-trips correctly
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-001, KER-004
  - **Validation**: Unit test each helper; verify determinism with seeding

---

### Phase 2: Core Modules Implementation

#### RGA Module (Replicated Growable Array)

- [x] 6. **RGA Data Structure and Core Insert Logic** (KER-006)
  - Create `src/rga.ts` with:
    - `RGAState`: `elements: Map<OpIdKey, Element>` plus `children: Map<OpIdKey | 'HEAD', OpIdKey[]>` kept sorted newest-first (design.md Algorithm 1). The RGA is a TREE, not a flat array; do NOT implement the insert as a flat array scan.
    - `insert(anchorId, value)` function: create insert operation (`id`, `anchor`, `lamport`)
    - `applyInsert(rga, op)` function: create the element (storing its `anchor`) and insert its id into the parent's child list, skipping siblings that are newer
    - Sibling key: `(lamport, replicaId)`, lamport numeric first, then replicaId by code unit (no `localeCompare`); higher key = newer = earlier in the child list
    - Anchor resolution logic (undefined = HEAD)
  - Ensure deterministic ordering for concurrent inserts
  - **Acceptance Criteria**:
    - Insert returns Operation with correct Op ID
    - Concurrent inserts to same anchor order newest-first by `(lamport, replicaId)` consistently
    - A local insert after anchor A lands immediately after A, before A's existing children (insert into the middle of a sequence works)
    - Element stores its `anchor`
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-004, KER-005
  - **Validation**: Unit test: insert at various anchors; verify sibling order is newest-first; insert in the middle lands right after its anchor; nested concurrent inserts (depth ≥ 3) keep every subtree contiguous

- [x] 7. **RGA Delete Logic and Tombstones** (KER-007)
  - Implement `delete_({ replicaId, target, clock, seq, epoch })` function (one options object, same shape as `insert`): create delete operation (`id`, `target`, `lamport`)
  - Implement `applyDelete(state, op)` function: mark element as deleted (tombstone); returns whether the element changed (false for a no-op)
  - ALWAYS record the delete op in `deleteOps[target]`, even when it is a no-op (Stage 1 GC reclaims when ANY delete op of the element is stable)
  - Track deletion with `deletedAt` = the SMALLEST delete Op ID applied so far (code-unit order), so concurrent deletes give identical state on every replica
  - Ensure tombstones are retained for structural integrity
  - **Acceptance Criteria**:
    - Delete marks element as deleted without removing it
    - Deleted elements remain as structural anchors
    - Re-deleting same element is idempotent for visible state, is recorded in `deleteOps`, and never changes `deletedAt` to a larger Op ID
    - Two replicas applying the same two concurrent deletes in opposite orders end with identical `deletedAt`
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-006
  - **Validation**: Unit test: delete → verify tombstone; verify anchor still works

- [x] 8. **RGA Sequence Traversal and Querying** (KER-008)
  - Implement `traverse(rga)` / `getSequence(rga)`: ITERATIVE depth-first pre-order traversal of the anchor tree (explicit stack, no recursion); `getSequence` returns only non-deleted elements
  - Implement `isElementDeleted(rga, elementId)` function: check deletion status
  - Reuse `buildOpIndex(elements)` from `utils.ts` (already implemented in KER-005) for index lookups over the traversal order
  - Support efficient anchor resolution and position queries
  - **Acceptance Criteria**:
    - `getSequence()` returns only visible elements in correct order
    - A 50,000-element chain (each insert anchored on the previous one) traverses without a stack overflow
    - `isElementDeleted()` correctly identifies tombstones
    - OpIndex is accurate and consistent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-007
  - **Validation**: Unit test: mixed insert/delete; verify sequence and index consistency

- [x] 9. **RGA Concurrent Insert Ordering** (KER-009)
  - Implement deterministic ordering for concurrent inserts targeting the same anchor: newest first by `(lamport, replicaId)`, lamport numeric then replicaId by code unit: a < b ? -1 : a > b ? 1 : 0 (no localeCompare)
  - Tombstones are ordinary tree nodes: they keep their children and may be anchors
  - Test that two replicas applying the same concurrent inserts, at any nesting depth, produce identical order
  - **Acceptance Criteria**:
    - Same set of concurrent inserts always order the same way
    - Order is deterministic across all replicas (code-unit comparison only)
    - Subtree contiguity: every element's descendants follow it contiguously, even when a concurrent sibling arrives later (regression test: A ← B ← C chain plus concurrent sibling D of B must never produce an order that separates B from C)
    - Insert anchored on a tombstone is placed in the tombstone's subtree
    - Property test: any permutation of concurrent inserts, including nested ones (depth ≥ 3), converges to identical order
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-006, KER-008
  - **Validation**: Unit test: 2+ concurrent inserts → verify newest-first `(lamport, replicaId)` order (code-unit only); subtree-contiguity regression test; tombstone-anchor test; PBT: random insertion order with nested anchors → same final sequence

- [x] 10. **RGA Payload Reclamation Preparation** (KER-010)
  - Add `payloadReclaimed` flag to Element interface
  - Implement logic to mark payloads as reclaimed (GC will call this)
  - Ensure reclaimed elements still function as anchors
  - **Acceptance Criteria**:
    - Payload can be marked as reclaimed
    - Reclaimed elements skip payload access but remain in structure
    - Serialize correctly even with reclaimed payloads
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-007
  - **Validation**: Unit test: mark payload reclaimed → verify anchor still works

#### VersionVector Module

- [x] 11. **VersionVector Operations (Create, Clone, Query)** (KER-011)
  - Create `src/vv.ts` with:
    - `createVV()`: initialize empty VV (all entries 0)
    - `cloneVV(vv)`: deep copy for immutability
    - `getEntry(vv, replicaId)`: query entry (default 0)
    - `mergeVV(vv1, vv2)`: component-wise maximum
    - `advanceVV(vv, replicaId, seq)`: increment entry
  - Ensure immutability (return new VV, don't mutate)
  - **Acceptance Criteria**:
    - All functions return new VV objects
    - Merge computes component-wise max correctly
    - Advance only increments specified entry
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-004, KER-005
  - **Validation**: Unit test each function; verify immutability

- [ ] 12. **VersionVector Partial Order and Causality** (KER-012)
  - **Status note**: partial order, concurrency and transitivity are done and tested (`compareVersionVectors` in `utils.ts`). Still open: `computeVVDifference` (`Difference identifies missing operations`) has no function and no test yet.
  - Implement `isVVLessOrEqual(vv1, vv2)` function: partial order check
  - Implement `areVVsConcurrent(vv1, vv2)` function: detect concurrent state
  - Implement `computeVVDifference(vv1, vv2)` function: missing entries
  - Verify transitivity of partial order
  - **Acceptance Criteria**:
    - Partial order is transitive (A ≤ B and B ≤ C implies A ≤ C)
    - Concurrent detection correctly identifies incomparable VVs
    - Difference identifies missing operations
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011
  - **Validation**: Unit test partial order properties; PBT: verify transitivity over random VVs

- [x] 13. **Contiguous Prefix Rule Enforcement** (KER-013)
  - Implement `advanceContiguous(currentVV, replicaId, seq)` function (design.md Algorithm 4): advance only when `seq === VV[replicaId] + 1`; otherwise return the VV unchanged (gap, or already counted). The VV never decreases.
  - The orchestrator calls it for EVERY applied op, including no-ops; buffered ops never call it
  - The contiguity rule is enforced here and in the orchestrator's readiness check (`isReady`); `updateVersionVector` in `utils.ts` is max-based and must NOT be used to advance the VV when applying ops
  - Detect gaps and prevent advancing
  - **Acceptance Criteria**:
    - VV only advances when gap is closed
    - Gaps are detected correctly
    - VV entry is accurate (never exceeds contiguous prefix)
    - Re-delivering an old seq leaves the VV unchanged (no regression)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011
  - **Validation**: Unit test: apply ops out of order → verify VV stalls; then fill gap → verify VV advances

- [x] 14. **VersionVector Serialization and Cloning** (KER-014)
  - Implement deterministic serialization (JSON with sorted keys)
  - Implement deep cloning for safety
  - Use code-unit comparison for replicaId ordering in serialization:  a < b ? -1 : a > b ? 1 : 0 (no localeCompare)
  - Test round-trip (serialize → deserialize = original)
  - **Acceptance Criteria**:
    - Serialization is deterministic (same VV always serializes same, code-unit ordering only)
    - Deserialization recovers original VV exactly
    - Clones are independent (mutating clone doesn't affect original)
    - Op ID comparison uses code-unit only (no locale-dependent functions)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011
  - **Validation**: Unit test serialization with deterministic comparison; PBT: random VVs → serialize/deserialize → identical

#### OpLog Module

- [ ] 15. **Operation Log Append and Storage** (KER-015)
  - Create `src/oplog.ts` with:
    - `appendOp(log, op)` function: append operation to log
    - `getAllOps(log)` function: return all ops in order
    - `getOpsByReplica(log, replicaId)` function: filter by replica
    - Maintain log as append-only (no mutations)
  - Ensure deterministic ordering (log order matches application order)
  - Ops are appended when APPLIED (never while only buffered), including no-op ops, so log order is always a valid causal replay order
  - **Acceptance Criteria**:
    - Ops are stored in append order
    - Log is append-only (no removals/reordering)
    - Querying works correctly
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-004, KER-005
  - **Validation**: Unit test: append ops → verify order; query by replica → verify filtering

- [ ] 16. **Operation Deduplication in Log** (KER-016)
  - Implement `shouldAppendOp(log, op)` function: check if op already exists
  - Use Op ID as deduplication key (replicaId, seq)
  - Maintain seen set for O(1) lookup
  - **Acceptance Criteria**:
    - Duplicate ops detected by Op ID
    - Duplicates are not appended
    - O(1) dedup check
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-015
  - **Validation**: Unit test: append same op twice → verify log has it once

- [ ] 17. **OpLog Deterministic Replay** (KER-017)
  - Implement `replayLog(log, initialRGA)` function: replay all ops in order
  - Verify deterministic output (same log → same RGA state)
  - Support for rebuilding state from log
  - **Acceptance Criteria**:
    - Replaying log produces deterministic RGA state
    - Multiple replays produce byte-identical results
    - State is consistent with operation application
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-015, KER-006
  - **Validation**: Unit test: build state manually vs. replay log → verify identical

#### Membership Module

- [ ] 18. **Membership View and Epoch Tracking** (KER-018)
  - Create `src/membership.ts` with:
    - `MembershipView` (`activeMembers` set, `evictedMembers` map replicaId → cutoff, `epoch` number)
    - `createMembership(activeMembers)` function: initialize at epoch 0 with no evicted members
    - `getMembership()` function: query current membership
    - `getEpoch()` function: query current epoch
  - Ensure epoch starts at 0 and increments on changes
  - **Acceptance Criteria**:
    - Membership initialized correctly
    - Epoch increments by exactly 1 on membership change
    - Querying membership works
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-004
  - **Validation**: Unit test: create membership → verify epoch is 0; add/remove replica → verify epoch increments

- [ ] 19. **Membership Updates and Eviction** (KER-019)
  - Implement `addReplica(membership, replicaId)` function: add replica, increment epoch
  - Implement `removeReplica(membership, replicaId, cutoff)` function: evict replica (move it to `evictedMembers` with its cutoff), increment epoch
  - Implement `applyMembershipView(current, newView)`: install a view published by the coordinator; ignore a view whose epoch is not greater than the current epoch
  - Track eviction epoch and reason (for diagnostics; no wall-clock time inside the kernel)
  - **Acceptance Criteria**:
    - Adding/removing replica increments epoch by 1
    - Replica ID added to / removed from `activeMembers`; an evicted replica ID is recorded with its cutoff and never returns (a rejoin is a new incarnation with a new ID)
    - Epoch is monotonic (never decreases)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-018
  - **Validation**: Unit test: add/remove → verify epoch and membership

- [ ] 20. **Fencing: Edit Operations by Author + Cutoff, Control Messages by Epoch** (KER-020)
  - Two SEPARATE mechanisms (requirements.md §10 "Fencing Architecture"); do not conflate them
  - Implement `isFenced(membership, replicaId, seq)` for EDIT operations: accept if the author is active, OR the author is evicted AND `seq <= cutoff`; reject otherwise (unknown author = reject). The op's `epoch` field is NEVER consulted.
  - Implement `isControlMessageRejected(membership, senderId, senderEpoch)` for control messages (ack, sync request, membership/frontier update): reject if the sender is not active OR its epoch is lower than the current epoch; the reply carries the current epoch
  - Implement `isReplicaActive(replicaId, membership)` function: check membership
  - Return fencing decision (reject vs. accept)
  - **Acceptance Criteria**:
    - Edit ops from an active author are accepted regardless of their `epoch` value
    - Edit ops from an evicted author with `seq <= cutoff` are accepted; with `seq > cutoff` are rejected
    - Edit ops from an unknown author are rejected
    - Control messages from non-active or stale-epoch senders are rejected with the current epoch
    - Fencing is transparent (no error, just rejection)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-019
  - **Validation**: Unit test: evicted-author op beyond cutoff → rejected; at cutoff → accepted; op with a stale `epoch` value from an active author → accepted; control message with stale epoch → rejected

- [ ] 21. **Membership Serialization and Snapshots** (KER-021)
  - Implement `serializeMembership(membership)` function: JSON serialization
  - Implement `deserializeMembership(json)` function: JSON parsing
  - Ensure deterministic serialization
  - **Acceptance Criteria**:
    - Serialization is deterministic
    - Round-trip (serialize → deserialize) recovers original
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-018
  - **Validation**: Unit test: serialize/deserialize → verify identical

- [ ] 23. **Eviction Barrier and Cutoff Tracking** (KER-022)
  - Implement `cutoffs: Map<replicaId, seq>` to track eviction cutoff for each evicted replica
  - Implement `recordCutoff(replicaId, cutoffSeq)` function: record max applied seq before eviction
  - Implement `isBeyondCutoff(replicaId, seq)` function: check if op seq > cutoff[replicaId]
  - Fencing rule: accept op if author is active OR (author is evicted AND seq <= cutoff[author])
  - Cutoffs are stored in `MembershipView.evictedMembers`; the cutoff value is supplied by the coordinator (max of the survivors' contiguous applied seq for the target), never derived from time
  - **Acceptance Criteria**:
    - Cutoff is recorded when replica is evicted
    - Operations from evicted replicas beyond cutoff are rejected
    - Operations from evicted replicas at or below cutoff are applied
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-021
  - **Validation**: Unit test: evict replica → record cutoff → verify ops are fenced correctly

#### Garbage Collector Module

- [ ] 24. **Stage 1 GC Logic (Payload Reclamation)** (KER-023)
  - Create `src/gc.ts` with:
    - `performStage1GC(rga, stableFrontier)` function: identify reclaimable payloads
    - Mark payloads as reclaimed (set value to undefined, set `payloadReclaimed = true`)
    - Retain structural anchors (Op ID and deletion flag remain)
    - Track bytes reclaimed
  - Ensure reclaimed elements still function as anchors
  - **Acceptance Criteria**:
    - Only deleted elements with stable deletes are reclaimed
    - Payloads are cleared but anchors remain
    - Bytes reclaimed counter is accurate
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-007, KER-010
  - **Validation**: Unit test: GC with frontier → verify payloads reclaimed; verify sequence unchanged

- [ ] 25. **Stable Frontier Computation** (KER-024)
  - Implement `computeStableFrontier(acknowledgedVVs, activeReplicas)` function: component-wise minimum
  - Only consider active replicas in minimum
  - Handle missing VVs (treat as 0)
  - **Acceptance Criteria**:
    - Frontier is component-wise minimum of active VVs
    - Frontier is VersionVector type
    - Missing replicas don't break computation
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011, KER-018
  - **Validation**: Unit test: compute frontier with 3 replicas → verify minimum

- [ ] 26. **Causally Stable Operation Identification** (KER-025)
  - Implement `isCausallyStable(opId, stableFrontier)` function: check if op ≤ frontier
  - **Acceptance Criteria**:
    - Op at or below frontier is stable
    - Op above frontier is not stable
    - Result is deterministic
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-023
  - **Validation**: Unit test: op at various positions relative to frontier

- [ ] 27. **GC Statistics and Diagnostics** (KER-026)
  - Implement `getGCStats(...)` returning `GCStats` (types.ts):
    - `tombstoneCount`: deleted elements currently in the structure
    - `payloadsReclaimed`: how many of them are retained anchors (payload reclaimed)
    - `bytesSaved`: cumulative estimated bytes freed
    - `replicasEvicted`: evicted replicas
    - `stableFrontier`: copy of the frontier when the stats were taken
  - Track stats as RGA is modified
  - **Acceptance Criteria**:
    - Stats are accurate and up-to-date
    - Bytes reclaimed is sum of reclaimed payloads
    - Stats are used by Graveyard panel
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-022
  - **Validation**: Unit test: after GC → verify stats

#### Snapshot Module

- [ ] 28. **Snapshot Creation** (KER-027)
  - Create `src/snapshot.ts` with:
    - `createSnapshot(rga, vv, membership, gcStats)` function
    - Include deep copies of elements (in traversal order, each with its `anchor`), VV, and membership (active members, evicted members WITH cutoffs, epoch)
    - Add `replicaId`, `lamportClock` (logical timestamp) and `gcStats` — NO wall-clock timestamp (Date.now())
    - Ensure no shared mutable references
  - **Acceptance Criteria**:
    - Snapshot includes all state needed to bootstrap
    - Deep copies prevent external mutation
    - `lamportClock` is the only timestamp; no `Date.now()` anywhere
    - Evicted members' cutoffs are included so post-snapshot fencing works after restore
    - No Date.now() calls in kernel code
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-010, KER-011, KER-018, KER-025
  - **Validation**: Unit test: create snapshot → verify all fields present; verify no Date.now() calls; mutate original → verify snapshot unchanged

- [ ] 29. **Snapshot Serialization** (KER-028)
  - Implement `serializeSnapshot(snapshot)` function: deterministic JSON via `stableStringify`. Convert `Map`/`Set` fields (vv, membership) to plain objects/sorted arrays first: `JSON.stringify` alone turns them into `{}` and silently loses data
  - Implement `deserializeSnapshot(json)` function: parse, VALIDATE (trust boundary), and rebuild the Map/Set fields
  - Ensure deterministic serialization
  - **Acceptance Criteria**:
    - Serialization is deterministic
    - Round-trip recovers original snapshot, including Map/Set fields (vv, membership) and `serialize(deserialize(json)) === json`
    - Suitable for storage/transmission
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-026
  - **Validation**: Unit test: serialize → deserialize → verify identical

- [ ] 30. **Snapshot Rejoin and State Recovery** (KER-029)
  - Implement `restoreFromSnapshot(snapshot)` (design.md Algorithm 8): rebuild the RGA tree from the elements' anchors (appending in traversal order preserves newest-first child lists), VV, membership with cutoffs, and Lamport clock; start with an empty buffer and log
  - Rejoin = restore + feeding EVERY post-snapshot op through the normal `applyOp` pipeline (KER-031). There must be NO separate, simplified apply path for rejoin. The composition lives in the CRDT class (`CRDT.fromSnapshot(snapshot, replicaId?)`, KER-033); a returning evicted replica passes a NEW replicaId
  - **Acceptance Criteria**:
    - Restored state (sequence, VV, membership, Lamport clock) equals the snapshotted replica's state
    - Post-snapshot ops that arrive out of order are buffered, not dropped
    - Post-snapshot ops from an evicted author beyond its cutoff are rejected
    - Ops at or below the snapshot VV are suppressed as duplicates (including non-contiguous redelivery)
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-026, KER-006
  - **Validation**: Unit test: snapshot + rejoin → verify state matches original; PBT: random post-ops order → same final state

---

### Phase 3: CRDT Orchestrator

- [ ] 31. **CRDT Class Initialization and State Management** (KER-030)
  - Create `src/crdt.ts` with main CRDT class
  - Initialize RGA, VV, OpLog, Membership, GC state
  - Track current sequence number for this replica
  - Support optional snapshot-based initialization
  - **Acceptance Criteria**:
    - Class initializes correctly with replicaId
    - State is consistent after initialization
    - Snapshot-based init works
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-006, KER-011, KER-015, KER-018, KER-028
  - **Validation**: Unit test: create CRDT → verify initial state

- [ ] 32. **CRDT Core API (insert, delete, applyOp)** (KER-031)
  - Implement public methods:
    - `insert(anchorId, value)` → Operation
    - `delete(elementId)` → Operation
    - `applyOp(op)` → void (with dependency buffering)
  - Follow design.md Algorithm 3 exactly: (1) fence by author + cutoff, (2) drop duplicates (`seq <= VV[replica]`, or already buffered), (3) buffer if not ready (previous seq, anchor, or target missing), (4) apply, then unblock with an ITERATIVE work queue (no recursive `applyOp`); re-check fencing for buffered ops before applying them
  - For EVERY applied op, including no-ops (e.g., delete of an already-deleted element): append to OpLog, advance the VV via `advanceContiguous`, update the Lamport clock. Only the `sequenceChanged` event depends on whether state actually changed
  - **Acceptance Criteria**:
    - Insert/delete create operations and update state
    - applyOp handles out-of-order ops with buffering
    - Duplicates are suppressed
    - Ops from non-active authors beyond their cutoff are rejected (by author, not by epoch)
    - A no-op delete (two replicas concurrently delete the same element) does not stall later ops from that replica: the VV advances past it and the next op applies
    - A chain of 10,000 mutually dependent buffered ops, delivered in reverse order, unblocks without a stack overflow and in well under a second (unblocking looks up only the directly affected ops via `buffer.waiting` and the author's next seq; it must not rescan the whole buffer after each applied op, which took ~20 s in a prototype)
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-006, KER-007, KER-013, KER-020
  - **Validation**: Unit test: insert/delete/applyOp with various scenarios; verify state consistency

- [ ] 33. **CRDT Query Methods** (KER-032)
  - Implement public methods:
    - `getSequence()` → Element[]
    - `getVV()` → VersionVector
    - `getMembershipView()` → MembershipView
    - `isElementDeleted(elementId)` → boolean
    - `isCausallyStable(opId)` → boolean
    - `getStableFrontier()` → VersionVector
    - `getGCStats()` → `GCStats` { tombstoneCount, payloadsReclaimed, bytesSaved, replicasEvicted, stableFrontier }
  - All methods are read-only, non-mutating
  - **Acceptance Criteria**:
    - All query methods return correct values
    - No mutation side effects
    - Results are consistent with state
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-030
  - **Validation**: Unit test: insert/delete → query → verify accuracy

- [ ] 34. **CRDT Events and Membership Updates** (KER-033)
  - Implement event system:
    - `on(event, callback)`: register listener
    - `off(event, callback)`: unregister listener
    - Emit events: `'sequenceChanged'`, `'membershipChanged'`, `'gcEvent'`
  - Implement methods:
    - `updateMembership(newView)` → install the coordinator's view (active members, evicted members with cutoffs, epoch); ignore a non-increasing epoch; then reject buffered ops that are now fenced and drain the buffer
    - `updateStableFrontier(frontier)` → trigger GC, emit event
    - `snapshot()` → Snapshot
    - `rejoinFromSnapshot(snapshot)` → void
  - **Acceptance Criteria**:
    - Events are fired in consistent order
    - Callbacks receive complete change information
    - Membership updates trigger epoch increment
    - GC triggers on frontier update
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-031, KER-022, KER-026
  - **Validation**: Unit test: listen to events → verify fired correctly; update membership → verify epoch increments

---

### Phase 4: Testing Infrastructure

- [ ] 35. **Deterministic Network Simulator** (KER-034)
  - Create `src/testing/deterministicNetwork.ts` with:
    - `DeterministicNetworkSimulator` class
    - Seed-based pseudo-random message ordering
    - Configurable delay, duplication, loss rates
    - `send(from, to, msg)`, `deliverNext()`, `deliverAll()`, `reset()`
  - Ensure reproducibility with same seed
  - **Acceptance Criteria**:
    - Same seed produces identical message sequences
    - No real timers or async
    - All randomness is seeded
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-002
  - **Validation**: Unit test: run simulator twice with same seed → verify identical sequences

- [ ] 36. **fast-check Arbitraries for CRDT Types** (KER-035)
  - Create `src/testing/arbitraries.ts` with generators for:
    - Operations (insert, delete with various anchors)
    - Multi-replica scenarios
    - Network scenarios (reordering, duplication)
    - Membership changes
    - GC scenarios
  - Provide shrinking strategies for minimal failing examples
  - **Acceptance Criteria**:
    - Arbitraries generate diverse, valid test cases
    - Shrinking produces small failing examples
    - Generators cover edge cases
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-003
  - **Validation**: Unit test: generate 100+ random cases → verify coverage of scenarios

- [ ] 37. **Test Fixtures and Helpers** (KER-036)
  - Create `src/testing/fixtures.ts` with:
    - Preset multi-replica scenarios (2, 3+ replicas)
    - Common operation sequences
    - Membership change helpers
    - State comparison utilities
  - **Acceptance Criteria**:
    - Fixtures set up common scenarios quickly
    - State comparison works for assertions
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-029
  - **Validation**: Use fixtures in integration tests (KER-070+)

- [ ] 38. **Test Data Builders and Factories** (KER-037)
  - Create helper functions to build:
    - Operations with specific properties (replicaId, seq, anchor, etc.)
    - RGA states with specific sequences
    - VVs with specific values
    - Snapshots with specific state
  - Reduce boilerplate in tests
  - **Acceptance Criteria**:
    - Builders are easy to use and composable
    - Built objects are valid and consistent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-004
  - **Validation**: Use builders in unit tests; verify reduced boilerplate

---

### Phase 5: Unit Tests

- [ ] 39. **RGA Unit Tests** (KER-038)
  - Test insert, delete, getSequence for all scenarios:
    - Empty RGA
    - Single element
    - Multiple concurrent inserts
    - Deletes and tombstones
    - Concurrent insert and delete
  - Verify Op ID ordering
  - Test buildOpIndex accuracy
  - **Acceptance Criteria**:
    - All RGA functions tested
    - Edge cases covered (empty, single, large sequences)
    - Coverage > 90%
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-010, KER-036
  - **Validation**: Run tests; verify coverage > 90%

- [ ] 40. **VersionVector Unit Tests** (KER-40)
  - Test createVV, cloneVV, mergeVV, advanceVV
  - Test partial order (isVVLessOrEqual)
  - Test contiguity enforcement
  - Test serialization/deserialization
  - **Acceptance Criteria**:
    - All VV functions tested
    - Partial order transitivity verified
    - Determinism verified
    - Coverage > 90%
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-014, KER-036
  - **Validation**: Run tests; verify coverage > 90%

- [ ] 41. **OpLog and Membership Unit Tests** (KER-41)
  - Test OpLog append, dedup, query
  - Test replay determinism
  - Test Membership create, update, eviction
  - Test epoch monotonicity
  - **Acceptance Criteria**:
    - All functions tested
    - Determinism verified
    - Coverage > 90%
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-016, KER-021, KER-036
  - **Validation**: Run tests; verify coverage > 90%

- [ ] 42. **GC and Snapshot Unit Tests** (KER-42)
  - Test Stage 1 GC payload reclamation
  - Test stable frontier computation
  - Test causal stability check
  - Test snapshot creation, serialization, rejoin
  - **Acceptance Criteria**:
    - All GC/snapshot functions tested
    - Payload reclamation verified
    - Rejoin correctness verified
    - Coverage > 90%
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-025, KER-027, KER-036
  - **Validation**: Run tests; verify coverage > 90%

- [ ] 43. **CRDT Class Unit Tests (Part 1: Basics)** (KER-43)
  - Test CRDT initialization
  - Test insert and delete operations
  - Test basic applyOp with simple scenarios
  - Test event emission
  - **Acceptance Criteria**:
    - Basic operations work correctly
    - Events are emitted consistently
    - State is consistent after each operation
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-032, KER-036
  - **Validation**: Run tests; verify state consistency

- [ ] 44. **CRDT Class Unit Tests (Part 2: Advanced)** (KER-44)
  - Test applyOp with out-of-order operations
  - Test dependency buffering and unblocking
  - Test duplicate suppression
  - Test author + cutoff fencing (evicted author at/below cutoff accepted, beyond cutoff rejected, `op.epoch` ignored)
  - Test no-op operations (concurrent duplicate delete) advance the VV and do not stall later ops
  - Test membership updates
  - **Acceptance Criteria**:
    - Out-of-order ops handled correctly
    - Buffering/unblocking works
    - Fencing prevents stale ops
    - Membership updates work
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-041, KER-032
  - **Validation**: Run tests; verify all scenarios

- [ ] 45. **Boundary and Edge Case Tests** (KER-45)
  - Test with empty sequences
  - Test with single elements
  - Test with large sequences (1000+ elements)
  - Test with many replicas (10+)
  - Test with rapid membership changes
  - **Acceptance Criteria**:
    - Edge cases handled gracefully
    - No crashes or unexpected errors
    - Performance acceptable (tests complete in reasonable time)
  - **Effort**: Medium
  - **Priority**: SHOULD
  - **Dependencies**: KER-041, KER-042
  - **Validation**: Run edge case tests; verify no crashes

- [ ] 46. **Error Recovery and Graceful Degradation** (KER-46)
  - Test handling of invalid inputs
  - Test behavior on network partition (buffering continues)
  - Test behavior on evicted replica
  - Verify no exceptions are thrown
  - **Acceptance Criteria**:
    - Invalid inputs handled gracefully
    - Partitioned replicas continue operating
    - No exceptions thrown
  - **Effort**: Small
  - **Priority**: SHOULD
  - **Dependencies**: KER-042
  - **Validation**: Run error tests; verify graceful handling

- [ ] 47. **Determinism Verification Tests** (KER-47)
  - Test that same seed produces identical results
  - Test serialization/deserialization round-trips
  - Test operation replay determinism
  - **Acceptance Criteria**:
    - Multiple runs with same seed are byte-identical
    - Round-trips recover original objects exactly
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-037, KER-038, KER-040
  - **Validation**: Run determinism tests; verify identical outputs

---

### Phase 6: Property-Based Tests (18 correctness properties)

- [ ] 48. **PBT - RGA Convergence (Property 1)** (KER-48)
  - Generate random operation sequences
  - Apply to multiple replicas in different orders
  - Verify final sequences are byte-identical
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Shrinking produces minimal failing examples
    - Coverage of edge cases (empty, concurrent)
    - Generators produce DEEP scenarios: anchor chains of depth ≥ 3 with concurrent siblings at more than one level, and inserts into the middle of existing sequences (shallow-only generators would not catch subtree-ordering bugs)
    - Checks subtree contiguity and that a local insert at visible index k lands at visible index k
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-041
  - **Validation**: Property test passes; shrinking works

- [ ] 49. **PBT - Op ID Uniqueness and Ordering (Property 2)** (KER-49)
  - Generate operations from multiple replicas
  - Verify no two ops share same Op ID
  - Verify Op ID ordering is transitive and consistent
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - All Op IDs unique
    - Ordering is consistent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-037
  - **Validation**: Property test passes

- [ ] 50. **PBT - Op ID Contiguity (Property 3)** (KER-50)
  - Generate operation sequences from single replica
  - Verify sequence numbers follow 1, 2, 3, … with no gaps
  - Verify no resets
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - All sequences are contiguous
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-037
  - **Validation**: Property test passes

- [ ] 51. **PBT - OpLog Deterministic Replay (Property 4)** (KER-51)
  - Generate random operations and log them
  - Replay log multiple times
  - Verify deterministic, identical results
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Multiple replays produce byte-identical state
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-040
  - **Validation**: Property test passes

- [ ] 52. **PBT - VV Partial Order Consistency (Property 5)** (KER-52)
  - Generate random VVs
  - Test A ≤ B and B ≤ C implies A ≤ C
  - Test merge computes component-wise max
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Transitivity verified for all cases
    - Merge is consistent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-038
  - **Validation**: Property test passes

- [ ] 53. **PBT - Contiguous Prefix Rule (Property 6)** (KER-53)
  - Generate out-of-order operation sequences
  - Verify VV only advances when prefix is contiguous
  - Verify gaps are detected
  - Include no-op operations (concurrent duplicate deletes): they advance the VV like any applied op
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Contiguity rule always maintained
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 54. **PBT - Missing Operation Recovery (Property 7)** (KER-54)
  - Generate operations arriving out of order
  - Verify all replicas eventually apply them correctly
  - Verify no deadlock or permanent gaps (including after concurrent duplicate deletes)
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Eventual delivery guaranteed
    - No out-of-order application
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-041
  - **Validation**: Property test passes; network simulator used

- [ ] 55. **PBT - Duplicate Suppression Idempotence (Property 8)** (KER-55)
  - Generate operations and apply k times (k ≥ 1)
  - Verify state identical to applying once
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Idempotence verified for all k
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 56. **PBT - Deterministic Network Reproducibility (Property 9)** (KER-56)
  - Run multi-replica scenario with seeded network
  - Run twice with same seed
  - Verify identical message sequences and final states
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Reproducibility guaranteed
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 57. **PBT - Membership Epoch Monotonicity (Property 10)** (KER-57)
  - Generate membership changes (join/evict)
  - Verify epoch increments exactly 1 per change
  - Verify epoch never decreases
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Monotonicity maintained
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-042
  - **Validation**: Property test passes

- [ ] 58. **PBT - Evicted-Author Fencing (Property 11)** (KER-58)
  - Generate edit operations from evicted and unknown authors, some at or below and some beyond the cutoff, with arbitrary `epoch` values
  - Verify all are rejected, not applied
  - Verify state and VV unchanged
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Ops beyond the cutoff (and ops from unknown authors) never applied; ops at or below the cutoff are applied; `epoch` has no effect
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-042
  - **Validation**: Property test passes

- [ ] 59. **PBT - Stable Frontier Monotonicity (Property 12)** (KER-59)
  - Generate VV acknowledgments and membership updates
  - Compute frontier for each step
  - Verify frontier advances monotonically
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Frontier never regresses
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-042
  - **Validation**: Property test passes

- [ ] 60. **PBT - Causally Stable Operation Identification (Property 13)** (KER-60)
  - Generate operations and compute frontier
  - Verify ops at/below frontier are stable
  - Verify all causal predecessors are also stable
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Causal stability correct
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-042
  - **Validation**: Property test passes

- [ ] 61. **PBT - Stage 1 GC Correctness (Property 14)** (KER-61)
  - Generate delete operations and frontier updates
  - Apply GC
  - Verify payload reclaimed but anchor remains
  - Verify sequence unchanged to application
  - Verify retained anchors still work
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - GC correctness verified
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-040
  - **Validation**: Property test passes

- [ ] 62. **PBT - Snapshot Fidelity (Property 15)** (KER-62)
  - Generate operation sequences
  - Take snapshot at random point
  - Apply post-snapshot ops through `applyOp` in various orders, with duplicates and with ops from authors evicted after the snapshot
  - Verify convergence with continuously-connected replica
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Snapshot fidelity verified
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-040
  - **Validation**: Property test passes; network simulator used

- [ ] 63. **PBT - Deterministic Operation Serialization (Property 16)** (KER-63)
  - Generate random operations and snapshots
  - Serialize to JSON
  - Deserialize
  - Verify round-trip recovers original exactly
  - Verify deterministic serialization (same key order)
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Serialization deterministic
    - Round-trip exact
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-040
  - **Validation**: Property test passes

- [ ] 64. **PBT - Event Callback Consistency (Property 17)** (KER-64)
  - Generate operation sequences
  - Register callbacks and verify fired in consistent order
  - Verify change information is complete and accurate
  - Verify no events lost or duplicated
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Event consistency verified
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 65. **PBT - API Method Consistency (Property 18)** (KER-65)
  - Generate operation sequences on two replicas with identical histories
  - Call getSequence, getVV, getMembershipView, getGCStats on both
  - Verify results are consistent and reflect same causal history
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - API method consistency verified
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

---

### Phase 7: Integration Tests

- [ ] 66. **Multi-Replica Convergence (2 replicas)** (KER-66)
  - Set up 2 CRDT replicas with deterministic network
  - Generate random insert/delete operations on both
  - Deliver messages in various orders (deterministic, seeded)
  - Verify both converge to identical final state
  - **Acceptance Criteria**:
    - Test runs with deterministic seeding
    - Convergence verified under various message orders
    - 10+ test cases with different operation patterns
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-035
  - **Validation**: Integration test passes; verify convergence in all cases

- [ ] 67. **Multi-Replica Convergence (3+ replicas)** (KER-67)
  - Extend to 3 or more replicas
  - Test with varying network delays/reordering
  - Verify all replicas converge identically
  - **Acceptance Criteria**:
    - Works with 3, 5, 10+ replicas
    - Convergence verified for all
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-064
  - **Validation**: Integration test passes

- [ ] 68. **Snapshot + Rejoin Scenario** (KER-68)
  - Set up 3 replicas with operations
  - Take snapshot at Replica 1
  - Simulate new Replica 2 joining via snapshot
  - Send post-snapshot operations
  - Verify Replica 2 converges to same state as others
  - **Acceptance Criteria**:
    - Snapshot rejoin works correctly
    - Convergence verified
    - Multiple snapshot/rejoin cycles work
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-035, KER-040
  - **Validation**: Integration test passes

- [ ] 69. **Membership Change and Eviction Scenario** (KER-69)
  - Set up 3 replicas
  - Generate operations
  - Evict one replica (trigger membership change, epoch increment)
  - Verify:
    - Evicted replica's new ops (beyond the cutoff) are rejected
    - Eviction is two-phase: it stays pending until every survivor has backfilled the target's ops up to the cutoff and sent `evict-confirm`; a survivor missing some ops holds the stable frontier back until it catches up
    - Stable frontier advances (no longer blocked)
    - Remaining replicas continue converging
  - **Acceptance Criteria**:
    - Eviction works correctly
    - Frontier unblocks
    - Fencing prevents stale ops
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-035, KER-042
  - **Validation**: Integration test passes

- [ ] 70. **End-to-End Scenario (Combined)** (KER-70)
  - Combine:
    - Multiple replicas (3+)
    - Random insert/delete operations
    - Out-of-order message delivery
    - Membership changes and evictions
    - Snapshot + rejoin
    - GC and frontier updates
  - Verify convergence and consistency throughout
  - **Acceptance Criteria**:
    - Complex scenario handles all features together
    - Final state is consistent
    - No crashes or data loss
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-066, KER-067
  - **Validation**: Integration test passes; all checks pass

---

### Phase 8: Documentation

- [ ] 71. **API Documentation and JSDoc** (KER-71)
  - Add comprehensive JSDoc comments to all public methods
  - Document parameters, return types, side effects, exceptions (none expected)
  - Add examples for major APIs (insert, delete, getSequence, snapshot)
  - Document correctness properties and guarantees
  - **Acceptance Criteria**:
    - All public methods documented
    - Examples are correct and runnable
    - No missing parameter docs
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-032
  - **Validation**: Generate API docs; verify completeness

- [ ] 72. **Architecture README** (KER-72)
  - Document:
    - Module structure and interactions
    - Data models and invariants
    - Key algorithms (RGA, VV, GC, snapshot)
    - Correctness properties
    - Testing strategy
    - Integration points with applications
  - Include diagrams (ASCII)
  - **Acceptance Criteria**:
    - README covers all core concepts
    - Suitable for developers integrating the kernel
    - Examples included
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: All modules complete
  - **Validation**: Review README for clarity and completeness

- [ ] 73. **Design Rationale and Limitations Document** (KER-73)
  - Document:
    - Why RGA and not other CRDTs
    - Why contiguous VVs
    - Why per-replica op logs
    - Why Stage 1 GC (not Stage 2)
    - Why single coordinator
  - Known limitations (no Stage 2 GC, no sharding, etc.)
  - Future work (Raft-based coordinator, etc.)
  - **Acceptance Criteria**:
    - All design choices explained
    - Limitations clearly stated
    - Honest about scope
  - **Effort**: Small
  - **Priority**: SHOULD
  - **Dependencies**: KER-070
  - **Validation**: Review for accuracy and completeness

- [ ] 74. **Integration Guide for Applications** (KER-74)
  - Document:
    - How to initialize CRDT
    - How to create and apply operations
    - How to listen for events
    - How to take/load snapshots
    - How to handle membership changes and eviction
  - Provide code examples for each pattern
  - Cover error handling and edge cases
  - **Acceptance Criteria**:
    - Guide covers all major APIs
    - Examples are correct
    - Suitable for app developers
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-070
  - **Validation**: Use guide to implement applications

---

### Phase 9: Transport Layer and Coordinator Service

- [ ] 75. **BroadcastChannel Transport (Multi-Tab Demo) [SHOULD]** (KER-75)
  - Create transport layer using BroadcastChannel API
  - Serialize/broadcast operations between tabs
  - Listen for and apply remote operations
  - Handle membership updates from coordinator
  - **Acceptance Criteria**:
    - Operations broadcast between tabs
    - Remote ops applied correctly
    - Convergence verified across tabs
  - **Effort**: Medium
  - **Priority**: SHOULD
  - **Dependencies**: KER-032, KER-072
  - **Validation**: Multi-tab test; verify operations sync

- [ ] 76. **IndexedDB Persistence [SHOULD]** (KER-76)
  - Implement persistence layer:
    - Save/load CRDT state from IndexedDB
    - Store operation log
    - Store snapshots
  - On page reload, restore from IndexedDB
  - **Acceptance Criteria**:
    - State persists across page reloads
    - Performance acceptable (< 100ms load)
  - **Effort**: Medium
  - **Priority**: SHOULD
  - **Dependencies**: KER-032
  - **Validation**: Test: save → reload → verify state

- [ ] 77. **Coordinator Service (Node.js) [MUST]** (KER-77)
  - Create Node.js coordinator service:
    - Collect VV acknowledgments from replicas
    - Compute stable frontier
    - Broadcast frontier updates to replicas
    - Track stalled/zombie peers in Graveyard panel (detection only, no automatic timeout-based eviction)
    - Provide manual eviction via "Exorcise" UI action — only operator can trigger eviction
    - Run the two-phase eviction protocol (requirements.md §10.3, design.md "Eviction Protocol"): `evict-prepare` → cutoff = max(replies) → publish membership (pending) → survivors backfill and send `evict-confirm` → complete only when ALL survivors confirmed. Re-send backfill requests while pending; list non-confirming members as stalled for a MANUAL Exorcise (never evict automatically). Retries/timers live here, not in the kernel
    - Reject control messages (acks, sync requests) from non-active or stale-epoch senders with the current epoch
    - Broadcast membership updates when eviction is triggered
  - Simple HTTP or WebSocket API
  - **Acceptance Criteria**:
    - Coordinator computes frontier correctly
    - Membership changes work (manual eviction only)
    - Graveyard panel displays stalled peers
    - Broadcast mechanism works
    - No automatic timeout-based eviction in kernel
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-032, KER-042
  - **Validation**: Integration test with coordinator; verify manual eviction via UI; verify no auto-eviction timeout

- [ ] 78. **WebRTC Transport [STRETCH]** (KER-78)
  - Implement WebRTC-based transport layer
  - Support peer-to-peer operation exchange
  - Handle connection lifecycle
  - **Acceptance Criteria**:
    - P2P operations sync over WebRTC
    - Convergence verified
  - **Effort**: Large
  - **Priority**: STRETCH
  - **Dependencies**: KER-032
  - **Validation**: Multi-peer test; verify operations sync

---

### Phase 10: Applications (Outside Kernel Scope, but Required)

- [ ] 79. **Graveyard Whiteboard Implementation [MUST]** (KER-79)
  - React app for collaborative drawing
  - Use CRDT kernel for state management
  - Display operations as strokes
  - Show graveyard panel (tombstones, anchors, frontier)
  - **Acceptance Criteria**:
    - Draw operations sync across tabs/replicas
    - Graveyard panel shows kernel state
    - UI responsive and polished
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-073
  - **Validation**: Visual testing; draw → verify sync

- [ ] 80. **Cursed Checklist Implementation [MUST]** (KER-80)
  - React app for collaborative to-do list
  - Use CRDT kernel for state management
  - Show checklist items with collaborative editing
  - Show membership and frontier status
  - **Acceptance Criteria**:
    - Checklist items sync across replicas
    - Collaborative editing works
    - UI responsive and polished
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-073
  - **Validation**: Visual testing; edit → verify sync

---

## Testing Metrics and Coverage Goals

| Metric | Target | Notes |
|--------|--------|-------|
| Unit Test Coverage (Core) | > 85% | RGA, VV, OpLog, Membership, GC, Snapshot |
| Branch Coverage | > 80% | Control flow must be exercised |
| Property-Based Test Iterations | ≥ 100 per property | 18 properties total |
| Integration Test Scenarios | ≥ 10 multi-replica combinations | 2+, 3+, 5+ replicas |
| E2E Test Coverage | ≥ 5 realistic workflows | Snapshot, eviction, convergence, GC, API |
| Determinism Verification | 100% | Same seed = byte-identical results |
| No Crashes on Invalid Input | 100% | Graceful degradation |

---

## Dependency Graph and Execution Waves

All tasks must respect these dependencies:
- KER-004, KER-005 must complete before any module work
- KER-002, KER-003 must complete before testing work
- All core modules (KER-006 to KER-028) must complete before orchestrator (KER-029)
- Orchestrator must complete before unit tests (KER-037+) and integration tests (KER-064+)
- Property-based tests require testing infrastructure (KER-033 to KER-036)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["KER-001", "KER-002", "KER-003", "KER-004", "KER-005"] },
    { "id": 1, "tasks": ["KER-006", "KER-011", "KER-015", "KER-018", "KER-023", "KER-027"] },
    { "id": 2, "tasks": ["KER-007", "KER-012", "KER-016", "KER-019", "KER-024", "KER-028"] },
    { "id": 3, "tasks": ["KER-008", "KER-013", "KER-017", "KER-020", "KER-025"] },
    { "id": 4, "tasks": ["KER-009", "KER-010", "KER-014", "KER-021", "KER-022", "KER-026"] },
    { "id": 5, "tasks": ["KER-029", "KER-034", "KER-035", "KER-036", "KER-037"] },
    { "id": 6, "tasks": ["KER-030", "KER-031", "KER-032", "KER-033"] },
    { "id": 7, "tasks": ["KER-038", "KER-039", "KER-040", "KER-041", "KER-042", "KER-043", "KER-044", "KER-045", "KER-046"] },
    { "id": 8, "tasks": ["KER-047", "KER-048", "KER-049", "KER-050", "KER-051", "KER-052", "KER-053", "KER-054", "KER-055", "KER-056", "KER-057", "KER-058", "KER-059", "KER-060", "KER-061", "KER-062", "KER-063", "KER-064"] },
    { "id": 9, "tasks": ["KER-065", "KER-066", "KER-067", "KER-068", "KER-069"] },
    { "id": 10, "tasks": ["KER-070", "KER-071", "KER-072", "KER-073"] },
    { "id": 11, "tasks": ["KER-074", "KER-075", "KER-076", "KER-077"] },
    { "id": 12, "tasks": ["KER-078", "KER-079", "KER-080"] }
  ]
}
```

## Notes

- **Parallelization**: Waves 1–4 can run in parallel once wave 0 completes (all core modules can be built simultaneously)
- **Critical Path**: Setup → Core Modules → Orchestrator → Testing/Documentation → Transport/Apps
- **Testing as You Go**: Begin unit tests (KER-038+) once individual modules complete (don't wait for all modules)
- **Property Tests Depend on Network Sim**: KER-034 must complete before PBT (KER-047+) can fully run
- **Documentation is Parallel**: KER-070 to KER-073 can start once design is final (doesn't block implementation)
- **Priority**: MUST tasks (core kernel) are never cut; optional cuts in order: WebRTC (KER-078) → Coordinator (KER-077) → BroadcastChannel (KER-074) → IndexedDB (KER-075)
- **BroadcastChannel (KER-074)** is a DECIDED Should-have for multi-tab sync demo; do not cut before Transport layer is demonstrated
- **Spec corrections applied (correctness review)**: RGA is an anchor tree with iterative DFS (KER-006 to KER-009); no-op ops are applied ops that advance the VV (KER-031); buffer unblocking is an iterative queue (KER-031); two separate fencing mechanisms (KER-020); two-phase eviction with a confirm barrier (KER-077); snapshot rejoin goes through `applyOp` (KER-029/033). Source of truth for names and types: `kernel/src/types.ts` and `.kiro/steering/tech.md`
- **Graveyard Panel** (visual in KER-079 and KER-080) is the centerpiece of the Design criterion; prioritize its implementation and UX polish

## Acceptance and Sign-Off

Each task must satisfy:
1. **Code written** with inline comments explaining complex logic
2. **Tests pass** (unit, property, or integration as appropriate)
3. **Code coverage** meets targets (85% for core, 80% branch)
4. **Determinism verified** with seeding (same seed = same output)
5. **No exceptions thrown** (graceful error handling)
6. **Documented** with JSDoc and README updates

Upon completion of all MUST tasks, the kernel is feature-complete and ready for applications to build on top.











