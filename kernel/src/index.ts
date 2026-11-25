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
  isValidReplicaId,
  isValidSequence,
  stableStringify,
  serializeOp,
  deserializeOp,
  buildOpIndex,
  estimatePayloadSize,
} from './utils.js';

// Event emitter
export { EventEmitter } from './events.js';
export type { EventType, EventCallback, EventErrorHandler } from './events.js';

// Replicated Growable Array (anchor tree)
export {
  createRGA, applyInsert, applyDelete, insert, delete_,
  getSequence, isElementDeleted, markPayloadReclaimed, traverse,
  compareSiblingKeys,
} from './rga.js';
export type { RGAState, ParentKey } from './rga.js';

// Main CRDT class (to be implemented in later tasks)
// export { CRDT } from './crdt.js';
