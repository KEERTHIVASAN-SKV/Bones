/**
 * CRDT Kernel — Public API
 *
 * This module exports all public types and classes needed to use the CRDT kernel.
 * Keep this file minimal; add new exports as modules are completed.
 */

// Core types
export type {
  OpIdKey,
  Operation,
  Element,
  VersionVector,
  MembershipSet,
  MembershipEpoch,
  MembershipView,
  OperationBuffer,
  GCStats,
  Snapshot,
} from './types.js';

// Utility functions
export {
  parseOpId,
  createOpId,
  compareOpIds,
  compareVersionVectors,
  mergeVersionVectors,
  updateVersionVector,
  cloneVersionVector,
  isEmptyVersionVector,
  serializeVersionVector,
  deserializeVersionVector,
  assertValidVersionVector,
  isValidReplicaId,
  isValidSequence,
  stableStringify,
  serializeOp,
  deserializeOp,
  assertValidOperation,
  MAX_LAMPORT,
  buildOpIndex,
  estimatePayloadSize,
} from './utils.js';

// Event emitter
export { EventEmitter } from './events.js';
export type { EventType, EventCallback, EventErrorHandler } from './events.js';

// Version-vector rules beyond the helpers in utils.ts
export {
  advanceContiguous, computeVVDifference, stableFrontier, computeStableFrontier, isCausallyStable,
} from './vv.js';

// Stage 1 garbage collection (payload reclamation; the structure stays)
export { performStage1GC, buildGCStats } from './gc.js';
export type { GCResult } from './gc.js';

// Dependency buffer for out-of-order operations
export {
  createOperationBuffer, bufferOp, takeReadyFromBuffer, purgeFencedBuffered,
  refreshMissing, DEFAULT_MISSING_LIMIT,
} from './buffer.js';
export type { BufferChecks } from './buffer.js';

// Operation log
export {
  createOpLog, appendOp, shouldAppendOp, getAllOps, getOpsByReplica,
  getOpAt, logLength, replayLog, redactReclaimedPayloads,
} from './oplog.js';
export type { OpLog } from './oplog.js';

// Replicated Growable Array (anchor tree)
export {
  createRGA, cloneRGA, applyInsert, applyDelete, insert, delete_,
  getSequence, getAllElements, isElementDeleted, markPayloadReclaimed, traverse,
  compareSiblingKeys,
} from './rga.js';
export type { RGAState, ParentKey } from './rga.js';

// Membership, epochs and fencing (edit ops by author + cutoff, control messages by epoch)
export {
  createMembership, getMembership, getEpoch, addReplica, removeReplica, applyMembershipView,
  assertValidMembershipView, isReplicaActive, getCutoff, isBeyondCutoff, isFenced,
  isControlMessageRejected, membershipToJSON, membershipFromJSON, serializeMembership,
  deserializeMembership,
} from './membership.js';
export type { MembershipJSON } from './membership.js';

// The CRDT replica (local operations, applyOp pipeline, queries, events)
export { CRDT } from './crdt.js';
export type { ApplyResult } from './crdt.js';
