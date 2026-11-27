/**
 * Stage 1 GC keeps the structure (requirements.md 12.3 to 12.5) and reports honest statistics
 * (KER-026). A retained anchor has no payload but still orders its subtree, still hides from the
 * visible sequence, and still accepts new inserts.
 */

import { describe, it, expect } from 'vitest';
import { buildGCStats, performStage1GC } from '../src/gc.js';
import { applyDelete, applyInsert, createRGA, getAllElements, getSequence, traverse } from '../src/rga.js';
import type { RGAState } from '../src/rga.js';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation, VersionVector } from '../src/types.js';

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
const vv = (entries: Record<string, number>): VersionVector => new Map(Object.entries(entries));
const A1 = createOpId('a', 1);
const A2 = createOpId('a', 2);
const A3 = createOpId('a', 3);

/** a:1 "alpha" <- a:2 "beta" <- a:3 "gamma", plus a:4 "delta" also anchored on a:1 (a sibling subtree). */
function tree(): RGAState<string> {
  const rga = createRGA<string>();
  applyInsert(rga, ins('a', 1, undefined, 1, 'alpha'));
  applyInsert(rga, ins('a', 2, A1, 2, 'beta'));
  applyInsert(rga, ins('a', 3, A2, 3, 'gamma'));
  applyInsert(rga, ins('a', 4, A1, 4, 'delta'));
  return rga;
}

describe('a reclaimed element stays in the structure (requirements.md 12.3 to 12.5)', () => {
  it('keeps id, anchor, lamport, deleted flag and deletedAt; loses only the value', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    const before = { ...rga.elements.get(A1)! };
    performStage1GC(rga, vv({ b: 1 }));
    const after = rga.elements.get(A1)!;
    expect(after).toEqual({ ...before, value: undefined, payloadReclaimed: true });
    expect(after.deleted).toBe(true);
    expect(after.deletedAt).toBe(createOpId('b', 1));
  });

  it('leaves the structural order and the visible sequence exactly as they were', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    applyDelete(rga, del('b', 2, A2, 6));
    const structureBefore = traverse(rga).map((e) => e.id);
    const visibleBefore = getSequence(rga).map((e) => [e.id, e.value]);
    performStage1GC(rga, vv({ b: 2 }));
    expect(traverse(rga).map((e) => e.id)).toEqual(structureBefore);
    expect(getSequence(rga).map((e) => [e.id, e.value])).toEqual(visibleBefore);
    expect(visibleBefore).toEqual([[createOpId('a', 4), 'delta'], [A3, 'gamma']]); // a:4 is a:1's newest child, so it comes first
  });

  it('children of a reclaimed element keep their place and their payloads', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    performStage1GC(rga, vv({ b: 1 }));
    expect(rga.elements.get(A2)?.value).toBe('beta');
    expect(rga.elements.get(A3)?.value).toBe('gamma');
    expect(rga.children.get(A1)).toEqual([createOpId('a', 4), A2]); // newest first, as before
  });

  it('a reclaimed element still works as an anchor for a NEW insert, which lands right after it', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    performStage1GC(rga, vv({ b: 1 }));
    expect(applyInsert(rga, ins('c', 1, A1, 10, 'late'))).toBe(true); // concurrent insert anchored on the retained anchor
    expect(getSequence(rga).map((e) => e.value)).toEqual(['late', 'delta', 'beta', 'gamma']);
  });

  it('a delete that arrives AFTER the element was reclaimed is still applied cleanly (a no-op)', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    performStage1GC(rga, vv({ b: 1 }));
    expect(applyDelete(rga, del('c', 1, A1, 6))).toBe(false);
    expect(rga.elements.get(A1)?.payloadReclaimed).toBe(true);
    expect(rga.deleteOps.has(A1)).toBe(true); // the late delete was recorded again...
    expect(performStage1GC(rga, vv({ b: 1, c: 1 })).reclaimed).toEqual([]);
    expect(rga.deleteOps.has(A1)).toBe(false); // ...and the next GC pass sweeps it, so it cannot pile up
  });

  it('forgets the delete-op bookkeeping of a reclaimed element, and keeps it for the others', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    applyDelete(rga, del('b', 2, A2, 6));
    performStage1GC(rga, vv({ b: 1 }));
    expect(rga.deleteOps.has(A1)).toBe(false);
    expect(rga.deleteOps.get(A2)).toEqual(new Set([createOpId('b', 2)]));
  });

  it('getAllElements still lists the tombstone, flagged as reclaimed (the Graveyard panel needs it)', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    performStage1GC(rga, vv({ b: 1 }));
    const tomb = getAllElements(rga).find((e) => e.id === A1);
    expect(tomb).toMatchObject({ deleted: true, payloadReclaimed: true });
    expect(tomb?.value).toBeUndefined();
  });
});

describe('buildGCStats (KER-026)', () => {
  it('counts tombstones, reclaimed payloads, and passes the cumulative bytes and evicted count through', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    applyDelete(rga, del('b', 2, A2, 6));
    const first = performStage1GC(rga, vv({ b: 1 }));
    const stats = buildGCStats(rga, first.bytesReclaimed, 2, vv({ b: 1 }));
    expect(stats.tombstoneCount).toBe(2); // a:1 and a:2 are deleted; the reclaimed one still counts
    expect(stats.payloadsReclaimed).toBe(1);
    expect(stats.bytesSaved).toBe(first.bytesReclaimed);
    expect(stats.replicasEvicted).toBe(2);
    expect([...stats.stableFrontier]).toEqual([['b', 1]]);
  });

  it('live elements are not tombstones', () => {
    const stats = buildGCStats(tree(), 0, 0, new Map());
    expect(stats).toMatchObject({ tombstoneCount: 0, payloadsReclaimed: 0, bytesSaved: 0, replicasEvicted: 0 });
  });

  it('the tombstone count does NOT go down when payloads are reclaimed (Stage 1 keeps the structure)', () => {
    const rga = tree();
    applyDelete(rga, del('b', 1, A1, 5));
    applyDelete(rga, del('b', 2, A2, 6));
    const before = buildGCStats(rga, 0, 0, new Map()).tombstoneCount;
    performStage1GC(rga, vv({ b: 2 }));
    const after = buildGCStats(rga, 0, 0, vv({ b: 2 }));
    expect(after.tombstoneCount).toBe(before);
    expect(after.payloadsReclaimed).toBe(2);
  });

  it('returns a copy of the frontier: changing it afterwards does not change the stats, or the reverse', () => {
    const frontier = vv({ b: 1 });
    const stats = buildGCStats(tree(), 0, 0, frontier);
    frontier.set('b', 99);
    expect(stats.stableFrontier.get('b')).toBe(1);
    stats.stableFrontier.set('b', 5);
    expect(frontier.get('b')).toBe(99);
  });
});
