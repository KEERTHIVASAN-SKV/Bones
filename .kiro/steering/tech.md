# CRDT Kernel — Technical Stack & Conventions

## Build, Test, and Runtime Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Language** | TypeScript 5.x (strict mode) | Type safety for complex distributed algorithms |
| **Runtime** | Node.js 20+ (for coordinator), browsers (for apps) | Standard for hackathon JS projects |
| **Package Manager** | npm | Standard; works with Kiro and CI |
| **Build Tool** | TypeScript compiler (tsc) | Simple, no webpack complexity for this scope |
| **Test Framework** | Vitest | Fast, modern, excellent Vite integration; ESM native |
| **Property Testing** | fast-check | Industry standard for PBT in JS |
| **Assertions** | Vitest `expect()` | Built-in; no extra dependency |
| **Web Transport** | BroadcastChannel (multi-tab), WebSockets/WebRTC (multi-peer) | Standard browser APIs |
| **Storage** | IndexedDB (client), file system (coordinator) | Persistent state across page reloads |
| **UI Framework** | React 18 + TypeScript | Standard for collaborative UIs; matches demo scope |

## Directory Structure

```
/Bones (repo root)
├── LICENSE                          # MIT license (required by Devpost)
├── README.md                        # Project overview
├── .gitignore                       # Never gitignores .kiro/
├── .kiro/                           # Kiro specs, steering, hooks (required by rules)
│   ├── specs/crdt-kernel/           # Formal requirements, design, tasks
│   ├── steering/                    # Tech stack & conventions (this file)
│   └── hooks/                       # Agent automation (pre-commit, spec validation)
├── kernel/                          # Pure CRDT kernel (no DOM, network, storage, time)
│   ├── src/
│   │   ├── index.ts                 # Public API export
│   │   ├── types.ts                 # Core interfaces (Operation, Element, OpIdKey, etc.)
│   │   ├── lamport.ts               # Lamport clock implementation
│   │   ├── rga.ts                   # Replicated Growable Array
│   │   ├── vv.ts                    # Version Vector
│   │   ├── oplog.ts                 # Operation log
│   │   ├── membership.ts            # Membership & epochs
│   │   ├── gc.ts                    # Garbage collection
│   │   ├── snapshot.ts              # Snapshots & rejoin
│   │   ├── crdt.ts                  # Main CRDT orchestrator
│   │   ├── utils.ts                 # Deterministic helpers
│   │   └── events.ts                # Simple event emitter
│   ├── tests/                       # Unit & property tests
│   │   ├── lamport.test.ts
│   │   ├── rga.test.ts
│   │   ├── vv.test.ts
│   │   ├── oplog.test.ts
│   │   ├── membership.test.ts
│   │   ├── gc.test.ts
│   │   ├── snapshot.test.ts
│   │   ├── crdt.test.ts
│   │   └── properties.test.ts       # 18 PBT properties
│   ├── testing/                     # Test infrastructure (shared)
│   │   ├── deterministicNetwork.ts
│   │   ├── arbitraries.ts           # fast-check generators
│   │   ├── fixtures.ts              # Multi-replica setup helpers
│   │   └── builders.ts              # Data builders
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── package.json
│   └── README.md                    # Kernel-specific docs
├── apps/
│   ├── graveyard-whiteboard/        # Drawing app with Graveyard panel
│   │   ├── src/
│   │   │   ├── index.tsx
│   │   │   ├── components/
│   │   │   │   ├── Canvas.tsx
│   │   │   │   ├── GraveyardPanel.tsx
│   │   │   │   └── MembershipStatus.tsx
│   │   │   └── App.tsx
│   │   ├── package.json
│   │   └── README.md
│   └── cursed-checklist/            # To-do app with Graveyard panel
│       ├── src/
│       │   ├── index.tsx
│       │   ├── components/
│       │   │   ├── TodoList.tsx
│       │   │   ├── GraveyardPanel.tsx
│       │   │   └── MembershipStatus.tsx
│       │   └── App.tsx
│       ├── package.json
│       └── README.md
├── coordinator/                     # Node.js coordinator service (optional for demo)
│   ├── src/
│   │   ├── index.ts
│   │   ├── coordinator.ts           # Frontier computation, membership
│   │   └── storage.ts               # Simple file-based state
│   ├── package.json
│   └── README.md
└── package.json                     # Root workspace (if using npm workspaces)
```

## Code Style & Conventions

### Naming & Identifiers

- **Op IDs** — use canonical string format: `` `${replicaId}:${seq}` `` everywhere (type: `OpIdKey`)
  - Never convert to/from objects; use strings directly for Map keys, Set members, serialization
- **Replica IDs** — strings (UUIDs or human-readable names like `"replica-1"`)
- **Lamport timestamps** — numbers, monotonically increasing per replica
- **Sequences** — numbers, contiguous from 1 upward per replica

### Determinism Rules (KERNEL PURITY)

- **No `Date.now()`, `new Date()`, `Math.random()`** in `/kernel/src/` — ever
- **No async I/O, network, storage** in `/kernel/src/` — pure functions only
- **No DOM, CSS, global state** in `/kernel/src/` — transport layer and apps handle these
- **String comparison only** for Op ID tie-breaking — use `a < b ? -1 : a > b ? 1 : 0`, never `localeCompare()`
- **Immutability default** — return new objects; document any copy-on-write (COW) patterns

### Type Definitions

