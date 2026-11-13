# Requirements Document

# CRDT Kernel Requirements

## Introduction

The CRDT Kernel is a small, educational, from-scratch implementation of a Conflict-free Replicated Data Type (CRDT) for offline-first collaborative applications. It implements a Replicated Growable Array (RGA) sequence CRDT with causal stability tracking, safe tombstone reclamation, and explicit membership management through epochs. The kernel is deterministic, pure, and thoroughly tested with property-based tests. It serves as the foundation for two applications: Graveyard Whiteboard (collaborative drawing) and Cursed Checklist (shared to-do list).

**Project Context**: Bones hackathon project (Kiroween 2026, Skeleton Crew category)

**Stack**: TypeScript, Vitest (unit tests), fast-check (property-based tests)

**Key Constraint**: Keep the kernel pure and deterministic—no `Date.now()`, `Math.random()`, DOM, network, or storage inside `/kernel`.

---

## Glossary

- **Replica**: One independent copy of the document (e.g., one browser tab, one Node.js process).
- **Replica ID**: Unique identifier of one replica incarnation. **[PROPOSED]** Format: `${siteId}.${incarnation}`.
- **Incarnation**: A replica that is evicted and returns later is a new incarnation with a new Replica ID. **[DECIDED]**
- **Operation (Op)**: An insert or delete, created at one replica and sent to others.
- **Op ID**: `(replica, seq)`; `seq` counts that replica's ops 1, 2, 3, … with no gaps.
- **RGA**: Replicated Growable Array, the sequence CRDT used. **[DECIDED]**
- **Anchor**: The existing element an insert is placed after (or `HEAD`).
- **Tombstone**: A deleted element retained (invisible to user) so concurrent operations can still be placed.
- **Version Vector (VV)**: Map from replica to the highest **contiguous** op `seq` applied from it. **[DECIDED]** Must track contiguous prefix, not "largest seen".
- **Ack**: A replica reporting its VV to the coordinator.
- **Stable Frontier**: Component-wise **minimum** of the acknowledged VVs of all **active** members in the current membership view.
- **Causal Stability**: An op is causally stable when it is at or below the stable frontier.
- **Stage 1 GC**: Reclaim the **payload** of a deleted element; keep a lightweight structural anchor (tombstone).
- **Retained Anchor**: A deleted element whose payload was reclaimed in Stage 1 but whose structural node remains.
- **Membership View**: The set of active replicas with an **epoch** number.
- **Epoch**: Integer incremented on every membership change.
- **Zombie Peer**: A replica still registered as a member but no longer communicating; stalls the stable frontier.
- **Eviction ("Exorcism")**: An authorized membership change removing a zombie peer and incrementing the epoch.
- **Fencing**: Rejecting messages/ops from evicted or stale-epoch peers.
- **Snapshot**: Full current state plus VV, used to bootstrap a new or returning replica.
- **Coordinator**: Small trusted Node.js service managing membership, epochs, and GC authorization. **[DECIDED]**
- **Graveyard Panel**: UI panel visualizing tombstones, anchors, frontier, epoch, and reclaimed memory. **[DECIDED]**

---

## Requirements

### 1. Core RGA (Replicated Growable Array) Implementation

**User Story**: As a developer integrating the CRDT kernel, I want a reliable RGA sequence CRDT, so that concurrent inserts and deletes converge to a consistent state across all replicas.

#### Acceptance Criteria

1. THE Kernel SHALL implement a sequence CRDT following the RGA (Replicated Growable Array) model.
2. WHEN an insert operation is created at a replica, THE Kernel SHALL assign it a unique Op ID of form `(replicaId, sequence)`.
3. WHEN an insert is applied, THE Kernel SHALL place it after a specified anchor element or `HEAD` if no anchor is given.
3.5. WHEN determining insertion order for concurrent inserts at the same anchor, THE Kernel SHALL include tombstones (deleted elements) when scanning through the sequence to find the correct position by Op ID, but THE Kernel SHALL NOT place new elements before or within tombstones. Tombstones maintain their structural position in the sequence for causality tracking, and concurrent inserts are ordered relative to each other by Op ID, not relative to tombstones.
4. WHEN two concurrent inserts target the same anchor, THE Kernel SHALL resolve ordering using the Op IDs (replica ID, then sequence) to ensure deterministic, consistent placement across all replicas.
5. WHEN a delete operation is applied, THE Kernel SHALL mark the element as deleted (tombstone) and retain its structural position.
6. THE Kernel SHALL maintain insertion order visibility to the application. Visible (non-deleted) elements are ordered by their anchor-based placement in the RGA, with concurrent inserts at the same anchor ordered deterministically by Op ID (replicaId first, then sequence). This ensures that all replicas, upon applying the same set of operations in any order, produce identical visible sequences.
7. WHEN traversing the sequence, THE Kernel SHALL return only non-deleted elements to the application; deleted elements (tombstones) remain internal.
8. THE Kernel SHALL ensure that concurrent insert and delete operations on the same element resolve consistently across all replicas without requiring a central coordinator for ordering.

