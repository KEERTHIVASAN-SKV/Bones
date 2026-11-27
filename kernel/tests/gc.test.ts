/**
 * Stage 1 GC: payload reclamation (KER-023, KER-026; requirements.md section 12; design.md
 * Algorithm 6). Only the PAYLOAD goes; the structural node stays and keeps working as an anchor.
 */

import { describe, it, expect } from 'vitest';
import { performStage1GC } from '../src/gc.js';
import { applyDelete, applyInsert, createRGA, getSequence, traverse } from '../src/rga.js';
import type { RGAState } from '../src/rga.js';
import { createOpId, estimatePayloadSize } from '../src/utils.js';
import type { OpIdKey, Operation, VersionVector } from '../src/types.js';

const ins = <T>(r: string, seq: number, anchor: OpIdKey | undefined, lamport: number, value: T): Operation<T> => ({
  id: createOpId(r, seq),
  type: 'insert',
  anchor,
  value,
  lamport,
  replicaId: r,
});
const del = <T>(r: string, seq: number, target: OpIdKey, lamport: number): Operation<T> => ({
  id: createOpId(r, seq),
  type: 'delete',
  target,
  lamport,
  replicaId: r,
});
const vv = (entries: Record<string, number>): VersionVector => new Map(Object.entries(entries));

/** a:1 "alpha", a:2 "beta" (after a:1), a:3 "gamma" (after a:2); all live. */
function threeLive(): RGAState<string> {
  const rga = createRGA<string>();
  applyInsert(rga, ins('a', 1, undefined, 1, 'alpha'));
  applyInsert(rga, ins('a', 2, createOpId('a', 1), 2, 'beta'));
  applyInsert(rga, ins('a', 3, createOpId('a', 2), 3, 'gamma'));
  return rga;
}
const A1 = createOpId('a', 1);
const A2 = createOpId('a', 2);
const A3 = createOpId('a', 3);

