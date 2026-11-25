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
 * Uses only string comparison (no object conversion): plain code-unit order of the
 * whole key. This is NOT numeric seq order: `"a:10"` sorts before `"a:9"` because
 * `'1' < '9'` as characters. Never use it to order operations of one replica by seq;
 * compare the parsed `seq` numbers for that.
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
 * Max semantics: the entry becomes `max(current, seq)`, so it never decreases. Always returns a
 * NEW Map (the input is never returned or mutated), like every other function here.
 *
 * This is NOT the contiguous-prefix rule. It does not check that `seq` is the next sequence
 * number, so it must not be used to advance the VV when applying operations; use
 * `advanceContiguous` from vv.ts for that.
 *
 * @param vv - Original version vector
 * @param replicaId - Replica to update
 * @param seq - New sequence number
 * @returns New version vector with `max(current, seq)` for that replica
 */
export function updateVersionVector(
  vv: VersionVector,
  replicaId: string,
  seq: number
): VersionVector {
  const result = new Map(vv);
  result.set(replicaId, Math.max(vv.get(replicaId) ?? 0, seq));
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
 * Returns a plain object: `{ replicaId: seq, ... }`, with keys inserted in code-unit order, so
 * two equal vectors serialize identically whatever order their entries were added in.
 * (JavaScript itself always emits integer-like keys such as "9" and "10" in ascending numeric
 * order; that is still deterministic, it just is not code-unit order for such keys.)
 *
 * @param vv - Version vector
 * @returns JSON-serializable object
 */
export function serializeVersionVector(vv: VersionVector): Record<string, number> {
  // Null-prototype object so a replica ID such as "__proto__" stays an ordinary key.
  const result = Object.create(null) as Record<string, number>;
  for (const replicaId of [...vv.keys()].sort(compareStrings)) {
    result[replicaId] = vv.get(replicaId) as number;
  }
  return result;
}

/**
 * Deserialize a version vector from JSON. This is a trust boundary: entries are
 * validated, not silently dropped. An entry of 0 means "nothing applied" and is
 * omitted, exactly like a missing entry.
 *
 * @param obj - Plain object from JSON (should be `{ replicaId: seq, ... }`)
 * @returns New VersionVector Map
 * @throws TypeError if any entry is not a non-negative integer (e.g. 1.5, -1, NaN, "3", null)
 */
export function deserializeVersionVector(obj: Record<string, number>): VersionVector {
  const vv = new Map<string, number>();
  for (const [replicaId, seq] of Object.entries(obj)) {
    if (seq === 0) continue;
    if (!isValidSequence(seq)) {
      throw new TypeError(
        `deserializeVersionVector: entry for "${replicaId}" must be a positive integer, got ${String(seq)}`
      );
    }
    vv.set(replicaId, seq);
  }
  return vv;
}

/**
 * Check if replicaId is a valid identifier.
 *
 * Valid format: non-empty string of alphanumerics, hyphens, underscores and dots, which
 * covers the `${siteId}.${incarnation}` form (requirements.md 2.1), e.g. `"site1.2"`.
 * `:` is excluded because it separates the replica ID from the seq inside an OpIdKey.
 * This is a soft check for diagnostics; the kernel doesn't strictly enforce it.
 *
 * @param replicaId - Replica ID to validate
 * @returns true if valid
 */
export function isValidReplicaId(replicaId: string): boolean {
  if (!replicaId || replicaId.length === 0) return false;
  return /^[a-zA-Z0-9_.-]+$/.test(replicaId);
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
 * Check that a value is a well-formed Operation. Use it on any operation that did not come
 * through `deserializeOp` (tests, in-process peers, application code): the kernel trusts
 * `op.replicaId` for fencing, so it must really be the author named in `op.id`.
 *
 * Validated: `id` is a canonical OpIdKey; `replicaId` equals the replica part of `id`;
 * `type` is 'insert' or 'delete'; `lamport` is a non-negative integer; an insert has
 * no `target` and any `anchor` is a valid OpIdKey; a delete has a valid `target` and
 * no `anchor`; `epoch`, if present, is a non-negative integer.
 *
 * @param value - Candidate operation
 * @throws TypeError describing the first problem found
 */
export function assertValidOperation(value: unknown): asserts value is Operation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('assertValidOperation: expected an object');
  }
  const o = value as Record<string, unknown>;

  if (!isOpIdKey(o.id)) {
    throw new TypeError('assertValidOperation: invalid or missing "id"');
  }
  const idParts = parseOpId(o.id);
  if (typeof o.replicaId !== 'string' || idParts === null || o.replicaId !== idParts.replicaId) {
    throw new TypeError('assertValidOperation: "replicaId" must match the replica part of "id"');
  }
  if (o.type !== 'insert' && o.type !== 'delete') {
    throw new TypeError('assertValidOperation: "type" must be "insert" or "delete"');
  }
  if (typeof o.lamport !== 'number' || !Number.isInteger(o.lamport) || o.lamport < 0) {
    throw new TypeError('assertValidOperation: "lamport" must be a non-negative integer');
  }
  if (o.epoch !== undefined && (typeof o.epoch !== 'number' || !Number.isInteger(o.epoch) || o.epoch < 0)) {
    throw new TypeError('assertValidOperation: "epoch" must be a non-negative integer');
  }
  if (o.type === 'insert') {
    if (o.target !== undefined) throw new TypeError('assertValidOperation: insert must not have "target"');
    if (o.anchor !== undefined && !isOpIdKey(o.anchor)) {
      throw new TypeError('assertValidOperation: invalid "anchor"');
    }
  } else {
    if (o.anchor !== undefined) throw new TypeError('assertValidOperation: delete must not have "anchor"');
    if (!isOpIdKey(o.target)) throw new TypeError('assertValidOperation: delete requires a valid "target"');
  }
}

/**
 * Parse and validate an operation from JSON. This is a trust boundary (operations
 * arrive from the network), so the structure is checked, not just cast.
 * See {@link assertValidOperation} for exactly what is validated.
 *
 * @param json - JSON produced by {@link serializeOp}
 * @returns The parsed operation
 * @throws SyntaxError if the JSON is malformed
 * @throws TypeError if the operation structure is invalid
 */
export function deserializeOp<T = unknown>(json: string): Operation<T> {
  const parsed: unknown = JSON.parse(json);
  assertValidOperation(parsed);
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
