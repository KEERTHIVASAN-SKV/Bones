/**
 * CRDT class tests: the applyOp pipeline (design.md Algorithm 3) and the local operations.
 * Fencing is a stub (accepts everything) until membership exists, so it is not tested here.
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '../src/crdt.js';
import { assertValidOperation, createOpId, deserializeOp, serializeOp } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';

const values = (c: CRDT<string>): string => c.getSequence().map((e) => e.value).join('');
const vvOf = (c: CRDT<string>): Array<[string, number]> => [...c.getVV().entries()].sort();

describe('CRDT construction', () => {
  it('starts empty with an empty version vector, log and clock', () => {
    const c = new CRDT<string>('site1.0');
    expect(c.replicaId).toBe('site1.0');
    expect(c.getSequence()).toEqual([]);
    expect(vvOf(c)).toEqual([]);
    expect(c.getOps()).toEqual([]);
    expect(c.getPendingCount()).toBe(0);
    expect(c.getLamportClock()).toBe(0);
  });

  it('rejects replica IDs that cannot be part of an Op ID', () => {
    expect(() => new CRDT('')).toThrow(TypeError);
    expect(() => new CRDT('a:b')).toThrow(TypeError);
    expect(() => new CRDT('has space')).toThrow(TypeError);
    expect(() => new CRDT('site1.2')).not.toThrow();
  });
});

describe('local insert', () => {
  it('returns a valid operation with seq = vv[self] + 1 and lamport = clock + 1', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    const b = c.insert(a.id, 'B');
    expect(a).toMatchObject({ id: 'r1:1', type: 'insert', anchor: undefined, value: 'A', lamport: 1, replicaId: 'r1' });
    expect(b).toMatchObject({ id: 'r1:2', type: 'insert', anchor: 'r1:1', value: 'B', lamport: 2, replicaId: 'r1' });
    expect(() => assertValidOperation(a)).not.toThrow();
    expect(deserializeOp(serializeOp(b))).toEqual(b);
    expect(vvOf(c)).toEqual([['r1', 2]]);
    expect(c.getLamportClock()).toBe(2);
    expect(values(c)).toBe('AB');
  });

  it('applies the operation to itself through the same pipeline: it is in the log', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    expect(c.getOps()).toEqual([a]);
  });

  it('inserting after A in the middle of CAT lands right after A, before T (CAXT)', () => {
    const c = new CRDT<string>('r1');
    const cOp = c.insert(undefined, 'C');
    const aOp = c.insert(cOp.id, 'A');
    c.insert(aOp.id, 'T');
    c.insert(aOp.id, 'X');
    expect(values(c)).toBe('CAXT');
  });

  it('inserting at HEAD puts the new element first', () => {
    const c = new CRDT<string>('r1');
    c.insert(undefined, 'B');
    c.insert(undefined, 'A');
    expect(values(c)).toBe('AB');
  });

  it('refuses an unknown anchor, changes nothing and does not consume a sequence number', () => {
    const c = new CRDT<string>('r1');
    expect(() => c.insert(createOpId('nobody', 1), 'x')).toThrow(RangeError);
    expect(c.getSequence()).toEqual([]);
    expect(vvOf(c)).toEqual([]);
    expect(c.insert(undefined, 'ok').id).toBe('r1:1');
  });

  it('can anchor on a deleted element (a tombstone is a valid anchor)', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    c.delete(a.id);
    c.insert(a.id, 'B');
    expect(values(c)).toBe('B');
  });
});

describe('local delete', () => {
  it('tombstones the element and returns a valid delete operation', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    const d = c.delete(a.id);
    expect(d).toMatchObject({ id: 'r1:2', type: 'delete', target: 'r1:1', lamport: 2, replicaId: 'r1' });
    expect(() => assertValidOperation(d)).not.toThrow();
    expect(values(c)).toBe('');
    expect(c.isElementDeleted(a.id)).toBe(true);
    expect(vvOf(c)).toEqual([['r1', 2]]);
  });

  it('refuses an unknown element and does not consume a sequence number', () => {
    const c = new CRDT<string>('r1');
    expect(() => c.delete(createOpId('nobody', 1))).toThrow(RangeError);
    expect(c.insert(undefined, 'ok').id).toBe('r1:1');
  });

  it('deleting an already deleted element is allowed: a logged no-op that still advances the VV', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    c.delete(a.id);
    const again = c.delete(a.id);
    expect(again.id).toBe('r1:3');
    expect(vvOf(c)).toEqual([['r1', 3]]);
    expect(c.getOps()).toHaveLength(3);
  });

  it('isElementDeleted is false for live and unknown elements', () => {
    const c = new CRDT<string>('r1');
    const a = c.insert(undefined, 'A');
    expect(c.isElementDeleted(a.id)).toBe(false);
    expect(c.isElementDeleted(createOpId('nobody', 1))).toBe(false);
  });
});

describe('applyOp: pipeline', () => {
  /** r1 types C, A, T then inserts X after A. Returns the four operations. */
  function author(): Operation<string>[] {
    const r = new CRDT<string>('r1');
    const c = r.insert(undefined, 'C');
    const a = r.insert(c.id, 'A');
    const t = r.insert(a.id, 'T');
    const x = r.insert(a.id, 'X');
    return [c, a, t, x];
  }

  it('applies a ready remote operation', () => {
    const [c] = author();
    const r2 = new CRDT<string>('r2');
    const res = r2.applyOp(c);
    expect(res).toEqual({ status: 'applied', changed: true, unblocked: [], fenced: [] });
    expect(values(r2)).toBe('C');
    expect(vvOf(r2)).toEqual([['r1', 1]]);
    expect(r2.getOps()).toEqual([c]);
  });

  it('suppresses duplicates: the second delivery changes nothing', () => {
    const [c] = author();
    const r2 = new CRDT<string>('r2');
    r2.applyOp(c);
    const res = r2.applyOp(c);
    expect(res.status).toBe('duplicate');
    expect(res.changed).toBe(false);
    expect(values(r2)).toBe('C');
    expect(r2.getOps()).toHaveLength(1);
  });

  it('treats the echo of its own operation as a duplicate', () => {
    const r1 = new CRDT<string>('r1');
    const op = r1.insert(undefined, 'A');
    expect(r1.applyOp(op).status).toBe('duplicate');
    expect(r1.getSequence()).toHaveLength(1);
  });

  it('buffers an op that arrives before its predecessor seq, without advancing the VV', () => {
    const [c, a] = author();
    const r2 = new CRDT<string>('r2');
    const res = r2.applyOp(a); // r1:2 before r1:1
    expect(res).toEqual({ status: 'buffered', changed: false, unblocked: [], fenced: [] });
    expect(vvOf(r2)).toEqual([]);
    expect(r2.getPendingCount()).toBe(1);
    expect(r2.getSequence()).toEqual([]);

    const res2 = r2.applyOp(c);
    expect(res2.status).toBe('applied');
    expect(res2.unblocked).toEqual([a.id]);
    expect(vvOf(r2)).toEqual([['r1', 2]]);
    expect(r2.getPendingCount()).toBe(0);
    expect(values(r2)).toBe('CA');
  });

  it('buffers on a sequence gap ALONE: both ops anchor at HEAD, so only the missing seq blocks the second', () => {
    const r1 = new CRDT<string>('r1');
    const first = r1.insert(undefined, 'a'); // r1:1
    const second = r1.insert(undefined, 'b'); // r1:2, anchor also HEAD: nothing but the seq blocks it
    const r2 = new CRDT<string>('r2');
    expect(r2.applyOp(second).status).toBe('buffered');
    expect(vvOf(r2)).toEqual([]); // the VV must not skip to 2
    expect(r2.getSequence()).toEqual([]);
    const res = r2.applyOp(first);
    expect(res).toMatchObject({ status: 'applied', unblocked: [second.id] });
    expect(vvOf(r2)).toEqual([['r1', 2]]);
    expect(values(r2)).toBe('ba'); // b is newer, so it comes first under HEAD
  });

  it('buffers a delete on a sequence gap alone: its target exists but an earlier op from the author is missing', () => {
    const r1 = new CRDT<string>('r1');
    const a = r1.insert(undefined, 'A');
    const r2 = new CRDT<string>('r2');
    r2.applyOp(a);
    const b = r2.insert(undefined, 'B'); // r2:1
    const del = r2.delete(a.id); // r2:2: target r1:1 exists everywhere, only r2:1 is missing
    const r3 = new CRDT<string>('r3');
    r3.applyOp(a);
    expect(r3.applyOp(del).status).toBe('buffered');
    expect(r3.isElementDeleted(a.id)).toBe(false); // not applied early
    expect(r3.applyOp(b).unblocked).toEqual([del.id]);
    expect(r3.isElementDeleted(a.id)).toBe(true);
  });

  it('re-delivery of an op that is waiting in the buffer is a duplicate, not a second buffering', () => {
    const r1 = new CRDT<string>('r1');
    const a = r1.insert(undefined, 'A');
    const b = r1.insert(a.id, 'B');
    const r2 = new CRDT<string>('r2');
    expect(r2.applyOp(b).status).toBe('buffered');
    expect(r2.applyOp(b).status).toBe('duplicate');
    expect(r2.getPendingCount()).toBe(1);
    expect(r2.applyOp(a).unblocked).toEqual([b.id]); // applied exactly once
    expect(values(r2)).toBe('AB');
  });

  it('buffers an insert whose anchor from ANOTHER author has not arrived, and applies it when it does', () => {
    const [c] = author();
    const r2 = new CRDT<string>('r2');
    r2.applyOp(c);
    const child = r2.insert(c.id, 'Y'); // r2:1 anchored on r1:1
    const r3 = new CRDT<string>('r3');
    expect(r3.applyOp(child).status).toBe('buffered'); // r2:1 is the next seq, but its anchor r1:1 is unknown
    expect(vvOf(r3)).toEqual([]); // buffered ops never advance the VV
    const res = r3.applyOp(c);
    expect(res.unblocked).toEqual([child.id]);
    expect(values(r3)).toBe('CY');
    expect(vvOf(r3)).toEqual([['r1', 1], ['r2', 1]]);
  });

  it('delete before insert: buffers the delete, then applies both and converges', () => {
    const r1 = new CRDT<string>('r1');
    const ins = r1.insert(undefined, 'A');
    const r2 = new CRDT<string>('r2');
    r2.applyOp(ins);
    const del = r2.delete(ins.id);

    const r3 = new CRDT<string>('r3');
    expect(r3.applyOp(del).status).toBe('buffered'); // target r1:1 not applied yet
    expect(r3.getPendingCount()).toBe(1);
    const res = r3.applyOp(ins);
    expect(res).toMatchObject({ status: 'applied', unblocked: [del.id] });
    expect(values(r3)).toBe('');
    expect(r3.isElementDeleted(ins.id)).toBe(true);
    r1.applyOp(del);
    expect(vvOf(r3)).toEqual(vvOf(r1));
  });

  it('unblocks a long reverse-delivered chain with an iterative queue and reports the order', () => {
    const r1 = new CRDT<string>('r1');
    const ops: Operation<string>[] = [];
    let prev: OpIdKey | undefined;
    for (let i = 0; i < 6; i++) {
      const op = r1.insert(prev, `v${i}`);
      ops.push(op);
      prev = op.id;
    }
    const r2 = new CRDT<string>('r2');
    for (let i = ops.length - 1; i >= 1; i--) expect(r2.applyOp(ops[i]).status).toBe('buffered');
    const res = r2.applyOp(ops[0]);
    expect(res.status).toBe('applied');
    expect(res.unblocked).toEqual(ops.slice(1).map((o) => o.id));
    expect(r2.getPendingCount()).toBe(0);
    expect(values(r2)).toBe('v0v1v2v3v4v5');
  });

  it('a no-op delete is applied, logged and advances the VV, so later ops from that author are NOT stalled', () => {
    const r1 = new CRDT<string>('r1');
    const x = r1.insert(undefined, 'X');
    const r2 = new CRDT<string>('r2');
    const r3 = new CRDT<string>('r3');
    r2.applyOp(x);
    r3.applyOp(x);
    const d2 = r2.delete(x.id); // r2:1
    const d3 = r3.delete(x.id); // r3:1 : concurrent delete of the same element
    const later = r3.insert(undefined, 'later'); // r3:2 depends on r3:1 having been applied

    const r4 = new CRDT<string>('r4');
    r4.applyOp(x);
    r4.applyOp(d2);
    const noop = r4.applyOp(d3); // second delete of X: changes nothing
    expect(noop).toMatchObject({ status: 'applied', changed: false });
    expect(vvOf(r4)).toEqual([['r1', 1], ['r2', 1], ['r3', 1]]); // VV advanced anyway
    expect(r4.getOps().map((o) => o.id)).toContain(d3.id); // and it is logged

    const res = r4.applyOp(later);
    expect(res.status).toBe('applied'); // not buffered forever
    expect(r4.getPendingCount()).toBe(0);
    expect(values(r4)).toBe('later');
  });

  it('rejects malformed operations with a TypeError and leaves the state untouched', () => {
    const r2 = new CRDT<string>('r2');
    const good = new CRDT<string>('r1').insert(undefined, 'A');
    const bads: unknown[] = [
      null,
      42,
      { ...good, replicaId: 'r9' }, // replicaId does not match the id
      { ...good, id: 'garbage' },
      { ...good, type: 'update' },
      { ...good, lamport: -1 },
      { ...good, target: 'r1:1' }, // insert with a target
    ];
    for (const bad of bads) expect(() => r2.applyOp(bad as Operation<string>)).toThrow(TypeError);
    expect(r2.getSequence()).toEqual([]);
    expect(vvOf(r2)).toEqual([]);
    expect(r2.getPendingCount()).toBe(0);
    expect(r2.getOps()).toEqual([]);
  });
});

