/**
 * RGA delete, tombstone, query and payload-reclamation tests (KER-007, KER-008, KER-010).
 */

import { describe, it, expect } from 'vitest';
import { createOpId, stableStringify } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import {
  createRGA,
  applyInsert,
  applyDelete,
  delete_,
  getAllElements,
  getSequence,
  isElementDeleted,
  markPayloadReclaimed,
  traverse,
} from '../src/rga.js';
import type { RGAState } from '../src/rga.js';

function ins(
  replicaId: string,
  seq: number,
  anchor: OpIdKey | undefined,
  lamport: number,
  value: string
): Operation<string> {
  return { id: createOpId(replicaId, seq), type: 'insert', anchor, value, lamport, replicaId };
}

function del(replicaId: string, seq: number, target: OpIdKey, lamport: number): Operation<string> {
  return { id: createOpId(replicaId, seq), type: 'delete', target, lamport, replicaId };
}

/** RGA holding C <- A <- T from replica r1 (ids r1:1, r1:2, r1:3). */
function cat(): { rga: RGAState<string>; c: OpIdKey; a: OpIdKey; t: OpIdKey } {
  const rga = createRGA<string>();
  const c = ins('r1', 1, undefined, 1, 'C');
  const a = ins('r1', 2, c.id, 2, 'A');
  const t = ins('r1', 3, a.id, 3, 'T');
  for (const op of [c, a, t]) applyInsert(rga, op);
  return { rga, c: c.id, a: a.id, t: t.id };
}

const values = (rga: RGAState<string>): string => getSequence(rga).map((e) => e.value).join('');

describe('delete_ (local op creation)', () => {
  it('creates a delete op with a string Op ID, target, and lamport = clock + 1', () => {
    const { operation, newLamport } = delete_({
      replicaId: 'site.0',
      target: createOpId('r1', 4),
      clock: 9,
      seq: 2,
      epoch: 7,
    });
    expect(operation).toEqual({
      id: 'site.0:3',
      type: 'delete',
      target: 'r1:4',
      lamport: 10,
      replicaId: 'site.0',
      epoch: 7,
    });
    expect(newLamport).toBe(10);
  });

  it('takes the same named numeric fields as insert, in any key order', () => {
    const target = createOpId('r1', 4);
    const a = delete_({ replicaId: 'r', target, clock: 10, seq: 3, epoch: 1 });
    const b = delete_({ epoch: 1, seq: 3, clock: 10, target, replicaId: 'r' });
    expect(a).toEqual(b);
    expect(a.operation.id).toBe('r:4');
    expect(a.operation.lamport).toBe(11);
  });
});

describe('applyDelete and tombstones (KER-007)', () => {
  it('marks the element deleted without removing it, and records deletedAt', () => {
    const { rga, a } = cat();
    const d = del('r2', 1, a, 4);
    expect(applyDelete(rga, d)).toBe(true);
    const el = rga.elements.get(a)!;
    expect(el.deleted).toBe(true);
    expect(el.deletedAt).toBe(d.id);
    expect(traverse(rga)).toHaveLength(3); // the tombstone is still in the structure
  });

  it('keeps the tombstone as an anchor: its children keep their position', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    expect(values(rga)).toBe('CT'); // A hidden, T (A's child) still ordered after C
    expect(traverse(rga).map((e) => e.value).join('')).toBe('CAT');
  });

  it('places an insert anchored on a tombstone inside the tombstone subtree', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    applyInsert(rga, ins('r2', 2, a, 5, 'X')); // newest child of the deleted A: goes before T
    expect(values(rga)).toBe('CXT');
    expect(traverse(rga).map((e) => e.value).join('')).toBe('CAXT');
  });

  it('is idempotent for visible state: a second delete returns false but is still recorded', () => {
    const { rga, a } = cat();
    const first = del('r2', 1, a, 4);
    const second = del('r3', 1, a, 4);
    expect(applyDelete(rga, first)).toBe(true);
    expect(applyDelete(rga, second)).toBe(false);
    expect(values(rga)).toBe('CT');
    expect(rga.deleteOps.get(a)).toEqual(new Set([first.id, second.id]));
  });

  it('re-applying the same delete op does not change anything', () => {
    const { rga, a } = cat();
    const d = del('r2', 1, a, 4);
    applyDelete(rga, d);
    expect(applyDelete(rga, d)).toBe(false);
    expect(rga.deleteOps.get(a)).toEqual(new Set([d.id]));
    expect(rga.elements.get(a)!.deletedAt).toBe(d.id);
  });

  it('deletedAt is the SMALLEST delete Op ID whatever the arrival order', () => {
    const small = del('r2', 1, createOpId('r1', 2), 4); // "r2:1"
    const large = del('r3', 1, createOpId('r1', 2), 4); // "r3:1"
    for (const order of [[small, large], [large, small]]) {
      const { rga, a } = cat();
      for (const d of order) applyDelete(rga, d);
      expect(rga.elements.get(a)!.deletedAt).toBe(small.id);
    }
  });

  it('refuses to delete an element that has not been applied (caller must buffer)', () => {
    const rga = createRGA<string>();
    expect(() => applyDelete(rga, del('r1', 1, createOpId('r9', 9), 1))).toThrow(RangeError);
    expect(rga.deleteOps.size).toBe(0);
  });

  it('refuses a non-delete operation', () => {
    const { rga } = cat();
    expect(() => applyDelete(rga, ins('r2', 1, undefined, 9, 'x'))).toThrow(TypeError);
  });
});

