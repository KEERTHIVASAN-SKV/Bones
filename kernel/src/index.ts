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
  GCStats,
  Snapshot,
  MembershipView,
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
} from './utils.js';

// Event emitter
export { EventEmitter } from './events.js';

// Main CRDT class (to be implemented in later tasks)
// export { CRDT } from './crdt.js';
