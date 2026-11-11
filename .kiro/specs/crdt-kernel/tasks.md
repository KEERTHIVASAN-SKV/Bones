# Implementation Plan: CRDT Kernel

## Overview

This implementation plan breaks down the CRDT Kernel design into discrete, actionable tasks organized into 10 major groups: project setup, core modules, orchestrator, testing infrastructure, unit tests, property-based tests, integration tests, documentation, transport layer, and coordinator service. Tasks are prioritized as MUST (core functionality), SHOULD (enhancements), or STRETCH (advanced goals). Each task includes effort estimates, dependencies, acceptance criteria, and validation strategies.

**Target Completion**: Dec 3, 2026 (before Kiroween Dec 4 deadline)

---

## Task Groups and Dependencies

```
Setup (KER-001 to KER-005)
  ↓
Core Modules (KER-006 to KER-040)
  ├→ RGA Module (KER-006 to KER-010)
  ├→ VV Module (KER-011 to KER-014)
  ├→ OpLog Module (KER-015 to KER-017)
  ├→ Membership Module (KER-018 to KER-021)
  ├→ GC Module (KER-022 to KER-025)
  └→ Snapshot Module (KER-026 to KER-028)
  ↓
Orchestrator (KER-029 to KER-032)
  ↓
Testing Infrastructure (KER-033 to KER-036)
  ↓
Unit Tests (KER-037 to KER-051)
  ↓
Property-Based Tests (KER-052 to KER-069)
  ↓
Integration Tests (KER-070 to KER-074)
  ↓
Documentation (KER-075 to KER-078)
  ↓
Transport & Coordinator (KER-079 to KER-085)
  ↓
Applications (outside kernel scope)
```

---

## Tasks

### Phase 1: Project Setup

- [ ] 1. **Repository Structure and TypeScript Configuration** (KER-001)
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

- [ ] 2. **Test Framework Setup (Vitest)** (KER-002)
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

- [ ] 4. **Shared Types and Interfaces** (KER-004)
  - Create `src/types.ts` with all core interfaces:
    - `OpId`, `Element<T>`, `Operation<T>`, `VersionVector`, `MembershipView`, `Snapshot<T>`, `OperationBuffer`
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

- [ ] 5. **Utility Functions and Helpers** (KER-005)
  - Create `src/utils.ts` with helpers:
    - `compareOpIds(a, b)`: lexicographic comparison
    - `opId(op)`: extract Op ID from Operation
    - `serializeOp(op)`: deterministic JSON serialization
    - `deserializeOp(json)`: parse operation
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

- [ ] 6. **RGA Data Structure and Core Insert Logic** (KER-006)
  - Create `src/rga.ts` with:
    - RGA state (array of Elements with Op IDs)
    - `insert(anchorId, value)` function: create insert operation
    - `applyInsert(rga, op)` function: apply insert to RGA
    - Op ID ordering for deterministic conflict resolution
    - Anchor resolution logic (undefined = HEAD)
  - Ensure deterministic ordering for concurrent inserts
  - **Acceptance Criteria**:
    - Insert returns Operation with correct Op ID
    - Concurrent inserts to same anchor order by Op ID consistently
    - Inserted element appears in correct position
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-004, KER-005
  - **Validation**: Unit test: insert at various anchors; verify position matches Op ID sort order

- [ ] 7. **RGA Delete Logic and Tombstones** (KER-007)
  - Implement `delete_(elementId, replicaId)` function: create delete operation
  - Implement `applyDelete(rga, op)` function: mark element as deleted (tombstone)
  - Track deletion with `deletedAt` Op ID
  - Ensure tombstones are retained for structural integrity
  - **Acceptance Criteria**:
    - Delete marks element as deleted without removing it
    - Deleted elements remain as structural anchors
    - Re-deleting same element is idempotent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-006
  - **Validation**: Unit test: delete → verify tombstone; verify anchor still works

- [ ] 8. **RGA Sequence Traversal and Querying** (KER-008)
  - Implement `getSequence(rga)` function: return only non-deleted elements
  - Implement `isElementDeleted(rga, elementId)` function: check deletion status
  - Implement `buildOpIndex(rga)` function: create map for quick lookups
  - Support efficient anchor resolution and position queries
  - **Acceptance Criteria**:
    - `getSequence()` returns only visible elements in correct order
    - `isElementDeleted()` correctly identifies tombstones
    - OpIndex is accurate and consistent
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-007
  - **Validation**: Unit test: mixed insert/delete; verify sequence and index consistency

