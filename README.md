# CRDT Kernel

A specification-driven, causally-consistent collaborative data structure implementation using Replicated Growable Arrays (RGA) and Lamport clocks.

## Overview

CRDT Kernel is an educational implementation of a conflict-free replicated data type (CRDT) designed for collaborative applications. It provides a foundation for building real-time collaborative editors, whiteboards, checklists, and other multi-user applications where replicas can operate independently and eventually converge.

**Status**: Pre-implementation (specification and design phase complete)

**Target Completion**: December 3, 2026

## Key Features

- **Lamport Clock Ordering**: Deterministic operation ordering across replicas using `(lamport, replicaId)` tuples
- **RGA (Replicated Growable Array)**: Supports concurrent inserts and deletes with structural integrity
- **Causal Consistency**: Version vectors enforce causal ordering across replicas
- **Garbage Collection**: Stage 1 payload reclamation based on stable frontiers
- **Membership Management**: Dynamic replica join/leave with epoch-based fencing
- **Snapshot & Rejoin**: Support for saving state and recovering new replicas
- **Property-Based Testing**: 18 correctness properties verified with fast-check
- **Deterministic Replay**: All operations reproducible with same seed

## Design Philosophy

This implementation follows the [BONES Project Specification](BONES_PROJECT_SPEC.md) with these core principles:

1. **No Data Loss**: Operations are buffered indefinitely until dependencies are satisfied
2. **Deterministic**: Same operations in same order always produce identical results (no wall-clock time)
3. **Code-Unit Comparison**: Replica IDs compared using string comparison only (no locale-dependent functions)
4. **Manual Eviction**: Replicas only evicted via explicit operator action (no automatic timeout-based eviction)
5. **Structural Integrity**: Deleted elements retained as anchors; only payloads reclaimed in GC

## Architecture

### Core Modules

| Module | Responsibility |
|--------|-----------------|
| **Lamport** | Local clock tracking and operation timestamps |
| **RGA** | Insert/delete operations with concurrent ordering |
| **VersionVector** | Causal dependency tracking and contiguity enforcement |
| **OpLog** | Operation log storage, deduplication, and replay |
| **Membership** | Active replica set, epochs, and eviction cutoffs |
| **GC** | Stable frontier computation and payload reclamation |
| **Snapshot** | State serialization and replica rejoin |

### CRDT Orchestrator

Central `CRDT` class coordinates all modules and provides public API:

```typescript
// Create a local replica
const crdt = new CRDT('replica-1');

// Local operations
const op1 = crdt.insert(undefined, { text: 'Hello' });
const op2 = crdt.insert(op1.id, { text: ' World' });

// Query state
const sequence = crdt.getSequence();  // [{ text: 'Hello' }, { text: ' World' }]
const vv = crdt.getVV();              // Version vector

// Handle remote operations
crdt.applyOp(remoteOp);

// Save and restore state
const snapshot = crdt.snapshot();
const crdt2 = CRDT.fromSnapshot(snapshot);
```

## Testing Strategy

### Unit Tests (9 groups)
- RGA operations (insert, delete, tombstones)
- VersionVector partial order and contiguity
- OpLog deduplication and replay
- Membership updates and epochs
- GC correctness and frontier computation
- Snapshot serialization and rejoin
- CRDT orchestrator integration
- Event consistency
- Edge cases and error recovery

### Property-Based Tests (18 properties)
1. RGA Convergence
2. Op ID Uniqueness and Ordering
3. Op ID Contiguity
4. OpLog Deterministic Replay
5. VV Partial Order Consistency
6. Contiguous Prefix Rule
7. Missing Operation Recovery (no deadlock)
8. Duplicate Suppression Idempotence
9. Deterministic Network Reproducibility
10. Membership Epoch Monotonicity
11. Stale-Epoch Fencing
12. Stable Frontier Monotonicity
13. Causally Stable Operation Identification
14. Stage 1 GC Correctness
15. Snapshot Fidelity
16. Deterministic Operation Serialization
17. Event Callback Consistency
18. API Method Consistency

### Integration Tests (5 scenarios)
- 2-replica convergence with reordered messages
- 3+ replica convergence
- Snapshot and rejoin workflow
- Membership changes and eviction
- End-to-end combined scenario

## Specification

Full specification documents are in `.kiro/specs/crdt-kernel/`:

- **requirements.md**: Functional and non-functional requirements (14 requirements)
- **design.md**: Detailed design including algorithms, data structures, and invariants
- **tasks.md**: 79 implementation tasks organized in 10 phases

### Key Algorithms

**Algorithm 1 - Lamport Ordering**: Elements ordered by `(lamport, replicaId)` with code-unit string comparison

**Algorithm 2 - RGA Insertion**: Find position by scanning past elements with lesser `(lamport, replicaId)` key

**Algorithm 3 - Dependency Buffering & Fencing**: 
- Buffer ops missing anchor (INSERT) or target (DELETE)
- Fence ops from stale epochs or beyond eviction cutoff
- Apply when dependencies satisfied