describe('getSequence and isElementDeleted (KER-008)', () => {
  it('returns only non-deleted elements, in order', () => {
    const { rga, c, t } = cat();
    expect(values(rga)).toBe('CAT');
    applyDelete(rga, del('r2', 1, c, 4));
    applyDelete(rga, del('r2', 2, t, 5));
    expect(values(rga)).toBe('A');
  });

  it('returns an empty sequence when everything is deleted', () => {
    const { rga, c, a, t } = cat();
    [c, a, t].forEach((id, i) => applyDelete(rga, del('r2', i + 1, id, 4 + i)));
    expect(getSequence(rga)).toEqual([]);
  });

  it('returns copies: mutating a returned element does not change the RGA', () => {
    const { rga, c } = cat();
    const first = getSequence(rga)[0];
    first.value = 'HACKED';
    first.deleted = true;
    expect(rga.elements.get(c)!.value).toBe('C');
    expect(values(rga)).toBe('CAT');
  });

  it('reports deletion status; an unknown element is not reported as deleted', () => {
    const { rga, a, t } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    expect(isElementDeleted(rga, a)).toBe(true);
    expect(isElementDeleted(rga, t)).toBe(false);
    expect(isElementDeleted(rga, createOpId('nobody', 1))).toBe(false);
  });

  it('traverses a 50,000-element chain without a stack overflow', () => {
    const rga = createRGA<number>();
    let prev: OpIdKey | undefined;
    for (let i = 1; i <= 50_000; i++) {
      const op: Operation<number> = {
        id: createOpId('r1', i),
        type: 'insert',
        anchor: prev,
        value: i,
        lamport: i,
        replicaId: 'r1',
      };
      applyInsert(rga, op);
      prev = op.id;
    }
    const seq = getSequence(rga);
    expect(seq).toHaveLength(50_000);
    expect(seq[0].value).toBe(1);
    expect(seq[49_999].value).toBe(50_000);
  });
});

describe('getAllElements (F4): every element, tombstones included', () => {
  it('returns all elements in structural order, including deleted ones, with their anchors', () => {
    const { rga, c, a, t } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    expect(getSequence(rga).map((e) => e.value).join('')).toBe('CT');
    const all = getAllElements(rga);
    expect(all.map((e) => e.id)).toEqual([c, a, t]);
    expect(all.map((e) => e.deleted)).toEqual([false, true, false]);
    expect(all.map((e) => e.anchor)).toEqual([undefined, c, a]);
    expect(all[1].deletedAt).toBe(createOpId('r2', 1));
    expect(all[1].payloadReclaimed).toBe(false);
  });

  it('shows a reclaimed tombstone with no value and payloadReclaimed set', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    markPayloadReclaimed(rga, a);
    const tomb = getAllElements(rga).find((e) => e.id === a)!;
    expect(tomb).toMatchObject({ deleted: true, payloadReclaimed: true });
    expect(tomb.value).toBeUndefined();
  });

  it('is empty for an empty RGA, and returns copies that cannot corrupt the RGA', () => {
    expect(getAllElements(createRGA<string>())).toEqual([]);
    const { rga, c } = cat();
    const all = getAllElements(rga);
    all[0].value = 'HACKED';
    all[0].deleted = true;
    all.pop();
    expect(rga.elements.get(c)!.value).toBe('C');
    expect(getAllElements(rga)).toHaveLength(3);
    expect(values(rga)).toBe('CAT');
  });
});

describe('payload reclamation (KER-010)', () => {
  it('clears the payload of a tombstone and flags it, keeping the structural node', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    expect(markPayloadReclaimed(rga, a)).toBe(true);
    const el = rga.elements.get(a)!;
    expect(el.value).toBeUndefined();
    expect(el.payloadReclaimed).toBe(true);
    expect(el.deleted).toBe(true);
  });

  it('does not change the visible sequence or the structural order', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    const before = values(rga);
    const structureBefore = traverse(rga).map((e) => e.id);
    markPayloadReclaimed(rga, a);
    expect(values(rga)).toBe(before);
    expect(traverse(rga).map((e) => e.id)).toEqual(structureBefore);
  });

  it('a reclaimed element still works as an anchor for new inserts', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    markPayloadReclaimed(rga, a);
    applyInsert(rga, ins('r2', 2, a, 5, 'X'));
    expect(values(rga)).toBe('CXT');
  });

  it('is idempotent: reclaiming twice returns false the second time', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    expect(markPayloadReclaimed(rga, a)).toBe(true);
    expect(markPayloadReclaimed(rga, a)).toBe(false);
  });

  it('serializes deterministically and round-trips a reclaimed element without a value', () => {
    const { rga, a } = cat();
    applyDelete(rga, del('r2', 1, a, 4));
    markPayloadReclaimed(rga, a);
    const json = stableStringify(rga.elements.get(a));
    expect(json).toBe(
      '{"anchor":"r1:1","deleted":true,"deletedAt":"r2:1","id":"r1:2","lamport":2,"payloadReclaimed":true}'
    );
    expect(stableStringify(JSON.parse(json))).toBe(json);
  });

  it('refuses to reclaim a live element or an unknown one', () => {
    const { rga, t } = cat();
    expect(() => markPayloadReclaimed(rga, t)).toThrow(RangeError);
    expect(rga.elements.get(t)!.value).toBe('T');
    expect(() => markPayloadReclaimed(rga, createOpId('nobody', 1))).toThrow(RangeError);
  });
});
