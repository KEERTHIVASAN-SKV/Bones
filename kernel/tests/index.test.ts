/**
 * Public entry point test (E1). Imports from `../src/index.js`, NOT from `../src/rga.js`,
 * so it fails if an RGA export is ever dropped from the package's public API.
 */

import { describe, it, expect } from 'vitest';
import {
  createOpId,
  createRGA,
  applyInsert,
  applyDelete,
  insert,
  delete_,
  getSequence,
  isElementDeleted,
  markPayloadReclaimed,
  traverse,
  compareSiblingKeys,
  advanceContiguous,
  stableFrontier,
  cloneRGA,
  createOpLog,
  appendOp,
  shouldAppendOp,
  getAllOps,
  getOpsByReplica,
  getOpAt,
  logLength,
  replayLog,
  createOperationBuffer,
  bufferOp,
  takeReadyFromBuffer,
  purgeFencedBuffered,
  refreshMissing,
  assertValidOperation,
  MAX_LAMPORT,
  computeVVDifference,
  getAllElements,
  CRDT,
} from '../src/index.js';
import type { RGAState, ParentKey, Operation } from '../src/index.js';

describe('public API (index.ts) exposes the RGA', () => {
  it('exports every RGA function', () => {
    for (const fn of [
      createRGA,
      applyInsert,
      applyDelete,
      insert,
      delete_,
      getSequence,
      isElementDeleted,
      markPayloadReclaimed,
      traverse,
      compareSiblingKeys,
      advanceContiguous,
      stableFrontier,
      cloneRGA,
      createOpLog,
      appendOp,
      shouldAppendOp,
      getAllOps,
      getOpsByReplica,
      getOpAt,
      logLength,
      replayLog,
      createOperationBuffer,
      bufferOp,
      takeReadyFromBuffer,
      purgeFencedBuffered,
      refreshMissing,
      assertValidOperation,
      computeVVDifference,
      getAllElements,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('exports the CRDT class, and two replicas converge through the public entry point', () => {
    expect(typeof CRDT).toBe('function');
    expect(MAX_LAMPORT).toBe(2 ** 48);
    const a = new CRDT<string>('site1.0');
    const b = new CRDT<string>('site2.0');
    const c = a.insert(undefined, 'C');
    const t = a.insert(c.id, 'T');
    const x = b.applyOp(c).status === 'applied' ? b.insert(c.id, 'X') : c; // concurrent with T
    b.applyOp(t);
    a.applyOp(x);
    const text = (r: CRDT<string>): string => r.getSequence().map((e) => e.value).join('');
    expect(text(a)).toBe(text(b));
    expect(text(a)).toHaveLength(3);
  });

  it('catch-up works through the public entry point: opsSince, computeVVDifference and getAllElements', () => {
    const a = new CRDT<string>('site1.0');
    const b = new CRDT<string>('site2.0');
    const h = a.insert(undefined, 'H');
    const i = a.insert(h.id, 'i');
    a.delete(i.id);

    // b has nothing: the difference says a is ahead by 3 operations of its own
    expect(computeVVDifference(a.getVV(), b.getVV()).get('site1.0')).toEqual({ from: 1, to: 3 });
    const missing = a.opsSince(b.getVV());
    expect(missing).toHaveLength(3);
    for (const op of missing) expect(b.applyOp(op).status).toBe('applied');

    expect(computeVVDifference(a.getVV(), b.getVV()).size).toBe(0);
    expect(a.opsSince(b.getVV())).toEqual([]);
    expect(b.getSequence().map((e) => e.value)).toEqual(['H']);
    // the tombstone is visible through the public API, on both replicas
    for (const replica of [a, b]) {
      expect(replica.getAllElements().map((e) => [e.value, e.deleted])).toEqual([['H', false], ['i', true]]);
    }
  });

  it('getAllElements (RGA level) is reachable from the entry point and returns tombstones', () => {
    const rga = createRGA<string>();
    const op: Operation<string> = { id: createOpId('r1', 1), type: 'insert', value: 'x', lamport: 1, replicaId: 'r1' };
    applyInsert(rga, op);
    applyDelete(rga, { id: createOpId('r2', 1), type: 'delete', target: op.id, lamport: 2, replicaId: 'r2' });
    expect(getSequence(rga)).toEqual([]);
    expect(getAllElements(rga)).toHaveLength(1);
  });

  it('runs the CAT/A/X example through the public entry point', () => {
    const rga: RGAState<string> = createRGA<string>();
    const head: ParentKey = 'HEAD';
    expect(rga.children.has(head)).toBe(false);

    const mk = (seq: number, anchor: Operation<string>['anchor'], lamport: number, value: string): Operation<string> => ({
      id: createOpId('r1', seq),
      type: 'insert',
      anchor,
      value,
      lamport,
      replicaId: 'r1',
    });
    const c = mk(1, undefined, 1, 'C');
    const a = mk(2, c.id, 2, 'A');
    const t = mk(3, a.id, 3, 'T');
    const x = mk(4, a.id, 4, 'X'); // inserted after A, before A's existing child T
    for (const op of [c, a, t, x]) applyInsert(rga, op);

    expect(getSequence(rga).map((e) => e.value).join('')).toBe('CAXT');

    const del: Operation<string> = {
      id: createOpId('r2', 1),
      type: 'delete',
      target: a.id,
      lamport: 5,
      replicaId: 'r2',
    };
    expect(applyDelete(rga, del)).toBe(true);
    expect(isElementDeleted(rga, a.id)).toBe(true);
    expect(getSequence(rga).map((e) => e.value).join('')).toBe('CXT');
    expect(markPayloadReclaimed(rga, a.id)).toBe(true);
    expect(traverse(rga).map((e) => e.id)).toEqual([c.id, a.id, x.id, t.id]);
  });
});
