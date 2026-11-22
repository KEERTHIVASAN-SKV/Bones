/**
 * Core type definitions for the CRDT Kernel.
 *
 * Key principles:
 * - OpIdKey is ALWAYS a string in the format `${replicaId}:${seq}` (never an object)
 * - Immutability default: return new objects; document any copy-on-write (COW) patterns
 * - All types are immutable from the perspective of the data structure
 *
 * Type mapping vs. earlier drafts of design.md is recorded in `.kiro/steering/tech.md`
 * ("Type Mapping" section). This file and tech.md are the source of truth.
 */

/**
 * Canonical operation ID representation.
 *
 * Always a string in format `replicaId:seq` (e.g., "replica-1:42").
 * Used directly as Map keys, Set members, and in serialization.
 * Never convert to/from objects — this representation is final.
 */
export type OpIdKey = `${string}:${number}`;

/**
 * Represents a mutation operation in the replicated sequence.
 * Each operation is immutable after creation.
 *
 * The per-replica sequence number is the `seq` part of `id`
 * (use `parseOpId(op.id)` from utils.ts); there is no separate `seq` field.
 *
 * @template T The value type stored in the CRDT
 */
export interface Operation<T = unknown> {
  /** Canonical operation ID (format: `${replicaId}:${seq}`) */
  id: OpIdKey;

  /** Type of operation: insert or delete */
  type: 'insert' | 'delete';

  /** For insert: the OpIdKey of the element after which this is inserted (undefined = HEAD) */
  anchor?: OpIdKey;

  /** For delete: the OpIdKey of the element being deleted */
  target?: OpIdKey;

  /** For insert: the value being stored */
  value?: T;

  /** Lamport timestamp — uniquely orders operations across replicas */
  lamport: number;

  /** Replica ID of the operation author */
  replicaId: string;

  /**
   * Epoch number (informational only, NOT used for fencing).
   * Used for diagnostics and observability; edit-operation fencing is determined
   * by author membership + eviction cutoff (requirements.md §10.0).
   */
  epoch?: number;
}

/**
 * Represents an element in the replicated sequence.
 * Each element is immutable; modifications create new sequences.
 *
 * The RGA is a tree: every element hangs off its `anchor` (or off HEAD), and the
 * sequence order is a depth-first traversal of that tree with siblings ordered
 * newest-first by `(lamport, replicaId)` (design.md Algorithm 1).
 *
 * @template T The value type
 */
export interface Element<T = unknown> {
  /** Canonical operation ID of the insert that created this element */
  id: OpIdKey;

  /**
   * The element this one was inserted after (its parent in the RGA tree);
   * `undefined` means HEAD. Copied from `Operation.anchor` and never changed.
   * Required so that sibling/descendant relationships survive snapshots and GC.
   */
  anchor: OpIdKey | undefined;

  /** Lamport timestamp from the original insert operation */
  lamport: number;

  /** The stored value (undefined once the payload has been reclaimed) */
  value?: T;

  /** Whether this element has been deleted (tombstone exists) */
  deleted: boolean;

  /**
   * OpIdKey of the delete operation that tombstoned this element: the SMALLEST Op ID
   * (code-unit order) among all delete ops applied to it, so concurrent deletes give
   * the same value on every replica regardless of arrival order. Only set if deleted === true.
   */
  deletedAt?: OpIdKey;

  /**
   * Whether the payload has been garbage-collected (reclaimed).
   * If true, value is permanently lost but the structural node remains as an anchor.
   */
  payloadReclaimed: boolean;
}

/**
 * Version Vector: map from replicaId to the highest CONTIGUOUS sequence number
 * applied from that replica (contiguous prefix rule: ops 1..seq are all applied).
 * Buffered (not yet applied) operations never advance it.
 *
 * Used for causal ordering, snapshot identification, and stable frontier computation.
 * Each replica's sequence is monotonically non-decreasing.
 *
 * Example: `{ "replica-1": 42, "replica-2": 18 }` means we have applied
 * operations replica-1:1..42 and replica-2:1..18.
 */
export type VersionVector = Map<string, number>;

/**
 * Set of replica IDs.
 *
 * Immutable by convention: return a new Set on modification.
 */