**Algorithm 5 - Stable Frontier**: `Frontier[r] = min{ack_m[r] : m in active_members}`

**Algorithm 6 - GC Reclamation**: Reclaim payload if ANY delete op D satisfies `D.seq <= Frontier[D.replica]`

## Implementation Roadmap

### Phase 1: Setup (5 tasks)
Repository structure, TypeScript config, test frameworks

### Phase 2: Core Modules (23 tasks)
Lamport, RGA, VersionVector, OpLog, Membership, GC, Snapshot

### Phase 3: Orchestrator (4 tasks)
CRDT class with public API and events

### Phase 4: Testing Infrastructure (4 tasks)
Network simulator, arbitraries, fixtures, builders

### Phase 5: Unit Tests (9 tasks)
Comprehensive coverage of all modules

### Phase 6: Property-Based Tests (18 tasks)
Correctness properties verified with fast-check

### Phase 7: Integration Tests (5 tasks)
Multi-replica scenarios

### Phase 8: Documentation (4 tasks)
API docs, architecture guide, rationale, integration guide

### Phase 9: Transport & Coordinator (4 tasks)
BroadcastChannel, IndexedDB, coordinator service, WebRTC

### Phase 10: Applications (2 tasks)
Graveyard Whiteboard and Cursed Checklist demos

## Getting Started (Future)

Once implementation begins:

```bash
# Install dependencies
npm install

# Run tests
npm run test
npm run test:watch
npm run coverage

# Build
npm run build

# Run with deterministic seeding
SEED=12345 npm run test
```

## Data Structures

### Operation (Op)
```typescript
interface Operation {
  id: { replicaId: string; seq: number };
  type: 'insert' | 'delete';
  anchor?: OpId;           // insert: position after this
  target?: OpId;           // delete: which element
  value?: any;             // insert only
  lamport: number;         // Lamport timestamp
  replicaId: string;
}
```

### Element (in RGA)
```typescript
interface Element<T> {
  id: OpId;
  lamport: number;
  value?: T;
  deleted: boolean;
  deletedAt?: OpId;
  payloadReclaimed: boolean;
}
```

### VersionVector
```typescript
type VersionVector = Map<replicaId, seq>;
// Component-wise max merge, contiguous prefix enforced
```

### Snapshot
```typescript
interface Snapshot<T> {
  sequence: Element<T>[];
  vv: VersionVector;
  membership: MembershipView;
  gcStats: GCStats;
  metadata: {
    creator: string;           // replicaId
    logicalIndex: number;      // Lamport value
    gcState: 'on' | 'off';
  };
}
```

## Correctness Guarantees

1. **Strong Eventual Consistency**: All replicas converge to identical state given same operations
2. **Causality Preservation**: If op A happened-before op B, all replicas apply A before B
3. **No Data Loss**: All operations applied unless rejected by fencing
4. **Determinism**: Same seed and operation sequence always produces identical replica states
5. **Atomicity**: Each operation applied entirely or not at all
6. **Idempotence**: Applying operation multiple times ≡ applying once

## Known Limitations

- **Single Coordinator**: Assumes single coordinator for frontier computation (no Raft consensus yet)
- **No Stage 2 GC**: Tombstones never removed (retention continues indefinitely)
- **No Sharding**: All operations on single replica (no horizontal scaling)
- **RGA Only**: Other CRDT types (maps, sets, counters) not included
- **Educational Scope**: Not optimized for production performance

## Future Work

- Raft-based coordinator for fault tolerance
- Stage 2 GC with tombstone cleanup
- Horizontal sharding by operation stream
- Additional CRDT types (LWW-Element-Set, PN-Counter, etc.)
- Performance benchmarking and optimization
- Formal verification of correctness properties

## Educational Value

This project is designed to teach:

1. **CRDT Fundamentals**: How concurrent replicas achieve eventual consistency
2. **Lamport Clocks**: Logical time and causal ordering
3. **Version Vectors**: Dependency tracking across distributed systems
4. **Property-Based Testing**: Verifying complex system properties with random inputs
5. **Deterministic Simulation**: Testing distributed systems without flaky timing
6. **Specification-Driven Development**: Building from formal requirements and design

## References

- [BONES Project Specification](BONES_PROJECT_SPEC.md) — Full feature specification
- `.kiro/specs/crdt-kernel/requirements.md` — Detailed requirements
- `.kiro/specs/crdt-kernel/design.md` — Design and algorithms
- `.kiro/specs/crdt-kernel/tasks.md` — Implementation task breakdown

## License

MIT License - Copyright 2026 Keerthivasan S.

This is an educational project created as part of the BONES Initiative.

## Disclaimer

This implementation is for educational purposes. It is not a production-ready CRDT library and should not be used in production systems without significant hardening, performance optimization, and security review.

---

**Ready to implement?** See `.kiro/specs/crdt-kernel/tasks.md` for the 79-task implementation roadmap starting with Phase 1 setup tasks.
