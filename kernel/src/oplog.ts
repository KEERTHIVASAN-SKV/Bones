/**
 * Operation log (KER-015 to KER-017; requirements.md section 3).
 *
 * An append-only record of the operations a replica has APPLIED, in application order.
 * Operations are appended when applied, never while they are merely buffered, and no-op
 * operations (e.g. a second concurrent delete of the same element) are appended too. The log
 * order is therefore always a valid causal order, which is what makes replay possible.
 *
 * Deduplication is by Op ID only (not by content) and is O(1) through a Set.
 * Operations are treated as immutable: the log stores the references it is given.
 */

import type { OpIdKey, Operation } from './types.js';
import { applyDelete, applyInsert, cloneRGA, createRGA } from './rga.js';
import type { RGAState } from './rga.js';

/** Append-only operation log. Use the functions in this module; do not edit the fields. */
export interface OpLog<T = unknown> {
  /** Applied operations in application order. The index is the local log sequence number. */
  readonly entries: Operation<T>[];
  /** Op IDs already in the log, for O(1) duplicate detection. */
  readonly seen: Set<OpIdKey>;
}

/**
 * Create an empty log.
 *
 * @returns A new, empty OpLog
 */
export function createOpLog<T>(): OpLog<T> {
  return { entries: [], seen: new Set() };
}

/**
 * Whether an operation is new to the log (its Op ID has not been appended before). O(1).
 *
 * @param log - The log (not modified)
 * @param op - Candidate operation
 * @returns true if appending it would add an entry; false if its Op ID is already present
 */
export function shouldAppendOp<T>(log: OpLog<T>, op: Operation<T>): boolean {
  return !log.seen.has(op.id);
}

/**
 * Append an applied operation, unless its Op ID is already in the log.
 *
 * @param log - The log (mutated)
 * @param op - An operation that has just been applied
 * @returns true if it was appended; false if it was a duplicate (the log is unchanged)
 */
export function appendOp<T>(log: OpLog<T>, op: Operation<T>): boolean {
  if (!shouldAppendOp(log, op)) return false;
  log.seen.add(op.id);
  log.entries.push(op);
  return true;
}

/**
 * Number of entries in the log.
 *
 * @param log - The log
 * @returns The log length
 */
export function logLength<T>(log: OpLog<T>): number {
  return log.entries.length;
}

/**
 * The operation at a log index (0-based, application order).
 *
 * @param log - The log
 * @param index - Log index
 * @returns The operation, or undefined if the index is out of range
 */
export function getOpAt<T>(log: OpLog<T>, index: number): Operation<T> | undefined {
  return log.entries[index];
}

/**
 * All operations in application order.
 *
 * @param log - The log
 * @returns A NEW array (reordering or truncating it cannot affect the log)
 */
export function getAllOps<T>(log: OpLog<T>): Operation<T>[] {
  return [...log.entries];
}

/**
 * The operations authored by one replica, in log order.
 *
 * @param log - The log
 * @param replicaId - Author replica ID (matched exactly)
 * @returns A new array; empty if the replica has no entries
 */
export function getOpsByReplica<T>(log: OpLog<T>, replicaId: string): Operation<T>[] {
  return log.entries.filter((op) => op.replicaId === replicaId);
}

/**
 * Drop the payload (`value`) of insert operations whose element's payload was just reclaimed by
 * Stage 1 GC (decision D-A). Id, type, anchor, lamport and author stay, so the log keeps its
 * length and order, replays to the same tree, and a peer that asks `opsSince` still gets a valid
 * operation: it just carries no payload.
 *
 * Why this is safe: a payload is only reclaimed once a delete of its element is causally stable,
 * so every active replica has already applied the insert AND the delete. A replica that joins
 * later receives the insert without a value, then the delete, and shows the same visible
 * sequence (the element is deleted, so its value was never going to be visible).
 *
 * Each redacted entry is REPLACED by a copy; the original operation object is never edited, so
 * anyone still holding it (for example a message queued for sending) keeps its payload.
 * Delete operations and inserts that have no value are left as they are.
 *
 * @param log - The log (entries are replaced in place)
 * @param ids - Element IDs (= insert Op IDs) whose payload was reclaimed
 * @returns How many entries lost a value
 */
export function redactReclaimedPayloads<T>(log: OpLog<T>, ids: Iterable<OpIdKey>): number {
  const wanted = new Set<OpIdKey>(ids);
  if (wanted.size === 0) return 0;
  let redacted = 0;
  for (let i = 0; i < log.entries.length; i++) {
    const op = log.entries[i];
    if (op.type !== 'insert' || op.value === undefined || !wanted.has(op.id)) continue;
    const copy: Operation<T> = { ...op };
    delete copy.value;
    log.entries[i] = copy;
    redacted++;
  }
  return redacted;
}

/**
 * Rebuild RGA state by applying every logged operation in order.
 *
 * Deterministic: the same log (and the same initial state) always yields the same result.
 * With `initialRGA` (e.g. restored from a snapshot) the log is replayed ON TOP of a copy of it;
 * the initial state itself is never modified.
 *
 * Precondition: the log is in causal order (guaranteed when it was filled by the orchestrator
 * as operations were applied). A log that violates it throws RangeError from the RGA, so a
 * corrupt log fails loudly instead of building a wrong state.
 *
 * @param log - The log to replay (not modified)
 * @param initialRGA - Optional starting state; defaults to an empty RGA
 * @returns A new RGA state
 * @throws RangeError if an operation's anchor or target is not present when it is replayed
 */
export function replayLog<T>(log: OpLog<T>, initialRGA?: RGAState<T>): RGAState<T> {
  const rga = initialRGA === undefined ? createRGA<T>() : cloneRGA(initialRGA);
  for (const op of log.entries) {
    if (op.type === 'insert') applyInsert(rga, op);
    else applyDelete(rga, op);
  }
  return rga;
}