describe('performStage1GC: what is reclaimed (KER-023)', () => {
  it('reclaims a deleted element once ITS DELETE is at or below the frontier, and only then', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    applyDelete(rga, del('b', 2, A2, 5));
    const result = performStage1GC(rga, vv({ b: 1 })); // b:1 is stable, b:2 is not

    expect(result.reclaimed).toEqual([A1]);
    expect(rga.elements.get(A1)?.payloadReclaimed).toBe(true);
    expect(rga.elements.get(A1)?.value).toBeUndefined();
    expect(rga.elements.get(A2)?.payloadReclaimed).toBe(false);
    expect(rga.elements.get(A2)?.value).toBe('beta'); // deleted, but its delete is not stable yet
  });

  it('the boundary is exact: seq equal to the frontier is stable, one above is not', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 3, A1, 4));
    expect(performStage1GC(rga, vv({ b: 2 })).reclaimed).toEqual([]);
    expect(performStage1GC(rga, vv({ b: 3 })).reclaimed).toEqual([A1]);
  });

  it('never reclaims a LIVE element, even when its insert is far below the frontier', () => {
    const rga = threeLive();
    const result = performStage1GC(rga, vv({ a: 100, b: 100 }));
    expect(result.reclaimed).toEqual([]);
    expect(result.bytesReclaimed).toBe(0);
    expect(getSequence(rga).map((e) => e.value)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('a stable INSERT is not enough: the DELETE must be stable', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    // the frontier covers every insert (a:3) but not the delete (b:1)
    expect(performStage1GC(rga, vv({ a: 3 })).reclaimed).toEqual([]);
    expect(rga.elements.get(A1)?.value).toBe('alpha');
  });

  it('judges the delete by ITS author: a frontier entry for another replica does not count', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 5, A1, 4));
    expect(performStage1GC(rga, vv({ a: 50, c: 50 })).reclaimed).toEqual([]);
  });

  it('never reclaims a live element even if the delete bookkeeping is inconsistent (a stable "delete" recorded for a live one)', () => {
    const rga = threeLive();
    rga.deleteOps.set(A1, new Set([createOpId('b', 1)])); // corrupt: a:1 is live but a delete is recorded
    let result: ReturnType<typeof performStage1GC> | undefined;
    expect(() => {
      result = performStage1GC(rga, vv({ b: 5 }));
    }).not.toThrow();
    expect(result?.reclaimed).toEqual([]);
    expect(rga.elements.get(A1)?.value).toBe('alpha');
  });

  it('never reclaims a tombstone it has no recorded delete for: no evidence of a stable delete, no reclaim', () => {
    const rga = threeLive();
    const element = rga.elements.get(A1)!;
    element.deleted = true; // flagged deleted, but no delete op was ever recorded for it
    element.deletedAt = createOpId('b', 1);
    expect(performStage1GC(rga, vv({ b: 99, a: 99 })).reclaimed).toEqual([]);
    expect(element.value).toBe('alpha');
    expect(element.payloadReclaimed).toBe(false);
  });

  it('an empty frontier reclaims nothing', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    expect(performStage1GC(rga, new Map()).reclaimed).toEqual([]);
  });

  it('reclaims when ANY of several deletes is stable, whatever the order they were applied in', () => {
    for (const order of [['stable', 'unstable'], ['unstable', 'stable']] as const) {
      const rga = threeLive();
      const deletes = { stable: del<string>('b', 1, A1, 4), unstable: del<string>('c', 9, A1, 5) };
      for (const which of order) applyDelete(rga, deletes[which]);
      expect(performStage1GC(rga, vv({ b: 1 })).reclaimed).toEqual([A1]);
    }
  });

  it('counts a NO-OP delete (the element was already deleted) as one of the deletes', () => {
    const rga = threeLive();
    expect(applyDelete(rga, del('b', 1, A1, 4))).toBe(true); // this one deletes it, but is not stable
    expect(applyDelete(rga, del('c', 1, A1, 5))).toBe(false); // this one is a no-op, and IS stable
    expect(performStage1GC(rga, vv({ c: 1 })).reclaimed).toEqual([A1]);
  });

  it('reclaims several elements in one pass and reports each exactly once', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    applyDelete(rga, del('b', 2, A2, 5));
    applyDelete(rga, del('b', 3, A3, 6));
    const result = performStage1GC(rga, vv({ b: 3 }));
    expect([...result.reclaimed].sort()).toEqual([A1, A2, A3]);
    expect(new Set(result.reclaimed).size).toBe(3);
  });

  it('is idempotent: running again with the same frontier reclaims nothing and counts no bytes', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    const first = performStage1GC(rga, vv({ b: 1 }));
    const second = performStage1GC(rga, vv({ b: 1 }));
    expect(first.reclaimed).toEqual([A1]);
    expect(second).toEqual({ reclaimed: [], bytesReclaimed: 0 });
  });

  it('picks up elements that become reclaimable later, as the frontier advances', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    applyDelete(rga, del('b', 2, A2, 5));
    expect(performStage1GC(rga, vv({ b: 1 })).reclaimed).toEqual([A1]);
    expect(performStage1GC(rga, vv({ b: 2 })).reclaimed).toEqual([A2]);
  });

  it('does not change the frontier it is given', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    const frontier = vv({ b: 1 });
    performStage1GC(rga, frontier);
    expect([...frontier]).toEqual([['b', 1]]);
  });

  it('does nothing at all to an RGA with nothing to reclaim (same element objects, same flags)', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    const before = traverse(rga).map((e) => ({ ...e }));
    performStage1GC(rga, vv({ b: 0 }));
    expect(traverse(rga).map((e) => ({ ...e }))).toEqual(before);
  });
});

describe('performStage1GC: bytes (KER-023, KER-026)', () => {
  it('counts the estimated size of each reclaimed payload exactly once', () => {
    const rga = threeLive();
    applyDelete(rga, del('b', 1, A1, 4));
    applyDelete(rga, del('b', 2, A2, 5));
    const result = performStage1GC(rga, vv({ b: 2 }));
    expect(result.bytesReclaimed).toBe(estimatePayloadSize('alpha') + estimatePayloadSize('beta'));
    expect(result.bytesReclaimed).toBe(7 + 6); // JSON length: the quotes count
  });

  it('measures structured payloads such as a stroke made of points', () => {
    const rga = createRGA<unknown>();
    const stroke = { points: Array.from({ length: 50 }, (_, i) => [i, i * 2]), color: '#f0f' };
    applyInsert(rga, ins<unknown>('a', 1, undefined, 1, stroke));
    applyDelete(rga, del<unknown>('b', 1, A1, 2));
    const result = performStage1GC(rga, vv({ b: 1 }));
    expect(result.bytesReclaimed).toBe(JSON.stringify(stroke).length);
    expect(result.bytesReclaimed).toBeGreaterThan(300);
  });

  it('an element with no payload left (it arrived redacted) is still marked reclaimed, for 0 bytes', () => {
    const rga = createRGA<string>();
    const bare: Operation<string> = { id: A1, type: 'insert', lamport: 1, replicaId: 'a' }; // no value
    applyInsert(rga, bare);
    applyDelete(rga, del('b', 1, A1, 2));
    const result = performStage1GC(rga, vv({ b: 1 }));
    expect(result).toEqual({ reclaimed: [A1], bytesReclaimed: 0 });
    expect(rga.elements.get(A1)?.payloadReclaimed).toBe(true);
  });
});