describe('Lamport clock absorption (what makes the RGA ordering correct)', () => {
  it('after applying a remote op with a high lamport, a local insert at HEAD goes FIRST', () => {
    const remote = new CRDT<string>('r9');
    let op: Operation<string> = remote.insert(undefined, 'r0');
    for (let i = 1; i < 5; i++) op = remote.insert(op.id, `r${i}`); // lamport climbs to 5
    expect(op.lamport).toBe(5);

    const local = new CRDT<string>('a');
    const first = local.applyOp(remote.getOps()[0]);
    expect(first.status).toBe('applied');
    for (const o of remote.getOps().slice(1)) local.applyOp(o);
    expect(local.getLamportClock()).toBe(5); // absorbed: max(0, op.lamport)

    const mine = local.insert(undefined, 'mine');
    expect(mine.lamport).toBe(6); // clock + 1, higher than everything seen
    expect(local.getSequence()[0].value).toBe('mine'); // newest sibling under HEAD comes first (insert at index 0 lands at 0)
  });

  it('a buffered operation does not move the clock; it is absorbed when the op is finally applied', () => {
    const r1 = new CRDT<string>('r1');
    const a = r1.insert(undefined, 'A');
    const b = r1.insert(a.id, 'B');
    const r2 = new CRDT<string>('r2');
    r2.applyOp(b); // buffered
    expect(r2.getLamportClock()).toBe(0);
    r2.applyOp(a);
    expect(r2.getLamportClock()).toBe(2);
  });

  it('a duplicate does not move the clock', () => {
    const r1 = new CRDT<string>('r1');
    const a = r1.insert(undefined, 'A');
    const r2 = new CRDT<string>('r2');
    r2.applyOp(a);
    const before = r2.getLamportClock();
    r2.applyOp(a);
    expect(r2.getLamportClock()).toBe(before);
  });

  it('without absorption the invariant would break: a local insert must be newer than every applied op', () => {
    const r1 = new CRDT<string>('r1');
    const ops: Operation<string>[] = [];
    let prev: OpIdKey | undefined;
    for (let i = 0; i < 4; i++) {
      const op = r1.insert(prev, `v${i}`);
      ops.push(op);
      prev = op.id;
    }
    const r2 = new CRDT<string>('r2');
    for (const op of ops) r2.applyOp(op);
    const mine = r2.insert(undefined, 'head');
    for (const op of ops) expect(mine.lamport).toBeGreaterThan(op.lamport);
  });
});