#### Correctness Properties

- **Causal Consistency**: If operation A causally precedes operation B (A's effects are known before B is created), then all replicas apply A before B.
- **Eventual Consistency**: All replicas that have received the same set of operations will converge to the same sequence order.
- **Idempotence**: Applying the same operation multiple times produces the same result as applying it once.
- **Deterministic Convergence**: Two replicas with identical operation histories must produce byte-identical sequences.

---

### 2. Logical Clocks and Unique Element Identifiers

**User Story**: As the kernel, I want to assign globally unique, causally-ordered IDs to every element, so that operations can be placed correctly even under concurrent edits and network delays.

#### Acceptance Criteria

1. THE Kernel SHALL generate Replica IDs in format `${siteId}.${incarnation}` where `siteId` is a stable site identifier and `incarnation` is incremented when a replica is evicted and rejoins. **[PROPOSED]** Use a 16-character base-36 alphanumeric string for siteId.
2. WHEN an operation is created at a replica, THE Kernel SHALL assign an Op ID of form `(replicaId, sequence)` where `sequence` is a monotonically increasing integer starting from 1.
3. THE Kernel SHALL ensure that no two operations from the same replica have the same `sequence`.
4. THE Kernel SHALL ensure that Op IDs are globally unique across all replicas (no two replicas generate the same Op ID).
5. WHEN comparing two Op IDs, THE Kernel SHALL use lexicographic ordering: first by `replicaId`, then by `sequence` within the same replica. Lexicographic ordering SHALL be implemented using deterministic code-unit comparison (not locale-dependent string comparison): `replicaId1 < replicaId2 ? -1 : replicaId1 > replicaId2 ? 1 : 0` for the replicaId comparison, followed by numeric comparison for sequence. This ensures determinism across all locales.
6. THE Kernel SHALL track the current sequence number for each replica locally (as part of the state) and increment it atomically with each operation.

#### Correctness Properties

- **Uniqueness**: No two operations, anywhere in the system, share the same Op ID.
- **Monotonicity**: For a given replica, if operation A was created before operation B, then `A.sequence < B.sequence`.
- **Deterministic Ordering**: The ordering of any two Op IDs is always the same (total order on Op IDs).

---

### 3. Per-Replica Operation Log

**User Story**: As the kernel, I want to store every operation created or applied at a replica, so that I can reconstruct state, answer version-history queries, and support snapshotting.

#### Acceptance Criteria

1. WHEN an operation is created at this replica, THE Kernel SHALL append it to a local, append-only operation log.
2. THE Kernel SHALL assign each log entry a local sequence number (1, 2, 3, …) independent of the Op ID's sequence.
3. WHEN an operation is received from another replica, THE Kernel SHALL append it to the same log if it has not been seen before (deduplication).
4. THE Kernel SHALL provide a method to retrieve all operations in log order.
5. THE Kernel SHALL provide a method to retrieve all operations created by a specific replica.
6. WHEN reconstructing state from the operation log, THE Kernel SHALL apply all operations in causal order and produce the same sequence state.
7. THE Kernel SHALL expose the current log length and allow querying operations by log index.

#### Correctness Properties

- **Append-Only**: Operations are never removed or reordered in the log once appended.
- **Completeness**: The full log from any replica uniquely determines the RGA state at that point in time.
- **Deterministic Replay**: Replaying operations from the log in order always produces the same sequence state.

---

### 4. Contiguous Version Vectors (VV)

**User Story**: As the kernel, I want to track which operations from each replica have been causally delivered, so that I can compute a stable frontier and authorize garbage collection.

#### Acceptance Criteria

1. THE Kernel SHALL maintain a Version Vector (VV) for each replica, represented as a map from replica ID to a sequence number.
2. THE Kernel SHALL initialize the VV with all entries at 0.
3. WHEN an operation `(replicaId, seq)` is applied, THE Kernel SHALL update `VV[replicaId] = max(VV[replicaId], seq)` **only if** all operations `(replicaId, 1)` through `(replicaId, seq)` have been applied (contiguous prefix rule).
4. IF operations from a replica arrive out of order, THE Kernel SHALL buffer the out-of-order operations and not advance the VV entry until the contiguous prefix is complete.
5. THE Kernel SHALL provide a method to query the current VV.
6. THE Kernel SHALL provide a method to clone a VV (for immutability and snapshots).
7. WHEN comparing two VVs, THE Kernel SHALL support the following:
   - **Partial order**: VV A ≤ VV B (all entries in A are ≤ entries in B)
   - **Causality**: If A ≤ B, all operations known to A are also known to B
   - **Concurrent**: If neither A ≤ B nor B ≤ A, the VVs are concurrent (some operations known only to A, others only to B)
8. THE Kernel SHALL provide a method to compute the merge (component-wise maximum) of two VVs.
9. THE Kernel SHALL provide a method to increment a specific replica's entry in the VV.

#### Correctness Properties

- **Prefix Accuracy**: The VV entry for a replica never exceeds the sequence number of the last contiguous operation from that replica.
- **Causality Preservation**: If operation B depends on operation A (appears after in the dependency chain), and A's VV entry is in the VV of B's creator, then all replicas apply A before B.
- **Consistency**: Two replicas with identical operation histories must compute identical VVs at any given point.

---

### 5. Missing-Operation Exchange and Dependency Buffering

**User Story**: As a replica, I want to exchange missing operations with other replicas and buffer out-of-order operations, so that I can converge to the correct state even under network delays and reordering.

#### Acceptance Criteria

1. WHEN a replica receives an operation `(replicaId, seq)` but `seq > VV[replicaId] + 1`, THE Kernel SHALL buffer the operation instead of immediately applying it.
2. THE Kernel SHALL detect that operations `(replicaId, 1)` through `(replicaId, VV[replicaId])` are missing and generate a request for them.
3. WHEN missing operations are received, THE Kernel SHALL apply them in sequence order and then apply any buffered operations that are now unblocked.
4. THE Kernel SHALL maintain the buffer efficiently (no operations are applied until they are contiguous with the applied prefix).
5. WHEN requesting missing operations, THE Kernel SHALL send its current VV as a summary of what it already has, so the other replica can compute the set of missing operations.
6. THE Kernel SHALL handle duplicate buffered operations gracefully (if the same operation is buffered twice, applying it again has no effect due to the idempotence property).
7. IF after a timeout or max-retry period missing operations are still not received, THE Kernel SHALL be in a defined state and may emit a diagnostic event (not an error, as the replica may be offline).

#### Correctness Properties

- **Eventual Delivery**: If all replicas remain connected and keep trying, all operations eventually reach all replicas.
- **No Out-of-Order Application**: An operation is never applied if its dependencies (causal predecessors) have not been applied.
- **Duplicate Suppression**: Applying the same buffered operation twice or more produces the same result as applying it once.

---

### 6. Duplicate Suppression

**User Story**: As the kernel, I want to suppress duplicate operations, so that network retransmissions and redelivery do not cause data corruption or duplicate entries.

#### Acceptance Criteria

1. WHEN an operation with Op ID `(replicaId, seq)` has already been applied, THE Kernel SHALL recognize it and not apply it again.
2. WHEN a duplicate operation is received, THE Kernel SHALL skip it silently and proceed to the next operation.
3. THE Kernel SHALL use the Op ID as the primary deduplication key (not the operation content).
4. THE Kernel SHALL maintain an efficient data structure to detect duplicates (e.g., a set of seen Op IDs, not a linear search).
5. THE Kernel SHALL not require manual de-duplication code in the application or transport layer.

#### Correctness Properties

- **Idempotent Application**: `apply(op); apply(op)` = `apply(op)`.
- **Semantic Equivalence**: Suppressing a duplicate produces the exact same state as if the duplicate had never been sent.

---

### 7. Deterministic Simulated Network

**User Story**: As a test, I want a deterministic, controllable network simulation, so that I can reproduce network behavior and verify the kernel converges under all conditions.

#### Acceptance Criteria

1. THE Test Utilities SHALL provide a deterministic network simulator that replicates can use instead of real networking.
2. THE Simulator SHALL support configurable message delays, reordering, duplication, and loss (all deterministically seeded).
3. WHEN a replica sends a message, THE Simulator SHALL route it to the destination based on deterministic rules (seeded pseudo-random number generator).
4. THE Simulator SHALL ensure that running the same test with the same seed produces identical message sequences and replica states.
5. THE Simulator SHALL provide hooks for tests to control when messages are delivered (e.g., "deliver all messages" or "deliver messages for replica A only").
6. THE Simulator SHALL NOT be part of the production kernel code; it SHALL be in a separate `testing` module.
7. WHEN a message is delivered by the Simulator, THE Receiving replica SHALL process it deterministically (no real async, no real timers).

#### Correctness Properties

- **Reproducibility**: The same seed produces the same sequence of message deliveries and replica state transitions.
- **Pure Determinism**: No `Date.now()`, `Math.random()`, or other non-deterministic sources are used; all randomness is seeded.

---

### 8. Membership Epochs

**User Story**: As the kernel, I want to track membership changes and assign them epoch numbers, so that I can fence stale peers and safely authorize garbage collection.

#### Acceptance Criteria

1. THE Kernel SHALL maintain a **Membership View** consisting of a set of active Replica IDs and an **epoch** number.
2. WHEN the kernel is initialized, THE Epoch SHALL start at 0.
3. WHEN a membership change occurs (a replica is added or removed), THE Epoch SHALL be incremented by exactly 1.
4. WHEN a replica joins (its Replica ID is added to the active set), THE Epoch is incremented.
5. WHEN a replica is evicted (its Replica ID is removed from the active set), THE Epoch is incremented.
6. THE Kernel SHALL provide a method to query the current membership view (active replica IDs and epoch).
7. WHEN a replica creates a snapshot or acknowledges its VV to the coordinator, THE Snapshot/Ack SHALL include the current epoch.
8. WHEN a message is received from a replica, THE Kernel SHALL compare the message's epoch against the current epoch. IF the message's epoch is less than the current epoch, THE Kernel SHALL recognize it as from a stale or evicted peer (see Requirement 10).

#### Correctness Properties

- **Monotonic Epoch**: The epoch never decreases; it only increments on membership changes.
- **Change Detection**: Every membership change corresponds to exactly one epoch increment.
- **Stale Recognition**: A message from an evicted replica (old epoch) is reliably detected before being applied.

---

### 9. Zombie Eviction

**User Story**: As the coordinator, I want to evict offline replicas from the membership, so that the stable frontier can advance and garbage collection can proceed.

#### Acceptance Criteria

1. THE Coordinator SHALL maintain a list of stalled replicas (those that have not acknowledged for an application-configurable period). THE Graveyard panel SHALL display stalled replicas, allowing the operator to manually trigger eviction through an 'Exorcise' action. THE Coordinator SHALL evict a replica only when explicitly instructed by the application, never automatically.
2. WHEN the operator manually triggers eviction through the Graveyard panel, THE Coordinator SHALL mark the targeted replica as a zombie and proceed with removal.
3. WHEN the Coordinator evicts a zombie replica, IT SHALL:
   - Remove the replica's ID from the active membership view.
   - Increment the epoch.
   - Broadcast the new membership view to all remaining active replicas.
4. WHEN a replica receives a membership update showing it has been evicted, THE Replica SHALL:
   - Recognize that its current incarnation is no longer active.
   - Not apply any further operations from its current Replica ID.
   - Prepare to rejoin with a new incarnation (new Replica ID) if it wants to continue editing.
5. THE Coordinator SHALL NOT evict a replica that is actively acknowledging its VV while it remains in the active set.
6. IF a replica that was evicted later reconnects and tries to send operations with its old Replica ID, THE Remaining replicas SHALL reject them (see Requirement 10, Fencing).

#### Correctness Properties

- **Safety**: A replica is evicted only when explicitly instructed by the operator through the Graveyard panel.
- **Liveness**: The stable frontier advances after a zombie is manually evicted (no forever-stalled frontier).
- **Consistency**: All active replicas agree on the evicted set and epoch after receiving the membership update.

---

### 10. Stale-Peer Fencing

**User Story**: As the kernel, I want to reject operations from evicted or stale-epoch peers, so that evicted replicas cannot corrupt the state or block garbage collection.

#### Acceptance Criteria

1. WHEN an operation is received from a peer, THE Kernel SHALL check the peer's epoch.
2. IF the peer's epoch is less than the current epoch, THE Kernel SHALL reject the operation and not apply it.
3. WHEN an operation is rejected due to stale epoch, THE Kernel MAY emit a diagnostic event (for debugging) but SHALL NOT crash or throw an error.
4. IF the peer's epoch is equal to the current epoch, THE Kernel SHALL check that the peer's Replica ID is in the active membership.
5. IF the peer's Replica ID is not in the active membership (and the epoch is current), THE Kernel SHALL reject the operation.
6. WHEN a rejected operation is suppressed, THE Kernel's state and VV remain unchanged.
7. THE Kernel SHALL provide a method to query the current epoch, so that external code can validate peer epochs before sending operations.

#### Correctness Properties

- **Prevention of Corruption**: Stale operations from evicted peers never mutate the RGA state.
- **Convergence Safety**: Rejecting stale operations does not prevent convergence of active peers.
- **Transparent Rejection**: The application never sees operations from evicted peers; they are filtered at the kernel boundary.

---

### 11. Stable Frontier Computation

**User Story**: As the coordinator, I want to compute the stable frontier from acknowledged Version Vectors, so that I can determine which operations are causally stable and safe for garbage collection.

#### Acceptance Criteria

1. THE Coordinator SHALL collect Version Vector (VV) acknowledgments from all active replicas in the current membership view.
2. THE Coordinator SHALL compute the **Stable Frontier** as the component-wise **minimum** of all acknowledged VVs.
3. Formally: `Stable_Frontier[replicaId] = min(VV_ack[replica] for replica in active_membership)`
4. WHEN a new membership view is created (replica added or evicted), THE Coordinator SHALL recompute the Stable Frontier.
5. WHEN a replica's acknowledged VV is updated, THE Coordinator SHALL recompute the Stable Frontier and check if any new operations have become causally stable.
6. THE Coordinator SHALL make the Stable Frontier available to all replicas (via message or query) so they can determine which tombstones are safe to reclaim.
7. WHEN a replica is evicted, THE Coordinator SHALL **exclude** it from the Stable Frontier computation immediately (do not wait for its VV to age out).
8. THE Kernel SHALL provide a method to check if a given operation Op ID is at or below the Stable Frontier (i.e., causally stable).

#### Correctness Properties

- **Safety**: An operation is only marked as causally stable if all active replicas have applied it (or will apply it in the same order as predecessors).
- **Monotonicity**: The Stable Frontier never moves backward; it only advances or stays the same.
- **Coordination-Free**: Once the Stable Frontier is communicated, active replicas can independently and safely reclaim payload (no need to wait for coordinator authorization for Stage 1 GC).

---

### 12. Stage 1 Garbage Collection (Payload Reclamation)

**User Story**: As the kernel, I want to reclaim the payload of deleted elements once they are causally stable, so that memory usage grows sub-linearly with the document lifetime, not linearly with the number of deletes.

#### Acceptance Criteria

1. WHEN an operation is marked as causally stable AND it represents a deleted element (tombstone), THE Kernel SHALL identify the payload that can be reclaimed.
2. THE Kernel SHALL **reclaim the payload** (the element's content data) and discard it, but **retain the structural node** (the tombstone anchor with only its Op ID).
3. A Retained Anchor is a deleted element with a reclaimed payload; it occupies minimal memory (only Op ID and deletion flag).
4. WHEN checking if a deleted element's payload is reclaimable, THE Kernel SHALL consult the Stable Frontier and only reclaim if the delete operation is at or below it.
5. WHEN traversing the sequence, THE Kernel SHALL still skip over Retained Anchors (as they are deleted); the application never sees them.
6. WHEN processing dependency buffering or merge operations, THE Kernel SHALL still correctly treat Retained Anchors as valid anchor points for new inserts (they are structural, even without payload).
7. THE Kernel SHALL provide a method to query how much memory has been reclaimed via Stage 1 GC (for diagnostics and the Graveyard panel).
8. THE Kernel SHALL support a safe transition: once payload is reclaimed, it is gone; rollback is not supported (by design).

#### Correctness Properties

- **Memory Safety**: Reclaimed payloads are never accessed again.
- **Structural Integrity**: Retained Anchors continue to serve as valid anchor points for new inserts.
- **Deterministic Reclamation**: Given the same Stable Frontier and operation log, all replicas identify the same set of payloads to reclaim.
- **Non-Breaking**: The reclamation of payload does not change the observed sequence or causal order to the application.

---

### 13. Snapshots and Snapshot Rejoin

**User Story**: As a replica, I want to take a snapshot of the current state and use it to bootstrap a new or returning replica, so that new replicas do not need to replay the entire operation history.

#### Acceptance Criteria

1. THE Kernel SHALL provide a method to create a **Snapshot** containing:
   - The current RGA sequence (all elements, with their Op IDs and tombstone/delete status)
   - The current Version Vector (VV)
   - The current Membership View (active replica IDs and epoch)
   - Logical metadata derived from kernel state (e.g., causal frontier at snapshot time, not wall-clock timestamp)
2. THE Snapshot SHALL be serializable to a compact format (e.g., JSON or binary) suitable for storage or transmission.
3. WHEN a new replica (or a returning replica after eviction) is bootstrapped with a Snapshot, THE Kernel SHALL:
   - Initialize the RGA from the snapshot's sequence.
   - Initialize the VV from the snapshot's VV.
   - Initialize the membership view from the snapshot's membership.
   - Be ready to apply operations that arrived after the snapshot was taken.
4. WHEN operations are applied after snapshot-rejoin, THE Kernel SHALL merge them with the snapshotted state using the same convergence algorithm (operations with Op IDs > snapshot's VV are inserted, duplicates are suppressed).
5. IF an evicted replica rejoins from a snapshot that includes itself in the membership, THE Kernel SHALL recognize that it must create a new incarnation (new Replica ID) because the epoch has advanced.
6. THE Kernel SHALL NOT require explicit coordination between the snapshot creator and the rejoining replica; snapshot-based rejoin SHALL be safe under network delays and concurrent membership changes.
7. THE Snapshot SHALL include enough metadata for the Graveyard panel to display the historical state at the time of the snapshot.

#### Correctness Properties

- **State Fidelity**: A replica bootstrapped from a snapshot and then receiving all subsequent operations converges to the same state as a replica that was continuously connected.
- **Deterministic Merge**: Snapshot + subsequent operations produce the same result regardless of network reordering of post-snapshot operations.
- **No Lost Causality**: If operation A happened before the snapshot and operation B happened after, and B depends on A, the snapshotted replica correctly applies A before B.

---

### 14. Property-Based Tests (PBT) with fast-check

**User Story**: As a developer, I want to verify the kernel's correctness with property-based tests, so that edge cases, race conditions, and uncommon orderings are thoroughly tested automatically.

#### Acceptance Criteria

1. THE Test Suite SHALL use **fast-check** to generate randomized operation sequences and network scenarios.
2. FOR the RGA (Requirement 1), THERE SHALL be a property test verifying that any two replicas applying the same set of operations converge to the same sequence.
3. FOR Op IDs and logical clocks (Requirement 2), THERE SHALL be a property test verifying that Op IDs are globally unique and deterministically ordered.
4. FOR the operation log (Requirement 3), THERE SHALL be a property test verifying that replaying the log produces deterministic state.
5. FOR the Version Vector (Requirement 4), THERE SHALL be a property test verifying that VV partial order, causality, and merge operations are transitive and consistent.
6. FOR Missing-Op Exchange (Requirement 5), THERE SHALL be a property test verifying that under arbitrary message reordering and duplication, all replicas eventually converge.
7. FOR Duplicate Suppression (Requirement 6), THERE SHALL be a property test verifying that duplicate operations do not corrupt state or cause duplicate entries.
8. FOR Membership Epochs and Fencing (Requirements 8, 10), THERE SHALL be a property test verifying that stale-epoch operations are never applied and do not block the stable frontier.
9. FOR Stable Frontier Computation (Requirement 11), THERE SHALL be a property test verifying that the frontier advances monotonically and only when safe.
10. FOR Stage 1 GC (Requirement 12), THERE SHALL be a property test verifying that after reclamation, the sequence is unchanged and Retained Anchors still function as anchor points.
11. FOR Snapshots (Requirement 13), THERE SHALL be a property test verifying that a replica bootstrapped from a snapshot + post-snapshot operations converges to the same state as a continuously-connected replica.
12. THE Test Suite SHALL provide coverage > 85% for the core kernel modules (RGA, VV, GC, membership).
13. EACH property test SHALL include a shrinking strategy so that failing examples are reduced to their simplest form for debugging.
14. THE Test Suite SHALL be deterministically seeded so that failures are reproducible.

#### Correctness Properties (to be verified by tests)

- **Causal Consistency**: All replicas respect causal order of operations.
- **Eventual Consistency**: All replicas converge to the same state.
- **No Data Loss**: No operation is silently dropped; all are either applied or explicitly rejected.
- **No Corruption**: Stale or malformed operations never corrupt the state.
- **Memory Efficiency**: Garbage collection reduces memory without breaking correctness.
- **Snapshot Fidelity**: Snapshots + subsequent operations produce consistent state.

---

### 15. Unit Tests and Test Coverage

**User Story**: As a developer, I want every kernel module to have comprehensive unit tests, so that regressions are caught early and integration is straightforward.

#### Acceptance Criteria

1. EVERY exported function and class in the kernel SHALL have at least one unit test.
2. UNIT tests SHALL cover:
   - Normal operation (happy path)
   - Edge cases (empty sequences, single element, large sequences)
   - Error conditions (invalid inputs, invalid states)
3. THE Test Suite SHALL run with **Vitest** and produce coverage reports.
4. **Code coverage target**: > 85% for core modules (`rga`, `vv`, `ops`, `membership`, `gc`).
5. **Branch coverage target**: > 80% (control flow branches must be tested).
6. UNIT tests SHALL execute deterministically and not depend on external state or timing.
7. TEST files SHALL be co-located with source files (e.g., `rga.ts` and `rga.test.ts` in the same directory) or in a `tests/` directory structure. **[PROPOSED]** Co-location for clarity.
8. THE Test Suite SHALL include setup/teardown fixtures for common test scenarios (e.g., "three replicas with specific operation histories").

#### Test Quality Standards

- **Clarity**: Test names clearly describe what is being tested and what the expected outcome is.
- **Independence**: Tests do not depend on execution order; running them in any order produces the same results.
- **Speed**: Unit tests run in < 1 second for the full suite (fast feedback loop).
- **Isolation**: Tests use mocked dependencies where applicable; no real network, no real timers.

---

### 16. API Surface and Integration Points

**User Story**: As an application developer (building Graveyard Whiteboard or Cursed Checklist), I want a clean, simple API to interact with the kernel, so that I can create operations, listen for state changes, and query the sequence without coupling to internal details.

#### Acceptance Criteria

1. THE Kernel SHALL export a main **`CRDT`** class or factory with these core methods:
   - `insert(replicaId, anchor, value)` → creates and applies an insert operation
   - `delete(replicaId, elementId)` → creates and applies a delete operation
   - `getSequence()` → returns current sequence (non-deleted elements)
   - `getVV()` → returns current Version Vector
   - `applyOp(op)` → applies a remote operation
   - `snapshot()` → creates a snapshot
   - `rejoinFromSnapshot(snapshot)` → initializes from snapshot
2. THE Kernel SHALL provide event hooks (or callback registration) for:
   - `onSequenceChanged` — fired when the sequence changes due to local or remote operations
   - `onMembershipChanged` — fired when membership or epoch changes
   - `onGCEvent` — fired when garbage collection reclaims payload (for the Graveyard panel)
3. OPERATIONS SHALL be **serializable** to JSON (or a simple binary format) so they can be transmitted over the network or stored. **[PROPOSED]** JSON with `{ type, replicaId, seq, anchor, value, timestamp?, epoch? }` schema.
4. THE Kernel SHALL provide query methods:
   - `isElementDeleted(elementId)` → boolean
   - `isCausallyStable(opId)` → boolean
   - `getStableFrontier()` → Version Vector
   - `getMembershipView()` → { activeReplicas, epoch }
   - `getGCStats()` → { bytesReclaimed, tombstonesRetained, reclaimableOps }
5. THE Kernel SHALL NOT expose internal data structures directly; all access is through these public methods.
6. ERRORS SHALL be represented consistently (e.g., custom exception types, not bare strings).

#### Correctness Properties

- **API Consistency**: The same sequence of API calls produces the same state across all replicas.
- **Non-Breaking**: Changes to internal implementation do not break the public API surface.

---

### 17. Documentation and Code Comments

**User Story**: As a developer reading the kernel code, I want clear documentation and comments, so that I understand the design intent and can maintain or extend the code.

#### Acceptance Criteria

1. EVERY public function and class SHALL have a JSDoc comment explaining:
   - What it does (one sentence)
   - Parameters (name, type, purpose)
   - Return value (type and meaning)
   - Any preconditions or invariants
   - Examples (for complex functions)
2. COMPLEX algorithms (e.g., dependency buffering, stable frontier computation) SHALL have block comments explaining the algorithm and its correctness.
3. THE codebase SHALL include a **README** in the kernel directory explaining:
   - High-level architecture (RGA, VV, membership, GC)
   - Key design decisions and tradeoffs
   - How to integrate the kernel into an application
   - Known limitations (e.g., no dynamic shard merging, no Stage 2 GC in MVP)
   - References to prior art (Yjs, Automerge, Loro, academic papers)
4. THE README SHALL NOT make forbidden claims (see project spec Section 3.4); it SHALL clearly state this is an educational implementation.

#### Documentation Quality Standards

- **Accuracy**: Comments match the code; outdated comments are updated or removed.
- **Clarity**: Explanations are understandable to developers familiar with CRDTs and TypeScript.
- **Examples**: Complex functions include usage examples in comments.

---

## Integration Constraints and Dependencies

### Assumptions

1. **No External CRDT Library**: The kernel is built from scratch; Yjs, Automerge, Loro, etc. are NOT dependencies. **[DECIDED]**
2. **Pure Kernel**: The `/kernel` directory contains only pure, deterministic TypeScript; no DOM, no real async, no `Date.now()`, no `Math.random()`. **[DECIDED]**
3. **Transport Layer Separate**: The coordinator and transport (BroadcastChannel, WebSocket, etc.) are outside the kernel; the kernel accepts operations and states as input.
4. **Single Coordinator**: Membership and stable frontier are managed by a single trusted coordinator. **[DECIDED]**
5. **No Sharding or Partitioning**: The entire document is kept at every replica (no horizontal scaling in MVP).
6. **Deterministic Serialization**: All operations and snapshots are deterministically serializable to JSON (no floating-point precision issues, no non-deterministic iteration order). **[PROPOSED]** Use sorted keys in JSON output.

### Testing Environment

1. **Vitest**: Unit tests run with Vitest; property-based tests use fast-check.
2. **Deterministic Randomness**: All randomness in tests is seeded; no real timers or async.
3. **Coverage Reporting**: Vitest integrated with coverage tools (e.g., c8 or built-in); coverage reports are generated after each test run.

### Failure Modes and Graceful Degradation

1. **Network Partition**: If the coordinator is unreachable, replicas continue to operate locally (all ops succeed locally). Stable frontier does not advance until coordinator is reachable (designed behavior, not a bug).
2. **Evicted Replica**: An evicted replica recognizes it is no longer active and stops applying its own ops. It can rejoin with a new incarnation (new Replica ID).
3. **Stale Operation**: An operation from an evicted or stale-epoch peer is silently rejected (no error thrown); the kernel remains in a consistent state.
4. **Out-of-Order Operations**: Buffered until contiguous; no data loss.

---

## Scope and Out-of-Scope

### In Scope (MUST have)

- RGA sequence CRDT with insert/delete
- Logical clocks and unique Op IDs
- Per-replica operation logs
- Contiguous version vectors with missing-op exchange and dependency buffering
- Duplicate suppression
- Deterministic simulated network (for tests)
- Membership epochs, zombie eviction, stale-peer fencing
- Stable frontier computation
- Stage 1 GC (payload reclamation with retained anchors)
- Snapshots and snapshot rejoin
- Comprehensive property-based tests (fast-check)
- Unit tests with > 85% coverage
- Clean API surface for applications

### Should Have (stretch, but prioritized)

- BroadcastChannel transport for multi-tab demo
- IndexedDB persistence (kernel state can be saved/restored)
- Exportable orphaned edits for evicted replicas
- Polished Graveyard panel UI

### Stretch Goals (optional, cut if behind)

- Stage 2 structural GC (remove structural anchors; only if safety proven)
- Simple LWW (last-write-wins) map for metadata
- WebRTC transport

### Explicitly Out of Scope

- Stage 2 GC in MVP (stretch goal)
- Rich text formatting support in kernel (application-level concern)
- Undo/redo (application-level concern)
- Live cursor/presence (separate subsystem)
- User authentication or access control
- Server-side persistence of document content
- Mobile-optimized UI
- Internationalization
- LLM/AI features

---

## Success Criteria and Acceptance

A successful CRDT Kernel implementation will:

1. ✅ Pass all property-based tests with > 85% code coverage.
2. ✅ Support the Graveyard Whiteboard app (collaborative drawing with deletes).
3. ✅ Support the Cursed Checklist app (shared to-do list with edits and deletes).
4. ✅ Maintain backward compatibility as the kernel evolves (API stability).
5. ✅ Demonstrate causal consistency and eventual convergence under all simulated network conditions.
6. ✅ Reclaim memory via Stage 1 GC without breaking correctness.
7. ✅ Integrate cleanly into the two applications without requiring changes to core kernel logic.
8. ✅ Be thoroughly documented and understandable to a developer new to CRDTs.
9. ✅ Make no forbidden claims (not production-ready, not a new algorithm, not a Yjs/Automerge/Loro replacement).
10. ✅ Be submitted to Devpost on or before Dec 3, 2026.

---

## Revision History

| Date | Version | Changes |
|---|---|---|
| 2026-11-11 | 1.0 | Initial requirements document created from project specification. |

