# CRDT Kernel

**Pure, deterministic replicated data type implementation for collaborative applications.**

The kernel is the core of the Bones project — a Conflict-Free Replicated Data Type (CRDT) designed to synchronize state across multiple replicas without coordination.

## Features

- **Deterministic**: Same seed = identical results. No `Date.now()`, `Math.random()`, or non-deterministic I/O.
- **Pure**: `/src` contains only algorithms and data structures. No DOM, network, storage, or time.
- **Causally Consistent**: Version Vectors enforce causal ordering across replicas.
- **Operation Buffering**: Operations are never silently dropped; buffered until dependencies are satisfied.
- **Tombstone Fencing**: Deleted elements remain as "ghosts" to preserve structure and support undo.
- **Garbage Collection**: Reclaim memory from stable operations while maintaining structural integrity.
- **Snapshots & Rejoins**: Persist state and rejoin efficiently.

## Project Structure

```
kernel/
├── src/
│   ├── index.ts              # Public API export
│   ├── types.ts              # Core interfaces (Operation, Element, etc.)
│   ├── utils.ts              # Deterministic helpers (OpId, VersionVector)
│   ├── events.ts             # Simple event emitter
│   ├── lamport.ts            # Lamport clock (Phase 1)
│   ├── rga.ts                # Replicated Growable Array (Phase 2–3)
│   ├── vv.ts                 # Version Vector (Phase 2–3)
│   ├── oplog.ts              # Operation log (Phase 3)
│   ├── membership.ts         # Membership & epochs (Phase 4)
│   ├── gc.ts                 # Garbage collection (Phase 4)
│   ├── snapshot.ts           # Snapshots & rejoin (Phase 5)
│   └── crdt.ts               # Main CRDT orchestrator (Phase 5)
├── tests/
│   ├── utils.test.ts         # Unit tests for utilities
│   ├── lamport.test.ts       # Phase 1 tests
│   ├── rga.test.ts           # Phase 2–3 tests
│   ├── vv.test.ts            # Phase 2–3 tests
│   ├── oplog.test.ts         # Phase 3 tests
│   ├── membership.test.ts    # Phase 4 tests
│   ├── gc.test.ts            # Phase 4 tests
│   ├── snapshot.test.ts      # Phase 5 tests
│   ├── crdt.test.ts          # Phase 5 integration tests
│   └── properties.test.ts    # 18 property-based tests (throughout)
├── testing/
│   ├── deterministicNetwork.ts   # Test network simulator
│   ├── arbitraries.ts            # fast-check generators
│   ├── fixtures.ts               # Multi-replica setup helpers
│   └── builders.ts               # Data builders
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md (this file)
```

## Development

### Setup

```bash
npm install
npm run build
npm test
```

### Key Conventions

- **Op IDs** are always strings: `` `${replicaId}:${seq}` `` (never objects)
- **Immutability**: Return new objects; mutate nothing
- **No randomization** in algorithms (but tests use `fast-check` with seeds)
- **String comparison only** for OpId tie-breaking (no `localeCompare`)

### Tech Stack

- **Language**: TypeScript 5.6 (strict mode)
- **Runtime**: Node.js 20+
- **Tests**: Vitest 2.0 + fast-check 3.19
- **Build**: tsc

## API Overview

```typescript
class CRDT<T> {
  constructor(replicaId: string);

  // Local operations
  insert(anchorId: OpIdKey | undefined, value: T): Operation<T>;
  delete(elementId: OpIdKey): Operation<T>;

  // Apply remote op
  applyOp(op: Operation<T>): void;

  // Queries
  getSequence(): Element<T>[];
  getVV(): VersionVector;
  getMembershipView(): MembershipView;
  isElementDeleted(elementId: OpIdKey): boolean;
  isCausallyStable(opId: OpIdKey): boolean;
  getStableFrontier(): VersionVector;
  getGCStats(): GCStats;

  // Events
  on(event: 'sequenceChanged' | 'membershipChanged' | 'gcEvent', cb: () => void): void;
  off(event: string, cb: () => void): void;

  // Snapshots
  snapshot(): Snapshot<T>;
  static fromSnapshot(snapshot: Snapshot<T>): CRDT<T>;
}
```

## Phases & Tasks

The kernel is built in 10 phases (80 tasks total):

1. **Phase 1 (KER-001–005)**: Setup, types, utils, events ✅ DONE
2. **Phase 2–3 (KER-006–019)**: RGA, VersionVector, OpLog
3. **Phase 4 (KER-020–029)**: Lamport clock, membership, GC
4. **Phase 5 (KER-030–033)**: CRDT orchestrator
5. ... and 5 more phases through stabilization, testing, and integration

See `.kiro/specs/crdt-kernel/tasks.md` for the full task list.

## References

- **Design**: `.kiro/specs/crdt-kernel/design.md` (8 algorithms, 14 requirements)
- **Requirements**: `.kiro/specs/crdt-kernel/requirements.md` (14 formal requirements)
- **Tech Stack**: `.kiro/steering/tech.md` (conventions, APIs, kernel purity rules)
- **Product**: `.kiro/steering/product.md` (graveyard metaphor, core principles)

## License

MIT — see `LICENSE` at repo root.