- [ ] 9. **RGA Concurrent Insert Ordering** (KER-009)
  - Implement deterministic ordering for concurrent inserts targeting same anchor
  - Use Op ID (replicaId + seq) for consistent tie-breaking
  - Test that two replicas applying same concurrent inserts produce identical order
  - **Acceptance Criteria**:
    - Same set of concurrent inserts always order the same way
    - Order is deterministic across all replicas
    - Property test: any permutation of concurrent inserts converges
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-006, KER-008
  - **Validation**: Unit test: 2+ concurrent inserts → verify Op ID sort order; PBT: random insertion order → same final sequence

- [ ] 10. **RGA Payload Reclamation Preparation** (KER-010)
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

- [ ] 11. **VersionVector Operations (Create, Clone, Query)** (KER-011)
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

- [ ] 13. **Contiguous Prefix Rule Enforcement** (KER-013)
  - Implement `updateVVWithContiguousPrefix(currentVV, replicaId, seq)` function
  - Only advance VV entry if all ops 1..seq are contiguous
  - Detect gaps and prevent advancing
  - **Acceptance Criteria**:
    - VV only advances when gap is closed
    - Gaps are detected correctly
    - VV entry is accurate (never exceeds contiguous prefix)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011
  - **Validation**: Unit test: apply ops out of order → verify VV stalls; then fill gap → verify VV advances