```typescript
// Canonical Op ID representation (everywhere)
type OpIdKey = `${string}:${number}`;

// Core types (in types.ts)
interface Operation<T> {
  id: OpIdKey;  // NOT an object, always a string
  type: 'insert' | 'delete';
  anchor?: OpIdKey;        // insert: position after
  target?: OpIdKey;        // delete: which element
  value?: T;               // insert only
  lamport: number;         // Lamport timestamp
  replicaId: string;
  // epoch field is diagnostic-only (not used for fencing)
  epoch?: number;
}

interface Element<T> {
  id: OpIdKey;
  anchor: OpIdKey | undefined;  // parent in the RGA tree (undefined = HEAD); never changes
  lamport: number;
  value?: T;
  deleted: boolean;
  deletedAt?: OpIdKey;
  payloadReclaimed: boolean;
}

type VersionVector = Map<string, number>;  // replicaId → highest CONTIGUOUS applied seq
type OpIdKey = `${string}:${number}`;
```

The per-replica sequence number is the `seq` part of `Operation.id`; read it with `parseOpId(op.id)`. There is no separate `seq` field.

### RGA Ordering Rule (source of truth)

The RGA is a **tree**: each element is a child of its `anchor` (or of HEAD). The visible/structural order is a **depth-first, pre-order traversal** of that tree. Children of the same parent are ordered **newest first**: higher `(lamport, replicaId)` comes first, comparing `lamport` numerically and then `replicaId` by code unit (never `localeCompare`).

- A local insert has the highest Lamport value the replica has seen, so it becomes the first child of its anchor and lands **immediately after** the anchor (this is what makes "insert at visible index k lands at k" hold, Requirement 1.8).
- An element's whole subtree stays contiguous. A concurrent sibling is never placed inside another sibling's subtree.
- Traversal must be iterative (explicit stack), not recursive: typing a long string creates a chain as deep as the string.
- This matches the standard RGA rule in requirements.md §1.3. An earlier draft of design.md scanned oldest-first; that ordering puts a middle insert after its anchor's existing children and was removed (see SPEC_REVIEW_FIXES_APPLIED.md, "Correctness cases").

### Type Mapping (design.md drafts → `kernel/src/types.ts`)

`types.ts` and this file are the source of truth. Older drafts of design.md/requirements.md used the names on the left.

| Earlier draft | Now |
|---------------|-----|
| `OpId` object `{ replicaId, seq }` | `OpIdKey` string `` `${replicaId}:${seq}` `` |
| `Operation.replicaId` + `Operation.seq` (no `id`) | `Operation.id` (OpIdKey) + `Operation.replicaId`; seq = `parseOpId(id).seq` |
| `Operation.anchorId` | `Operation.anchor` |
| `Operation.elementId` | `Operation.target` |
| `Element.epoch` | removed (epoch is diagnostic-only, kept on `Operation.epoch`) |
| (none) | `Element.anchor` (new; required for tree order and snapshots) |
| `MembershipView.activeReplicas` | `MembershipView.activeMembers` |
| (cutoffs kept separately) | `MembershipView.evictedMembers: Map<replicaId, cutoff>` |
| `GCStats { bytesReclaimed, tombstonesRetained, reclaimableOps }` | `GCStats { tombstoneCount, payloadsReclaimed, bytesSaved, replicasEvicted, stableFrontier }` |
| `Snapshot { sequence, vv, membership, metadata }` | `Snapshot { elements, vv, membership (MembershipView), lamportClock, replicaId, gcStats?, stableFrontier? }` (no wall-clock field) |
| `OperationBuffer { buffer, missingOps }` | `OperationBuffer { ops, missing }` |

### CRDT API Signature

```typescript
class CRDT<T> {
  constructor(replicaId: string);

  // Local operations (replicaId already known)
  insert(anchorId: OpIdKey | undefined, value: T): Operation<T>;
  delete(elementId: OpIdKey): Operation<T>;

  // Apply remote op
  applyOp(op: Operation<T>): void;

  // Queries (read-only)
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
  // Restores state only; post-snapshot ops must then go through applyOp().
  // `replicaId` defaults to snapshot.replicaId (restart of the same replica).
  // A rejoining evicted replica MUST pass a NEW replicaId (new incarnation).
  static fromSnapshot(snapshot: Snapshot<T>, replicaId?: string): CRDT<T>;
}
```

### JSDoc Requirements

- **All public methods** must have JSDoc with `@param`, `@returns`, `@throws` (if applicable)
- **All type definitions** must have JSDoc describing semantics (e.g., "immutable", "causally stable", "stable frontier = min(active members)")
- **All algorithms** must reference the design doc (e.g., `// Algorithm 3 (applyOp) from design.md`)

### Testing Conventions

- **Unit tests** use inline seeding: `fc.seed(12345)` passed to property generators
- **Deterministic network** uses seeded RNG for message ordering
- **Each PBT property** runs ≥100 iterations; shrinking must produce minimal examples
- **No flaky timeouts** — use deterministic clock or condition checks instead

## Code Quality Gates

- **TypeScript strict mode** enabled (no `any`, no implicit `any`)
- **ESLint** passes on all source files
- **Test coverage** > 85% for core modules (`/kernel/src/`)
- **No `console.log` in production code** (tests & demos okay)
- **All dependencies pinned** to exact versions (no `^`, no `~`)

## How Kiro Specs & Steering Work Here

- **specs/** — formal requirements (14 reqs), detailed design (8 algorithms), 80 implementation tasks
- **steering/** — this file (tech stack) + product.md (framing) + conventions.md (code style)
- **hooks/** — automation: pre-commit spec validation, post-task-complete notifications
- Kiro agent uses all three to guide implementation and catch deviations early