describe('queries return copies', () => {
  it('getSequence elements cannot be used to corrupt the CRDT', () => {
    const c = new CRDT<string>('r1');
    c.insert(undefined, 'A');
    const seq = c.getSequence();
    seq[0].value = 'HACKED';
    seq[0].deleted = true;
    seq.pop();
    expect(values(c)).toBe('A');
  });

  it('getVV and getOps return copies', () => {
    const c = new CRDT<string>('r1');
    c.insert(undefined, 'A');
    c.getVV().set('r1', 99);
    c.getVV().set('zzz', 1);
    c.getOps().pop();
    expect(vvOf(c)).toEqual([['r1', 1]]);
    expect(c.getOps()).toHaveLength(1);
  });
});

describe('events', () => {
  it('emits sequenceChanged for local operations', () => {
    const c = new CRDT<string>('r1');
    let n = 0;
    c.on('sequenceChanged', () => n++);
    const a = c.insert(undefined, 'A');
    c.delete(a.id);
    expect(n).toBe(2);
  });

  it('emits sequenceChanged ONCE per applyOp even when it unblocks many operations', () => {
    const r1 = new CRDT<string>('r1');
    const ops: Operation<string>[] = [];
    let prev: OpIdKey | undefined;
    for (let i = 0; i < 5; i++) {
      const op = r1.insert(prev, `v${i}`);
      ops.push(op);
      prev = op.id;
    }
    const r2 = new CRDT<string>('r2');
    let n = 0;
    r2.on('sequenceChanged', () => n++);
    for (let i = ops.length - 1; i >= 1; i--) r2.applyOp(ops[i]); // all buffered: no event
    expect(n).toBe(0);
    r2.applyOp(ops[0]); // applies 5 ops
    expect(n).toBe(1);
  });

  it('does not emit for duplicates or no-op deletes, but does for a real change', () => {
    const r1 = new CRDT<string>('r1');
    const x = r1.insert(undefined, 'X');
    const r2 = new CRDT<string>('r2');
    const r3 = new CRDT<string>('r3');
    r2.applyOp(x);
    r3.applyOp(x);
    const d2 = r2.delete(x.id);
    const d3 = r3.delete(x.id);
    const r4 = new CRDT<string>('r4');
    r4.applyOp(x);
    r4.applyOp(d2);
    let n = 0;
    r4.on('sequenceChanged', () => n++);
    r4.applyOp(d3); // no-op delete
    r4.applyOp(d3); // duplicate
    r4.applyOp(r1.insert(x.id, 'later-seq-gap-test')); // r1:2: ready, this one DOES change the sequence
    expect(n).toBe(1);
  });

  it('off() removes a listener', () => {
    const c = new CRDT<string>('r1');
    let n = 0;
    const cb = () => n++;
    c.on('sequenceChanged', cb);
    c.insert(undefined, 'A');
    c.off('sequenceChanged', cb);
    c.insert(undefined, 'B');
    expect(n).toBe(1);
  });
});

describe('scale', () => {
  it('10,000 sequential inserts delivered in REVERSE order do not overflow the stack or take seconds', () => {
    const src = new CRDT<number>('r1');
    const ops: Operation<number>[] = [];
    let prev: OpIdKey | undefined;
    for (let i = 0; i < 10_000; i++) {
      const op = src.insert(prev, i);
      ops.push(op);
      prev = op.id;
    }
    const dst = new CRDT<number>('r2');
    const t0 = Date.now();
    for (let i = ops.length - 1; i >= 0; i--) dst.applyOp(ops[i]);
    const elapsed = Date.now() - t0;
    expect(dst.getPendingCount()).toBe(0);
    expect(dst.getVV().get('r1')).toBe(10_000);
    const seq = dst.getSequence();
    expect(seq).toHaveLength(10_000);
    expect(seq[0].value).toBe(0);
    expect(seq[9_999].value).toBe(9_999);
    expect(elapsed).toBeLessThan(3000); // rescanning the buffer after every op took ~20 s
  });
});
