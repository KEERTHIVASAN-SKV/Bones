/**
 * Deterministic utility functions for the CRDT Kernel.
 *
 * Rules:
 * - No Math.random(), Date.now(), or any non-deterministic operations
 * - String comparison only (no localeCompare)
 * - Immutable: return new objects, never mutate input
 */

import type { Element, Operation, OpIdKey, VersionVector } from './types.js';

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
 * Compute the causality relationship between two version vectors.
 * A missing entry counts as 0.
 *
 * Returns:
 * - "equal": every component is equal
 * - "before": vv1 < vv2 (vv1 ≤ vv2 in all components, strictly less in at least one)
 * - "after": vv1 > vv2 (vv1 ≥ vv2 in all components, strictly greater in at least one)
 * - "concurrent": neither dominates the other
 *
 * @param vv1 - First version vector
 * @param vv2 - Second version vector
 * @returns Causality relationship
 */
export function compareVersionVectors(
  vv1: VersionVector,
  vv2: VersionVector
): 'equal' | 'before' | 'after' | 'concurrent' {
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

  if (isLessOrEqual && isGreaterOrEqual) return 'equal';
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

// ---------------------------------------------------------------------------
// Serialization, indexing, and size estimation (KER-005)
// ---------------------------------------------------------------------------

/** Code-unit string comparison (never localeCompare). */
function compareStrings(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively copy a JSON-compatible value with object keys sorted by code unit
 * and `undefined` properties removed, so equal values always stringify identically.
 *
 * Objects are copied onto null-prototype objects so a `"__proto__"` key in the
 * input stays an ordinary own property.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value instanceof Map || value instanceof Set) {
    // JSON.stringify would turn these into `{}`, silently losing data. Convert first.
    throw new TypeError('stableStringify: Map and Set are not JSON-compatible; convert them first');
  }
  if (value !== null && typeof value === 'object') {
    const withToJSON = value as { toJSON?: () => unknown };
    if (typeof withToJSON.toJSON === 'function') {
      return canonicalize(withToJSON.toJSON());
    }
    const source = value as Record<string, unknown>;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort(compareStrings)) {
      const child = source[key];
      if (child !== undefined) {
        out[key] = canonicalize(child);
      }
    }
    return out;
  }
  return value;
}

/** True if `x` is a string in canonical OpIdKey form with a positive integer seq. */
function isOpIdKey(x: unknown): x is OpIdKey {
  if (typeof x !== 'string') return false;
  const parsed = parseOpId(x as OpIdKey);
  return parsed !== null && isValidSequence(parsed.seq);
}

/**
 * Deterministic JSON: object keys are sorted by code unit at every nesting level and
 * `undefined` object properties are omitted, so equal values always produce the
 * identical string (Property 16). Array order is preserved.
 *
 * The value must be JSON-compatible (plain objects, arrays, strings, finite numbers,
 * booleans, null). Convert `Map`/`Set` to plain objects/arrays first.
 *
 * @param value - Value to serialize
 * @returns Canonical JSON string
 * @throws TypeError if the value contains a Map or Set, or is not serializable (e.g. `undefined`)
 */
export function stableStringify(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  if (json === undefined) {
    throw new TypeError('stableStringify: value is not JSON-serializable');
  }
  return json;
}

/**
 * Serialize an operation to deterministic JSON (see {@link stableStringify}).
 * Two equal operations always produce the identical string. `op.value` must be
 * JSON-compatible.
 *
 * @param op - Operation to serialize
 * @returns Canonical JSON string
 * @throws TypeError if `op.value` contains a Map or Set
 */
export function serializeOp<T>(op: Operation<T>): string {
  return stableStringify(op);
}

/**
 * Parse and validate an operation from JSON. This is a trust boundary (operations
 * arrive from the network), so the structure is checked, not just cast.
 *
 * Validated: `id` is a canonical OpIdKey; `replicaId` equals the replica part of `id`;
 * `type` is 'insert' or 'delete'; `lamport` is a non-negative integer; an insert has
 * no `target` and any `anchor` is a valid OpIdKey; a delete has a valid `target` and
 * no `anchor`; `epoch`, if present, is a non-negative integer.
 *
 * @param json - JSON produced by {@link serializeOp}
 * @returns The parsed operation
 * @throws Error if the JSON is malformed or the operation structure is invalid
 */
export function deserializeOp<T = unknown>(json: string): Operation<T> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('deserializeOp: expected a JSON object');
  }
  const o = parsed as Record<string, unknown>;

  if (!isOpIdKey(o.id)) {
    throw new Error('deserializeOp: invalid or missing "id"');
  }
  const idParts = parseOpId(o.id);
  if (typeof o.replicaId !== 'string' || idParts === null || o.replicaId !== idParts.replicaId) {
    throw new Error('deserializeOp: "replicaId" must match the replica part of "id"');
  }
  if (o.type !== 'insert' && o.type !== 'delete') {
    throw new Error('deserializeOp: "type" must be "insert" or "delete"');
  }
  if (typeof o.lamport !== 'number' || !Number.isInteger(o.lamport) || o.lamport < 0) {
    throw new Error('deserializeOp: "lamport" must be a non-negative integer');
  }
  if (o.epoch !== undefined && (typeof o.epoch !== 'number' || !Number.isInteger(o.epoch) || o.epoch < 0)) {
    throw new Error('deserializeOp: "epoch" must be a non-negative integer');
  }
  if (o.type === 'insert') {
    if (o.target !== undefined) throw new Error('deserializeOp: insert must not have "target"');
    if (o.anchor !== undefined && !isOpIdKey(o.anchor)) {
      throw new Error('deserializeOp: invalid "anchor"');
    }
  } else {
    if (o.anchor !== undefined) throw new Error('deserializeOp: delete must not have "anchor"');
    if (!isOpIdKey(o.target)) throw new Error('deserializeOp: delete requires a valid "target"');
  }

  return parsed as Operation<T>;
}

/**
 * Build a map from element ID to its index in an element array.
 *
 * @param elements - Elements in sequence order (e.g. the depth-first RGA traversal)
 * @returns New Map from OpIdKey to array index
 */
export function buildOpIndex<T>(elements: readonly Element<T>[]): Map<OpIdKey, number> {
  const index = new Map<OpIdKey, number>();
  for (let i = 0; i < elements.length; i++) {
    index.set(elements[i].id, i);
  }
  return index;
}

/**
 * Rough size estimate of a payload: length of its JSON string (UTF-16 code units).
 * Deterministic; used only for GC statistics, never for algorithm decisions.
 *
 * @param value - Payload (JSON-compatible)
 * @returns 0 for undefined/null/non-serializable values, otherwise the JSON length
 */
export function estimatePayloadSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}
