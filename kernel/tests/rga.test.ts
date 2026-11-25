/**
 * RGA tests (KER-006 to KER-010). The RGA is an anchor tree: sequence order is an
 * iterative depth-first traversal, siblings are ordered newest-first by (lamport, replicaId).
 * See design.md Algorithm 1.
 */

import { describe, it, expect } from 'vitest';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import { createRGA, applyInsert, insert, traverse } from '../src/rga.js';

/** Build an insert op by hand (replica, its seq, anchor, lamport, value). */
function ins(
  replicaId: string,
  seq: number,
  anchor: OpIdKey | undefined,
  lamport: number,
  value: string
): Operation<string> {
  return { id: createOpId(replicaId, seq), type: 'insert', anchor, value, lamport, replicaId };
}

/** Apply ops in the given order and return the visible-agnostic traversal as a string. */
function render(ops: Operation<string>[]): string {
  const rga = createRGA<string>();
  for (const op of ops) applyInsert(rga, op);
  return traverse(rga)
    .map((e) => e.value)
    .join('');
}

describe('insert (local op creation)', () => {
  it('creates an insert op with a string Op ID, anchor, and lamport = clock + 1', () => {
    const { operation, newLamport } = insert({
      replicaId: 'site.0',
      anchor: undefined,
      value: 'x',
      clock: 4,
      seq: 2,
      epoch: 7,
    });
    expect(operation).toEqual({
      id: 'site.0:3',
      type: 'insert',
      anchor: undefined,
      value: 'x',
      lamport: 5,
      replicaId: 'site.0',
      epoch: 7,
    });
    expect(newLamport).toBe(5);
  });

  it('takes named fields, so the order of the numeric fields cannot be swapped by mistake', () => {
    const a = insert({ replicaId: 'r', anchor: undefined, value: 'x', clock: 10, seq: 3, epoch: 1 });
    const b = insert({ epoch: 1, seq: 3, clock: 10, value: 'x', anchor: undefined, replicaId: 'r' });
    expect(a).toEqual(b);
    expect(a.operation.id).toBe('r:4'); // seq 3 already issued -> next is 4
    expect(a.operation.lamport).toBe(11); // clock 10 -> 11
    expect(a.operation.epoch).toBe(1);
  });
});

describe('applyInsert and traversal', () => {
  it('traverses an empty RGA as an empty sequence', () => {
    expect(traverse(createRGA<string>())).toEqual([]);
  });

  it('builds "CAT" from a chain C <- A <- T', () => {
    const c = ins('r1', 1, undefined, 1, 'C');
    const a = ins('r1', 2, c.id, 2, 'A');
    const t = ins('r1', 3, a.id, 3, 'T');
    expect(render([c, a, t])).toBe('CAT');
  });

  it('inserts X right after A in the middle of CAT, before the existing child T', () => {
    const c = ins('r1', 1, undefined, 1, 'C');
    const a = ins('r1', 2, c.id, 2, 'A');
    const t = ins('r1', 3, a.id, 3, 'T');
    // X is a later local insert anchored on A: it has the highest lamport seen so far
    const x = ins('r1', 4, a.id, 4, 'X');
    expect(render([c, a, t, x])).toBe('CAXT');
  });

  it('orders concurrent siblings newest first by lamport, regardless of arrival order', () => {
    const root = ins('r1', 1, undefined, 1, 'R');
    const older = ins('r2', 1, root.id, 2, 'o');
    const newer = ins('r3', 1, root.id, 5, 'n');
    expect(render([root, older, newer])).toBe('Rno');
    expect(render([root, newer, older])).toBe('Rno');
  });

  it('breaks lamport ties by replicaId (higher replicaId first), by code unit', () => {
    const root = ins('r1', 1, undefined, 1, 'R');
    const a = ins('a', 1, root.id, 2, 'a');
    const b = ins('b', 1, root.id, 2, 'b');
    expect(render([root, a, b])).toBe('Rba');
    expect(render([root, b, a])).toBe('Rba');
    // code-unit order: 'B' (66) < 'a' (97), so 'a' is the higher replicaId
    const upper = ins('B', 1, root.id, 2, 'U');
    const lower = ins('a', 2, root.id, 2, 'l');
    expect(render([root, upper, lower])).toBe('Rl' + 'U');
  });

  it('keeps a subtree contiguous when a newer concurrent sibling arrives (A <- B <- C, D sibling of B)', () => {
    const a = ins('r1', 1, undefined, 1, 'A');
    const b = ins('r2', 1, a.id, 2, 'B');
    const c = ins('r3', 1, b.id, 3, 'C');
    const dNewer = ins('r4', 1, a.id, 2, 'D'); // same lamport as B, higher replicaId: newer than B
    for (const order of [
      [a, b, c, dNewer],
      [a, dNewer, b, c],
      [a, b, dNewer, c],
    ]) {
      expect(render(order)).toBe('ADBC'); // B and its child C stay together
    }
  });

  it('keeps a subtree contiguous when the concurrent sibling is older', () => {
    const a = ins('r1', 1, undefined, 1, 'A');
    const b = ins('r4', 1, a.id, 2, 'B');
    const c = ins('r3', 1, b.id, 3, 'C');
    const dOlder = ins('r2', 1, a.id, 2, 'D'); // same lamport as B, lower replicaId: older than B
    for (const order of [
      [a, b, c, dOlder],
      [a, dOlder, b, c],
      [a, b, dOlder, c],
    ]) {
      expect(render(order)).toBe('ABCD');
    }
  });

  it('places roots (anchor undefined) as siblings under HEAD, newest first', () => {
    const x = ins('r1', 1, undefined, 1, 'x');
    const y = ins('r2', 1, undefined, 2, 'y');
    expect(render([x, y])).toBe('yx');
    expect(render([y, x])).toBe('yx');
  });

  it('stores the anchor on the element', () => {
    const rga = createRGA<string>();
    const root = ins('r1', 1, undefined, 1, 'R');
    const child = ins('r1', 2, root.id, 2, 'c');
    applyInsert(rga, root);
    applyInsert(rga, child);
    expect(rga.elements.get(root.id)?.anchor).toBeUndefined();
    expect(rga.elements.get(child.id)?.anchor).toBe(root.id);
    expect(rga.elements.get(child.id)).toMatchObject({ deleted: false, payloadReclaimed: false, lamport: 2 });
  });

  it('ignores a duplicate insert: returns false and does not duplicate the element', () => {
    const rga = createRGA<string>();
    const root = ins('r1', 1, undefined, 1, 'R');
    expect(applyInsert(rga, root)).toBe(true);
    expect(applyInsert(rga, root)).toBe(false);
    expect(traverse(rga)).toHaveLength(1);
    expect(rga.children.get('HEAD')).toEqual([root.id]);
  });

  it('refuses an insert whose anchor has not been applied (caller must buffer it)', () => {
    const rga = createRGA<string>();
    const orphan = ins('r1', 2, createOpId('r1', 1), 2, 'x');
    expect(() => applyInsert(rga, orphan)).toThrow(RangeError);
    expect(traverse(rga)).toEqual([]);
  });

  it('refuses a non-insert operation', () => {
    const rga = createRGA<string>();
    const del: Operation<string> = {
      id: createOpId('r1', 1),
      type: 'delete',
      target: createOpId('r2', 1),
      lamport: 1,
      replicaId: 'r1',
    };
    expect(() => applyInsert(rga, del)).toThrow(TypeError);
  });
});
