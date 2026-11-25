/**
 * Dependency buffer for out-of-order operations (design.md Algorithm 3; requirements.md 6).
 *
 * An operation is buffered while it is not READY: an earlier op from the same author is not
 * applied yet, or its anchor (insert) / target (delete) is not applied yet. The buffer never
 * drops an operation on its own. The only removals are:
 * - "now ready": handed back to the caller to be applied;
 * - "now fenced": the author was evicted while the op waited; reported to the caller
 *   (an explicit rejection, not a silent loss).
 *
 * Unblocking is targeted. Only two things can make a waiting op ready, and each has a direct
 * lookup, so draining a long chain costs O(k) instead of rescanning the whole buffer after every
 * applied op (which measured about 20 s for 10,000 ops):
 *   1. the author's NEXT sequence number -> `buffer.ops.get(<author>:<seq + 1>)`
 *   2. ops waiting for the element an applied insert created -> `buffer.waiting.get(<id>)`
 *
 * This module knows nothing about the RGA or the version vector: readiness and fencing are
 * supplied by the caller as predicates.
 */

import type { OpIdKey, Operation, OperationBuffer, VersionVector } from './types.js';
import { createOpId, parseOpId } from './utils.js';

/**
 * Upper bound on how many missing sequence numbers `refreshMissing` lists per replica.
 * A peer can claim any sequence number (e.g. 2,000,000,000); without a cap, listing "everything
 * between the VV and that op" would allocate billions of entries.
 */
export const DEFAULT_MISSING_LIMIT = 1000;

/** Predicates the caller supplies when draining the buffer. */
export interface BufferChecks<T> {
  /** True if the op can be applied now (previous seq applied, anchor/target present). */
  isReady(op: Operation<T>): boolean;
  /** True if the op must be rejected now (author not active and beyond its cutoff). */
  isFenced(op: Operation<T>): boolean;
}

/**
 * Create an empty buffer.
 *
 * @returns A new OperationBuffer
 */
export function createOperationBuffer<T>(): OperationBuffer<T> {
  return { ops: new Map(), missing: new Map(), waiting: new Map() };
}

/** The element an op needs to exist before it can apply: an insert's anchor, a delete's target. */
function dependencyOf<T>(op: Operation<T>): OpIdKey | undefined {
  return op.type === 'insert' ? op.anchor : op.target;
}

/** Remove an op from the `waiting` index (and drop the entry if it becomes empty). */
function unindex<T>(buffer: OperationBuffer<T>, op: Operation<T>): void {
  const dependency = dependencyOf(op);
  if (dependency === undefined) return;
  const waiters = buffer.waiting.get(dependency);
  if (waiters === undefined) return;
  waiters.delete(op.id);
  if (waiters.size === 0) buffer.waiting.delete(dependency);
}

/**
 * Buffer an operation that is not ready, and index the element it is waiting for (if that
 * element has not been applied yet) so applying that element finds this op directly.
 * Buffering the same op again keeps a single entry.
 *
 * Does NOT refresh `buffer.missing`; see {@link refreshMissing}.
 *
 * @param buffer - The buffer (mutated)
 * @param op - The operation to hold back
 * @param hasElement - True if an element with this ID is already applied
 */
export function bufferOp<T>(
  buffer: OperationBuffer<T>,
  op: Operation<T>,
  hasElement: (id: OpIdKey) => boolean
): void {
  buffer.ops.set(op.id, op);
  const dependency = dependencyOf(op);
  if (dependency === undefined || hasElement(dependency)) return;
  let waiters = buffer.waiting.get(dependency);
  if (waiters === undefined) {
    waiters = new Set();
    buffer.waiting.set(dependency, waiters);
  }
  waiters.add(op.id);
}

/**
 * After `applied` was applied, remove from the buffer and return every op it unblocked.
 *
 * Candidates are the author's next sequence number and, if `applied` was an insert, the ops
 * waiting for that new element. A candidate that is fenced is removed and its ID appended to
 * `fenced`; a candidate that is ready is removed and returned; a candidate that is still blocked
 * by its OTHER dependency stays buffered (that dependency's own trigger will reconsider it).
 *
 * @param buffer - The buffer (mutated)
 * @param applied - The operation that was just applied
 * @param checks - Readiness and fencing predicates
 * @param fenced - Receives the IDs of candidates rejected because they are now fenced
 * @returns The newly ready operations, in a deterministic order
 */
