/**
 * Log redaction (decision D-A, KER-023): when Stage 1 GC reclaims an element's payload, the
 * matching insert operation in the log loses its `value` too, so the memory is really freed and
 * `opsSince` no longer hands the payload to a late tab.
 */

import { describe, it, expect } from 'vitest';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import { appendOp, createOpLog, getAllOps, logLength, redactReclaimedPayloads, replayLog } from '../src/oplog.js';
import { getSequence, traverse } from '../src/rga.js';

const ins = (r: string, seq: number, anchor: OpIdKey | undefined, lamport: number, value: string): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'insert',
  anchor,
  value,
  lamport,
  replicaId: r,
});
const del = (r: string, seq: number, target: OpIdKey, lamport: number): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'delete',
  target,
  lamport,
  replicaId: r,
});

/** A log with: a1 (insert "alpha"), a2 (insert "beta" after a1), b1 (delete a1), a3 (delete a2). */
function sampleLog() {
  const a1 = ins('a', 1, undefined, 1, 'alpha');
  const a2 = ins('a', 2, a1.id, 2, 'beta');
  const b1 = del('b', 1, a1.id, 3);
  const a3 = del('a', 3, a2.id, 4);
  const log = createOpLog<string>();
  for (const op of [a1, a2, b1, a3]) appendOp(log, op);
  return { log, a1, a2, b1, a3 };
}

describe('redactReclaimedPayloads', () => {
  it('drops the value of the named insert ops, keeping id, anchor, lamport, author and type', () => {
    const { log, a1, a2 } = sampleLog();
    expect(redactReclaimedPayloads(log, [a1.id])).toBe(1);
    const [first, second] = getAllOps(log);
    expect(first).toEqual({ id: a1.id, type: 'insert', anchor: undefined, lamport: 1, replicaId: 'a' });
    expect('value' in first).toBe(false);
    expect(second).toEqual(a2); // untouched
    expect(second.value).toBe('beta');
  });

  it('keeps the log length, the order and every other entry exactly as they were', () => {
    const { log, a1, a2, b1, a3 } = sampleLog();
    redactReclaimedPayloads(log, [a1.id, a2.id]);
    expect(logLength(log)).toBe(4);
    expect(getAllOps(log).map((o) => o.id)).toEqual([a1.id, a2.id, b1.id, a3.id]);
    expect(getAllOps(log)[2]).toBe(b1); // delete ops are the very same objects
    expect(getAllOps(log)[3]).toBe(a3);
  });

  it('REPLACES the entry instead of editing it: an op object held elsewhere keeps its payload', () => {
    const { log, a1 } = sampleLog();
    redactReclaimedPayloads(log, [a1.id]);
    expect(a1.value).toBe('alpha'); // e.g. an operation the app already queued for sending
    expect(getAllOps(log)[0]).not.toBe(a1);
  });

  it('is idempotent: a second call redacts nothing and changes nothing', () => {
    const { log, a1 } = sampleLog();
    expect(redactReclaimedPayloads(log, [a1.id])).toBe(1);
    const snapshot = getAllOps(log);
    expect(redactReclaimedPayloads(log, [a1.id])).toBe(0);
    getAllOps(log).forEach((op, i) => expect(op).toBe(snapshot[i]));
  });

  it('returns 0 and leaves the log alone for an empty list, an unknown id, or a delete op id', () => {
    const { log, b1 } = sampleLog();
    const before = getAllOps(log);
    expect(redactReclaimedPayloads(log, [])).toBe(0);
    expect(redactReclaimedPayloads(log, [createOpId('zzz', 9)])).toBe(0);
    expect(redactReclaimedPayloads(log, [b1.id])).toBe(0);
    getAllOps(log).forEach((op, i) => expect(op).toBe(before[i]));
  });

  it('accepts any iterable, including a Set, and counts each redacted op once even if listed twice', () => {
    const { log, a1, a2 } = sampleLog();
    expect(redactReclaimedPayloads(log, new Set([a1.id, a2.id]))).toBe(2);
    const again = sampleLog();
    expect(redactReclaimedPayloads(again.log, [again.a1.id, again.a1.id])).toBe(1);
  });

  it('does not count an insert that never had a value (already redacted on arrival)', () => {
    const log = createOpLog<string>();
    const bare: Operation<string> = { id: createOpId('r', 1), type: 'insert', lamport: 1, replicaId: 'r' };
    appendOp(log, bare);
    expect(redactReclaimedPayloads(log, [bare.id])).toBe(0);
    expect(getAllOps(log)[0]).toBe(bare);
  });

  it('keeps the duplicate-detection set: a redacted op id is still "seen"', () => {
    const { log, a1 } = sampleLog();
    redactReclaimedPayloads(log, [a1.id]);
    expect(appendOp(log, a1)).toBe(false);
    expect(logLength(log)).toBe(4);
  });

  it('a redacted log still replays to the same VISIBLE sequence and the same tree shape', () => {
    const full = sampleLog();
    const redacted = sampleLog();
    redactReclaimedPayloads(redacted.log, [redacted.a1.id, redacted.a2.id]);
    const fullRga = replayLog(full.log);
    const redactedRga = replayLog(redacted.log);
    expect(getSequence(redactedRga)).toEqual(getSequence(fullRga)); // both empty: everything is deleted
    expect(traverse(redactedRga).map((e) => [e.id, e.anchor, e.lamport, e.deleted])).toEqual(
      traverse(fullRga).map((e) => [e.id, e.anchor, e.lamport, e.deleted])
    );
    expect(traverse(redactedRga).every((e) => e.value === undefined)).toBe(true);
  });
});