export type MembershipSet = Set<string>;

/**
 * Membership epoch: a numeric epoch identifier with the active members at that epoch.
 * Used for diagnostics and control-message fencing.
 *
 * Edit-operation fencing is NOT determined by epoch — it is determined by author
 * membership + cutoff (requirements.md §10.0).
 */
export interface MembershipEpoch {
  epoch: number;
  members: MembershipSet;
  startSeq: Map<string, number>; // replicaId → seq when this epoch began
}

/**
 * Garbage collection statistics for observability.
 * Immutable snapshot taken on demand.
 */
export interface GCStats {
  /** Deleted elements currently in the structure (includes retained anchors whose payload was reclaimed) */
  tombstoneCount: number;

  /** Number of tombstones whose payload has been reclaimed (retained anchors) */
  payloadsReclaimed: number;

  /** Cumulative estimated bytes freed by payload reclamation */
  bytesSaved: number;

  /** Replicas evicted from membership */
  replicasEvicted: number;

  /** Copy of the stable frontier at the time the stats were taken (min over active members' acks) */
  stableFrontier: VersionVector;
}

/**
 * Membership view: active members, evicted members with their cutoffs, and the epoch.
 *
 * Edit-operation fencing rule: accept an op if its author is active, OR its author is
 * evicted AND `seq <= evictedMembers.get(author)`. Any other author is fenced.
 */
export interface MembershipView {
  /** Active replica IDs (members whose ops are accepted without a cutoff check) */
  activeMembers: MembershipSet;

  /**
   * Evicted replicas mapped to their CUTOFF: the highest per-replica sequence number
   * of that replica's ops that surviving members accept (computed by the coordinator
   * as the max of the survivors' contiguous applied seq for that replica).
   */
  evictedMembers: Map<string, number>;

  /** Current epoch number */
  epoch: number;
}

/**
 * Internal buffer for out-of-order operations waiting for dependencies
 * (a missing predecessor seq, a missing anchor, or a missing delete target).
 *
 * Buffered operations are never dropped and never advance the Version Vector.
 * Keyed by OpIdKey for O(1) lookup and dedup.
 */
export interface OperationBuffer<T = unknown> {
  /** Buffered ops keyed by their OpIdKey */
  readonly ops: Map<OpIdKey, Operation<T>>;

  /** Missing seq numbers per replica (for gap detection / sync requests) */
  readonly missing: Map<string, Set<number>>;

  /**
   * Index from a not-yet-applied element ID to the buffered ops that wait for it
   * (an insert's anchor, or a delete's target). Lets the drain loop find exactly the
   * ops an applied insert can unblock instead of rescanning the whole buffer.
   */
  readonly waiting: Map<OpIdKey, Set<OpIdKey>>;
}

/**
 * Snapshot: a complete, serializable copy of CRDT state.
 *
 * Used for:
 * - Persistence (save to IndexedDB or file)
 * - Rejoins (snapshot + post-snapshot ops through the normal applyOp pipeline)
 * - Cloning
 *
 * Contains no wall-clock time (kernel purity); `lamportClock` is the logical timestamp.
 * Immutable from user perspective (all fields readonly or deeply copied).
 */
export interface Snapshot<T = unknown> {
  /**
   * All elements (including tombstones) in sequence (depth-first) order.
   * Each element carries its `anchor`, so the RGA tree can be rebuilt exactly.
   */
  elements: readonly Element<T>[];

  /** Version vector at snapshot time */
  vv: VersionVector;

  /**
   * Membership at snapshot time: active members, evicted members with cutoffs, epoch.
   * Cutoffs are required so post-snapshot ops from evicted authors are fenced correctly.
   */
  membership: MembershipView;

  /** Lamport clock value at snapshot time (logical timestamp) */
  lamportClock: number;

  /** Replica ID of the CRDT instance that created this snapshot */
  replicaId: string;

  /** GC statistics at snapshot time (for the Graveyard panel; requirements.md §13.7) */
  gcStats?: GCStats;

  /** If this snapshot is a rejoin snapshot, the stable frontier from the coordinator */
  stableFrontier?: VersionVector;
}