export function takeReadyFromBuffer<T>(
  buffer: OperationBuffer<T>,
  applied: Operation<T>,
  checks: BufferChecks<T>,
  fenced: OpIdKey[]
): Operation<T>[] {
  const candidates = new Set<OpIdKey>();

  const parsed = parseOpId(applied.id);
  if (parsed !== null) {
    const nextSeqId = createOpId(parsed.replicaId, parsed.seq + 1);
    if (buffer.ops.has(nextSeqId)) candidates.add(nextSeqId);
  }
  if (applied.type === 'insert') {
    const waiters = buffer.waiting.get(applied.id);
    if (waiters !== undefined) {
      for (const id of waiters) candidates.add(id);
      buffer.waiting.delete(applied.id);
    }
  }

  const ready: Operation<T>[] = [];
  for (const id of candidates) {
    const op = buffer.ops.get(id);
    if (op === undefined) continue; // stale index entry: already taken or fenced
    if (checks.isFenced(op)) {
      buffer.ops.delete(id);
      unindex(buffer, op);
      fenced.push(id);
    } else if (checks.isReady(op)) {
      buffer.ops.delete(id);
      unindex(buffer, op);
      ready.push(op);
    }
  }
  return ready;
}

/**
 * Remove and report every buffered op that is fenced. Call it when membership changes (a
 * full scan is fine: that is rare). Removing ops never makes another op ready, so no draining
 * is needed afterwards.
 *
 * @param buffer - The buffer (mutated)
 * @param isFenced - True if an op must now be rejected
 * @returns The IDs of the removed operations
 */
export function purgeFencedBuffered<T>(
  buffer: OperationBuffer<T>,
  isFenced: (op: Operation<T>) => boolean
): OpIdKey[] {
  const removed: OpIdKey[] = [];
  for (const [id, op] of buffer.ops) {
    // deleting the current entry while iterating a Map is safe
    if (isFenced(op)) {
      buffer.ops.delete(id);
      unindex(buffer, op);
      removed.push(id);
    }
  }
  return removed;
}

/**
 * Rebuild `buffer.missing`: for each replica, the sequence numbers after `vv[replica]` and
 * before its highest buffered sequence number that are not buffered. This is what a sync
 * request asks peers for.
 *
 * `missing` is a CACHE that is refreshed only when this function is called (for example when a
 * sync request is built), not on every buffer change: refreshing on every change would rescan
 * the buffer each time and make draining quadratic. It is rebuilt from scratch, so stale
 * entries never linger.
 *
 * @param buffer - The buffer (`missing` is replaced)
 * @param vv - The current version vector
 * @param limit - Max entries listed per replica (lowest first); see DEFAULT_MISSING_LIMIT
 */
export function refreshMissing<T>(
  buffer: OperationBuffer<T>,
  vv: VersionVector,
  limit: number = DEFAULT_MISSING_LIMIT
): void {
  buffer.missing.clear();

  const buffered = new Map<string, Set<number>>(); // replica -> buffered seqs above the VV
  for (const id of buffer.ops.keys()) {
    const parsed = parseOpId(id);
    if (parsed === null || parsed.seq <= (vv.get(parsed.replicaId) ?? 0)) continue;
    let seqs = buffered.get(parsed.replicaId);
    if (seqs === undefined) {
      seqs = new Set();
      buffered.set(parsed.replicaId, seqs);
    }
    seqs.add(parsed.seq);
  }

  for (const [replicaId, seqs] of buffered) {
    let highest = 0; // a loop, not Math.max(...seqs): spreading a huge set can overflow the argument limit
    for (const seq of seqs) if (seq > highest) highest = seq;
    const missing = new Set<number>();
    // Bounded: ends after `limit` missing entries or after passing the highest buffered seq;
    // buffered seqs inside the range are skipped, so iterations <= limit + buffered count.
    for (let seq = (vv.get(replicaId) ?? 0) + 1; seq < highest && missing.size < limit; seq++) {
      if (!seqs.has(seq)) missing.add(seq);
    }
    if (missing.size > 0) buffer.missing.set(replicaId, missing);
  }
}