- [ ] 14. **VersionVector Serialization and Cloning** (KER-014)
  - Implement deterministic serialization (JSON with sorted keys)
  - Implement deep cloning for safety
  - Test round-trip (serialize → deserialize = original)
  - **Acceptance Criteria**:
    - Serialization is deterministic (same VV always serializes same)
    - Deserialization recovers original VV exactly
    - Clones are independent (mutating clone doesn't affect original)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-011
  - **Validation**: Unit test serialization; PBT: random VVs → serialize/deserialize → identical

#### OpLog Module

- [ ] 15. **Operation Log Append and Storage** (KER-015)
  - Create `src/oplog.ts` with:
    - `appendOp(log, op)` function: append operation to log
    - `getAllOps(log)` function: return all ops in order
    - `getOpsByReplica(log, replicaId)` function: filter by replica
    - Maintain log as append-only (no mutations)
  - Ensure deterministic ordering (log order matches application order)
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
    - `MembershipView` struct (activeReplicas set, epoch number)
    - `createMembership(activeReplicas)` function: initialize at epoch 0
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
  - Implement `removeReplica(membership, replicaId)` function: evict replica, increment epoch
  - Track eviction date and reason (for diagnostics)
  - **Acceptance Criteria**:
    - Adding/removing replica increments epoch by 1
    - Replica ID added/removed from activeReplicas set
    - Epoch is monotonic (never decreases)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-018
  - **Validation**: Unit test: add/remove → verify epoch and membership

- [ ] 20. **Stale-Epoch Operation Filtering** (KER-020)
  - Implement `isOpStaleEpoch(op, currentEpoch)` function: check if op is from stale epoch
  - Implement `isReplicaActive(replicaId, membership)` function: check membership
  - Return fencing decision (reject vs. accept)
  - **Acceptance Criteria**:
    - Ops from epoch < current are marked stale
    - Ops from evicted replicas are marked stale
    - Fencing is transparent (no error, just rejection)
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-019
  - **Validation**: Unit test: stale op → verify rejected; current epoch op → verify accepted

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

#### Garbage Collector Module

- [ ] 22. **Stage 1 GC Logic (Payload Reclamation)** (KER-022)
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

- [ ] 23. **Stable Frontier Computation** (KER-023)
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

- [ ] 24. **Causally Stable Operation Identification** (KER-024)
  - Implement `isCausallyStable(opId, stableFrontier)` function: check if op ≤ frontier
  - **Acceptance Criteria**:
    - Op at or below frontier is stable
    - Op above frontier is not stable
    - Result is deterministic
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-023
  - **Validation**: Unit test: op at various positions relative to frontier

- [ ] 25. **GC Statistics and Diagnostics** (KER-025)
  - Implement `getGCStats(rga)` function: return:
    - `bytesReclaimed`: total bytes cleared via GC
    - `tombstonesRetained`: count of retained anchors
    - `reclaimableOps`: count of ops safe to reclaim (current frontier)
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

- [ ] 26. **Snapshot Creation** (KER-026)
  - Create `src/snapshot.ts` with:
    - `createSnapshot(rga, vv, membership, gcStats)` function
    - Include deep copies of sequence, VV, membership
    - Add metadata (creator, timestamp, GC state)
    - Ensure no shared mutable references
  - **Acceptance Criteria**:
    - Snapshot includes all state needed to bootstrap
    - Deep copies prevent external mutation
    - Metadata is recorded
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-010, KER-011, KER-018, KER-025
  - **Validation**: Unit test: create snapshot → verify all fields present; mutate original → verify snapshot unchanged

- [ ] 27. **Snapshot Serialization** (KER-027)
  - Implement `serializeSnapshot(snapshot)` function: JSON serialization with sorted keys
  - Implement `deserializeSnapshot(json)` function: parse and reconstruct
  - Ensure deterministic serialization
  - **Acceptance Criteria**:
    - Serialization is deterministic
    - Round-trip recovers original snapshot
    - Suitable for storage/transmission
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-026
  - **Validation**: Unit test: serialize → deserialize → verify identical

- [ ] 28. **Snapshot Rejoin and State Recovery** (KER-028)
  - Implement `rejoinFromSnapshot(snapshot, postSnapshotOps)` function
  - Initialize RGA, VV, membership from snapshot
  - Apply post-snapshot ops with deduplication and causal ordering
  - Verify convergence with continuously-connected replica
  - **Acceptance Criteria**:
    - Rejoined replica state matches continuously-connected replica
    - Post-snapshot ops applied in correct order
    - Deduplication prevents duplicate application
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-026, KER-006
  - **Validation**: Unit test: snapshot + rejoin → verify state matches original; PBT: random post-ops order → same final state

---

### Phase 3: CRDT Orchestrator

- [ ] 29. **CRDT Class Initialization and State Management** (KER-029)
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

- [ ] 30. **CRDT Core API (insert, delete, applyOp)** (KER-030)
  - Implement public methods:
    - `insert(anchorId, value)` → Operation
    - `delete(elementId)` → Operation
    - `applyOp(op)` → void (with dependency buffering)
  - Handle duplicate suppression, fencing, buffering
  - Update VV, OpLog, emit events
  - **Acceptance Criteria**:
    - Insert/delete create operations and update state
    - applyOp handles out-of-order ops with buffering
    - Duplicates are suppressed
    - Stale ops are rejected
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-006, KER-007, KER-013, KER-020
  - **Validation**: Unit test: insert/delete/applyOp with various scenarios; verify state consistency

- [ ] 31. **CRDT Query Methods** (KER-031)
  - Implement public methods:
    - `getSequence()` → Element[]
    - `getVV()` → VersionVector
    - `getMembershipView()` → MembershipView
    - `isElementDeleted(elementId)` → boolean
    - `isCausallyStable(opId)` → boolean
    - `getStableFrontier()` → VersionVector
    - `getGCStats()` → { bytesReclaimed, tombstonesRetained, reclaimableOps }
  - All methods are read-only, non-mutating
  - **Acceptance Criteria**:
    - All query methods return correct values
    - No mutation side effects
    - Results are consistent with state
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-030
  - **Validation**: Unit test: insert/delete → query → verify accuracy

- [ ] 32. **CRDT Events and Membership Updates** (KER-032)
  - Implement event system:
    - `on(event, callback)`: register listener
    - `off(event, callback)`: unregister listener
    - Emit events: `'sequenceChanged'`, `'membershipChanged'`, `'gcEvent'`
  - Implement methods:
    - `updateMembership(activeReplicas)` → increment epoch if changed
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

- [ ] 33. **Deterministic Network Simulator** (KER-033)
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

- [ ] 34. **fast-check Arbitraries for CRDT Types** (KER-034)
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

- [ ] 35. **Test Fixtures and Helpers** (KER-035)
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

- [ ] 36. **Test Data Builders and Factories** (KER-036)
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

- [ ] 37. **RGA Unit Tests** (KER-037)
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

- [ ] 38. **VersionVector Unit Tests** (KER-038)
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

- [ ] 39. **OpLog and Membership Unit Tests** (KER-039)
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

- [ ] 40. **GC and Snapshot Unit Tests** (KER-040)
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

- [ ] 41. **CRDT Class Unit Tests (Part 1: Basics)** (KER-041)
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

- [ ] 42. **CRDT Class Unit Tests (Part 2: Advanced)** (KER-042)
  - Test applyOp with out-of-order operations
  - Test dependency buffering and unblocking
  - Test duplicate suppression
  - Test stale epoch fencing
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

- [ ] 43. **Boundary and Edge Case Tests** (KER-043)
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

- [ ] 44. **Error Recovery and Graceful Degradation** (KER-044)
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

- [ ] 45. **Determinism Verification Tests** (KER-045)
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

- [ ] 46. **PBT - RGA Convergence (Property 1)** (KER-046)
  - Generate random operation sequences
  - Apply to multiple replicas in different orders
  - Verify final sequences are byte-identical
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Shrinking produces minimal failing examples
    - Coverage of edge cases (empty, concurrent)
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-041
  - **Validation**: Property test passes; shrinking works

- [ ] 47. **PBT - Op ID Uniqueness and Ordering (Property 2)** (KER-047)
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

- [ ] 48. **PBT - Op ID Contiguity (Property 3)** (KER-048)
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

- [ ] 49. **PBT - OpLog Deterministic Replay (Property 4)** (KER-049)
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

- [ ] 50. **PBT - VV Partial Order Consistency (Property 5)** (KER-050)
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

- [ ] 51. **PBT - Contiguous Prefix Rule (Property 6)** (KER-051)
  - Generate out-of-order operation sequences
  - Verify VV only advances when prefix is contiguous
  - Verify gaps are detected
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Contiguity rule always maintained
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 52. **PBT - Missing Operation Recovery (Property 7)** (KER-052)
  - Generate operations arriving out of order
  - Verify all replicas eventually apply them correctly
  - Verify no deadlock or permanent gaps
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Eventual delivery guaranteed
    - No out-of-order application
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-041
  - **Validation**: Property test passes; network simulator used

- [ ] 53. **PBT - Duplicate Suppression Idempotence (Property 8)** (KER-053)
  - Generate operations and apply k times (k ≥ 1)
  - Verify state identical to applying once
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Idempotence verified for all k
  - **Effort**: Small
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-041
  - **Validation**: Property test passes

- [ ] 54. **PBT - Deterministic Network Reproducibility (Property 9)** (KER-054)
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

- [ ] 55. **PBT - Membership Epoch Monotonicity (Property 10)** (KER-055)
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

- [ ] 56. **PBT - Stale-Epoch Fencing (Property 11)** (KER-056)
  - Generate operations from stale-epoch replicas
  - Verify all are rejected, not applied
  - Verify state and VV unchanged
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Stale ops never applied
  - **Effort**: Medium
  - **Priority**: MUST
  - **Dependencies**: KER-034, KER-042
  - **Validation**: Property test passes

- [ ] 57. **PBT - Stable Frontier Monotonicity (Property 12)** (KER-057)
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

- [ ] 58. **PBT - Causally Stable Operation Identification (Property 13)** (KER-058)
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

- [ ] 59. **PBT - Stage 1 GC Correctness (Property 14)** (KER-059)
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

- [ ] 60. **PBT - Snapshot Fidelity (Property 15)** (KER-060)
  - Generate operation sequences
  - Take snapshot at random point
  - Apply post-snapshot ops in various orders
  - Verify convergence with continuously-connected replica
  - **Acceptance Criteria**:
    - 100+ iterations pass
    - Snapshot fidelity verified
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-033, KER-034, KER-040
  - **Validation**: Property test passes; network simulator used

- [ ] 61. **PBT - Deterministic Operation Serialization (Property 16)** (KER-061)
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

- [ ] 62. **PBT - Event Callback Consistency (Property 17)** (KER-062)
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

- [ ] 63. **PBT - API Method Consistency (Property 18)** (KER-063)
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

- [ ] 64. **Multi-Replica Convergence (2 replicas)** (KER-064)
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

- [ ] 65. **Multi-Replica Convergence (3+ replicas)** (KER-065)
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

- [ ] 66. **Snapshot + Rejoin Scenario** (KER-066)
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

- [ ] 67. **Membership Change and Eviction Scenario** (KER-067)
  - Set up 3 replicas
  - Generate operations
  - Evict one replica (trigger membership change, epoch increment)
  - Verify:
    - Evicted replica's new ops are rejected
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

- [ ] 68. **End-to-End Scenario (Combined)** (KER-068)
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

- [ ] 69. **API Documentation and JSDoc** (KER-069)
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

- [ ] 70. **Architecture README** (KER-070)
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

- [ ] 71. **Design Rationale and Limitations Document** (KER-071)
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

- [ ] 72. **Integration Guide for Applications** (KER-072)
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

- [ ] 73. **BroadcastChannel Transport (Multi-Tab Demo) [SHOULD]** (KER-073)
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

- [ ] 74. **IndexedDB Persistence [SHOULD]** (KER-074)
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

- [ ] 75. **Coordinator Service (Node.js) [MUST]** (KER-075)
  - Create Node.js coordinator service:
    - Collect VV acknowledgments from replicas
    - Compute stable frontier
    - Broadcast frontier updates to replicas
    - Detect and evict zombie peers (timeout-based)
    - Broadcast membership updates
  - Simple HTTP or WebSocket API
  - **Acceptance Criteria**:
    - Coordinator computes frontier correctly
    - Membership changes work
    - Eviction timeout enforced
    - Broadcast mechanism works
  - **Effort**: Large
  - **Priority**: MUST
  - **Dependencies**: KER-032, KER-042
  - **Validation**: Integration test with coordinator

- [ ] 76. **WebRTC Transport [STRETCH]** (KER-076)
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

- [ ] 77. **Graveyard Whiteboard Implementation [MUST]** (KER-077)
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

- [ ] 78. **Cursed Checklist Implementation [MUST]** (KER-078)
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
    { "id": 1, "tasks": ["KER-006", "KER-011", "KER-015", "KER-018", "KER-022", "KER-026"] },
    { "id": 2, "tasks": ["KER-007", "KER-012", "KER-016", "KER-019", "KER-023", "KER-027"] },
    { "id": 3, "tasks": ["KER-008", "KER-013", "KER-017", "KER-020", "KER-024", "KER-028"] },
    { "id": 4, "tasks": ["KER-009", "KER-010", "KER-014", "KER-021", "KER-025"] },
    { "id": 5, "tasks": ["KER-029", "KER-033", "KER-034", "KER-035", "KER-036"] },
    { "id": 6, "tasks": ["KER-030", "KER-031", "KER-032"] },
    { "id": 7, "tasks": ["KER-037", "KER-038", "KER-039", "KER-040", "KER-041", "KER-042", "KER-043", "KER-044", "KER-045"] },
    { "id": 8, "tasks": ["KER-046", "KER-047", "KER-048", "KER-049", "KER-050", "KER-051", "KER-052", "KER-053", "KER-054", "KER-055", "KER-056", "KER-057", "KER-058", "KER-059", "KER-060", "KER-061", "KER-062", "KER-063"] },
    { "id": 9, "tasks": ["KER-064", "KER-065", "KER-066", "KER-067", "KER-068"] },
    { "id": 10, "tasks": ["KER-069", "KER-070", "KER-071", "KER-072"] },
    { "id": 11, "tasks": ["KER-073", "KER-074", "KER-075"] },
    { "id": 12, "tasks": ["KER-076"] }
  ]
}
```

## Notes

- **Parallelization**: Waves 1-4 can run in parallel once wave 0 completes (all core modules can be built simultaneously)
- **Critical Path**: Setup → Core Modules → Orchestrator → Testing/Documentation → Transport/Apps
- **Testing as You Go**: Begin unit tests (KER-037+) once individual modules complete (don't wait for all modules)
- **Property Tests Depend on Network Sim**: KER-033 must complete before PBT (KER-046+) can fully run
- **Documentation is Parallel**: KER-069 to KER-072 can start once design is final (doesn't block implementation)
- **Optional/SHOULD/STRETCH**: KER-043, KER-044, KER-071, KER-073, KER-074, KER-076 can be deferred if time is tight
- **Order if Behind**: Cut in order: WebRTC (KER-076) → IndexedDB (KER-074) → BroadcastChannel stretch (not in scope) → UI polish

## Acceptance and Sign-Off

Each task must satisfy:
1. **Code written** with inline comments explaining complex logic
2. **Tests pass** (unit, property, or integration as appropriate)
3. **Code coverage** meets targets (85% for core, 80% branch)
4. **Determinism verified** with seeding (same seed = same output)
5. **No exceptions thrown** (graceful error handling)
6. **Documented** with JSDoc and README updates

Upon completion of all MUST tasks, the kernel is feature-complete and ready for applications to build on top.

