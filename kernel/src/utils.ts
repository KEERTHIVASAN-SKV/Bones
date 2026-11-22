/**
 * Deterministic utility functions for the CRDT Kernel.
 *
 * Rules:
 * - No Math.random(), Date.now(), or any non-deterministic operations
 * - String comparison only (no localeCompare)
 * - Immutable: return new objects, never mutate input
 */

import type { OpIdKey, VersionVector } from './types.js';

/**
 * Parse an OpIdKey string into its components.
 *
 * @param opId - Canonical OpIdKey (format: `${replicaId}:${seq}`)
 * @returns Object with replicaId and seq, or null if invalid
 *
 * Example: `"replica-1:42"` → `{ replicaId: "replica-1", seq: 42 }`
 */
export function parseOpId(opId: OpIdKey): { replicaId: string; seq: number } | null {
  const colonIndex = opId.lastIndexOf(':');
  if (colonIndex === -1) return null;

  const replicaId = opId.substring(0, colonIndex);
  const seqStr = opId.substring(colonIndex + 1);
  const seq = parseInt(seqStr, 10);

  if (isNaN(seq) || seq.toString() !== seqStr) {
    return null; // Invalid sequence number
  }

  return { replicaId, seq };
}

/**
 * Construct an OpIdKey from components.
 *
 * @param replicaId - The replica's identifier
 * @param seq - Sequence number
 * @returns Canonical OpIdKey string
 *
 * Example: `createOpId("replica-1", 42)` → `"replica-1:42"`
 */
export function createOpId(replicaId: string, seq: number): OpIdKey {
  return `${replicaId}:${seq}` as OpIdKey;
}

/**
 * Compare two OpIds for ordering.
 *
 * Uses only string comparison (no object conversion).
 * Lexicographic order: earlier replicaIds first, then by sequence.
 *
 * @param a - First OpIdKey
 * @param b - Second OpIdKey
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 *
 * Example: `compareOpIds("a:1", "b:1")` → -1 (because "a" < "b")
 */
export function compareOpIds(a: OpIdKey, b: OpIdKey): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compute the vector clock causality relationship between two version vectors.
 *
 * Returns:
 * - "concurrent": no causal ordering (can happen on different branches)
 * - "before": vv1 is causally before vv2 (vv1 ≤ vv2 in all components)
 * - "after": vv1 is causally after vv2 (vv1 ≥ vv2 in all components)
 *
 * @param vv1 - First version vector
 * @param vv2 - Second version vector
 * @returns Causality relationship
 */
export function compareVersionVectors(
  vv1: VersionVector,
  vv2: VersionVector
): 'before' | 'after' | 'concurrent' {
  let isLessOrEqual = true;
  let isGreaterOrEqual = true;

  // Collect all replica IDs from both vectors
  const allReplicas = new Set([...vv1.keys(), ...vv2.keys()]);

  for (const replicaId of allReplicas) {
    const seq1 = vv1.get(replicaId) ?? 0;
    const seq2 = vv2.get(replicaId) ?? 0;

    if (seq1 > seq2) isLessOrEqual = false;
    if (seq1 < seq2) isGreaterOrEqual = false;
  }

  if (isLessOrEqual && isGreaterOrEqual) {
    return 'before'; // All equal (or vv1 is empty and vv2 is empty)
  }
  if (isLessOrEqual) return 'before';
  if (isGreaterOrEqual) return 'after';
  return 'concurrent';
}

/**
 * Merge two version vectors, taking the max of each replica's sequence.
 *
 * Returns a new VersionVector; does not mutate inputs.
 *
 * @param vv1 - First version vector
 * @param vv2 - Second version vector
 * @returns New merged version vector
 *
 * Example: `{ a: 1, b: 2 }` merged with `{ a: 3, c: 1 }` → `{ a: 3, b: 2, c: 1 }`
 */
export function mergeVersionVectors(vv1: VersionVector, vv2: VersionVector): VersionVector {
  const result = new Map(vv1);
  for (const [replicaId, seq] of vv2) {
    const current = result.get(replicaId) ?? 0;
    if (seq > current) {
      result.set(replicaId, seq);
    }
  }
  return result;
}

/**
 * Update a version vector with a single replica's new sequence.
 *
 * Returns a new VersionVector if the update is needed; otherwise returns the input unchanged.
 * This allows efficient immutability checking.
 *
 * @param vv - Original version vector
 * @param replicaId - Replica to update
 * @param seq - New sequence number
 * @returns Updated version vector (new Map if changed, same if unchanged)
 */
export function updateVersionVector(
  vv: VersionVector,
  replicaId: string,
  seq: number
): VersionVector {
  const current = vv.get(replicaId) ?? 0;
  if (seq <= current) {
    return vv; // No update needed
  }
  const result = new Map(vv);
  result.set(replicaId, seq);
  return result;
}

/**
 * Clone a version vector.
 *
 * @param vv - Original version vector
 * @returns New Map with same contents
 */
export function cloneVersionVector(vv: VersionVector): VersionVector {
  return new Map(vv);
}

/**
 * Check if a version vector is empty (no replicas known).
 *
 * @param vv - Version vector to check
 * @returns true if vv has size 0
 */
export function isEmptyVersionVector(vv: VersionVector): boolean {
  return vv.size === 0;
}

/**
 * Serialize a version vector to JSON (for storage/transmission).
 *
 * Returns a plain object: `{ replicaId: seq, ... }`
 *
 * @param vv - Version vector
 * @returns JSON-serializable object
 */
export function serializeVersionVector(vv: VersionVector): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [replicaId, seq] of vv) {
    result[replicaId] = seq;
  }
  return result;
}

/**
 * Deserialize a version vector from JSON.
 *
 * @param obj - Plain object from JSON (should be `{ replicaId: seq, ... }`)
 * @returns New VersionVector Map
 */
export function deserializeVersionVector(obj: Record<string, number>): VersionVector {
  const vv = new Map<string, number>();
  for (const [replicaId, seq] of Object.entries(obj)) {
    if (typeof seq === 'number' && seq > 0) {
      vv.set(replicaId, seq);
    }
  }
  return vv;
}

/**
 * Check if replicaId is a valid identifier.
 *
 * Valid format: non-empty string with alphanumerics, hyphens, underscores.
 * This is a soft check for diagnostics; the kernel doesn't strictly enforce it.
 *
 * @param replicaId - Replica ID to validate
 * @returns true if valid
 */
export function isValidReplicaId(replicaId: string): boolean {
  if (!replicaId || replicaId.length === 0) return false;
  return /^[a-zA-Z0-9_-]+$/.test(replicaId);
}

/**
 * Check if a sequence number is valid.
 *
 * Valid: positive integer (1 or higher).
 *
 * @param seq - Sequence number
 * @returns true if valid
 */
export function isValidSequence(seq: number): boolean {
  return Number.isInteger(seq) && seq > 0;
}
