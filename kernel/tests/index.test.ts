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
    ]) {
      expect(typeof fn).toBe('function');
    }
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
