/**
 * Core type definitions for the CRDT Kernel.
 *
 * Key principles:
 * - OpIdKey is ALWAYS a string in the format `${replicaId}:${seq}` (never an object)
 * - Immutability default: return new objects; document any copy-on-write (COW) patterns
 * - All types are immutable from the perspective of the data structure
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
 * @template T The value type stored in the CRDT
 */
export interface Operation<T = unknown> {
  /** Canonical operation ID (format: `${replicaId}:${seq}`) */
  id: OpIdKey;

  /** Type of operation: insert or delete */
  type: 'insert' | 'delete';

  /** For insert: the OpIdKey of the element after which this is inserted (undefined = head) */
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
   * Epoch number (informational only, not used for fencing).
   * Used for diagnostics and observability; fencing is determined by membership + cutoff.
   */
  epoch?: number;
}

/**
 * Represents an element in the replicated sequence.
 * Each element is immutable; modifications create new sequences.
 *
 * @template T The value type
 */
export interface Element<T = unknown> {
  /** Canonical operation ID of this element */
  id: OpIdKey;

  /** Lamport timestamp from the original insert operation */
  lamport: number;

  /** The stored value (may be undefined if deleted or for tombstones) */
  value?: T;

  /** Whether this element has been deleted (tombstone exists) */
  deleted: boolean;

  /**
   * OpIdKey of the delete operation that tombstoned this element.
   * Only set if deleted === true.
   */
  deletedAt?: OpIdKey;

  /**
   * Whether the payload has been garbage-collected (reclaimed).
   * If true, value is permanently lost but structural presence remains for ordering.
   */
  payloadReclaimed: boolean;
}

/**
 * Version Vector: immutable map from replicaId to max sequence number seen.
 *
 * Used for causal ordering, snapshot identification, and stable frontier computation.
 * Each replica's sequence is monotonically non-decreasing.
 *
 * Example: `{ "replica-1": 42, "replica-2": 18 }` means we have seen
 * operations up to replica-1:42 and replica-2:18.
 */
export type VersionVector = Map<string, number>;

/**
 * Membership view: set of active replica IDs.
 *
 * Updated by membership operations (join/evict).
 * Used for fencing: operations from non-member replicas are rejected unless causally prior.
 *
 * Immutable: return new Set on modifications.
 */
export type MembershipSet = Set<string>;

/**
 * Membership epoch: a contiguous range of active replicas with a numeric epoch identifier.
 * Used for diagnostics and can be referenced in operations.
 *
 * Fencing is NOT determined by epoch — it's determined by membership + cutoff.
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
  /** Total tombstones created */
  tombstoneCount: number;

  /** Payloads reclaimed */
  payloadsReclaimed: number;

  /** Bytes saved by reclamation (estimate) */
  bytesSaved: number;

  /** Replicas evicted from membership */
  replicasEvicted: number;

  /** Current stable frontier (min of active members' last seen op) */
  stableFrontier: VersionVector;
}

/**
 * Snapshot: a complete, serializable copy of CRDT state.
 *
 * Used for:
 * - Persistence (save to IndexedDB or file)
 * - Rejoins (snapshot + delta from stable frontier)
 * - Cloning
 *
 * Immutable from user perspective (all fields readonly or deeply frozen).
 */
export interface Snapshot<T = unknown> {
  /** All elements in sequence order */
  elements: readonly Element<T>[];

  /** Version vector at snapshot time */
  vv: VersionVector;

  /** Active membership at snapshot time */
  membership: MembershipSet;

  /** Lamport clock value at snapshot time */
  lamportClock: number;

  /** Replica ID of the CRDT instance that created this snapshot */
  replicaId: string;

  /** Timestamp in milliseconds (for observability; NOT used in algorithms) */
  createdAt: number;

  /** If this snapshot is a rejoin snapshot, the stable frontier from the coordinator */
  stableFrontier?: VersionVector;
}

/**
 * Membership view: combines active members and evicted members (for diagnostics).
 *
 * Active members: replicas whose operations we accept without further causal checks.
 * Evicted members: replicas that were removed; we accept their ops only if causally prior.
 */
export interface MembershipView {
  /** Active replica IDs (members we fully trust) */
  activeMembers: MembershipSet;

  /** Evicted replica IDs (members we've exorcised; still accept causal ops) */
  evictedMembers: Map<string, number>; // replicaId → seq at eviction

  /** Current epoch number */
  epoch: number;
}
