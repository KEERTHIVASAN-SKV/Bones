/**
 * Version-vector tests (KER-011 to KER-014).
 * The VV helpers live in utils.ts (clone, merge, update, compare, serialize); vv.ts adds only
 * advanceContiguous (KER-013) and stableFrontier. Property tests are seeded, 200 runs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  cloneVersionVector,
  compareVersionVectors,
  deserializeVersionVector,
  mergeVersionVectors,
  serializeVersionVector,
  stableStringify,
  updateVersionVector,
} from '../src/utils.js';
import type { VersionVector } from '../src/types.js';
import { advanceContiguous, stableFrontier } from '../src/vv.js';

const RUNS = { seed: 12345, numRuns: 200 } as const;
const IDS = ['a', 'b', 'c', 'd.0', 'e.1'] as const;

/** A random version vector: positive integers only, any subset of IDS. */
const vvArb: fc.Arbitrary<VersionVector> = fc
  .array(fc.tuple(fc.constantFrom(...IDS), fc.integer({ min: 1, max: 20 })), { maxLength: 8 })
  .map((entries) => new Map(entries));

const vv = (o: Record<string, number>): VersionVector => new Map(Object.entries(o));
const entries = (m: VersionVector): Array<[string, number]> => [...m.entries()].sort();
const get = (m: VersionVector, id: string): number => m.get(id) ?? 0;
const isLE = (x: VersionVector, y: VersionVector): boolean => {
  const r = compareVersionVectors(x, y);
  return r === 'before' || r === 'equal';
};

describe('KER-011: clone, merge, update return new objects and never mutate inputs', () => {
  it('cloneVersionVector returns an equal, independent copy', () => {
    const original = vv({ a: 3, b: 5 });
    const copy = cloneVersionVector(original);
    expect(copy).not.toBe(original);
    expect(entries(copy)).toEqual(entries(original));
    copy.set('a', 99);
    copy.set('z', 1);
    expect(entries(original)).toEqual([['a', 3], ['b', 5]]);
  });

  it('mergeVersionVectors is the component-wise maximum, in a new object (seeded property)', () => {
    fc.assert(
      fc.property(vvArb, vvArb, (x, y) => {
        const xBefore = entries(x);
        const yBefore = entries(y);
        const merged = mergeVersionVectors(x, y);
        expect(merged).not.toBe(x);
        expect(merged).not.toBe(y);
        for (const id of IDS) expect(get(merged, id)).toBe(Math.max(get(x, id), get(y, id)));
        expect(entries(x)).toEqual(xBefore);
        expect(entries(y)).toEqual(yBefore);
      }),
      RUNS
    );
  });

  it('updateVersionVector changes only the named entry, never lowers it, and ALWAYS returns a new object', () => {
    const original = vv({ a: 3, b: 5 });
    const raised = updateVersionVector(original, 'a', 7);
    expect(raised).not.toBe(original);
    expect(entries(raised)).toEqual([['a', 7], ['b', 5]]);
    const unchanged = updateVersionVector(original, 'a', 1); // lower value: max semantics keeps 3
    expect(unchanged).not.toBe(original);
    expect(entries(unchanged)).toEqual([['a', 3], ['b', 5]]);
    const added = updateVersionVector(original, 'c', 2);
    expect(entries(added)).toEqual([['a', 3], ['b', 5], ['c', 2]]);
    expect(entries(original)).toEqual([['a', 3], ['b', 5]]); // input untouched
  });
});

describe('KER-012: partial order and concurrency (compareVersionVectors)', () => {
  it('is transitive: A <= B and B <= C implies A <= C (seeded property)', () => {
    fc.assert(
      fc.property(vvArb, vvArb, vvArb, (a, b, c) => {
        if (isLE(a, b) && isLE(b, c)) expect(isLE(a, c)).toBe(true);
      }),
      { ...RUNS, numRuns: 500 }
    );
  });

  it('is reflexive and antisymmetric, and merge is an upper bound of both inputs', () => {
    fc.assert(
      fc.property(vvArb, vvArb, (a, b) => {
        expect(compareVersionVectors(a, a)).toBe('equal');
        if (isLE(a, b) && isLE(b, a)) expect(compareVersionVectors(a, b)).toBe('equal');
        const m = mergeVersionVectors(a, b);
        expect(isLE(a, m)).toBe(true);
        expect(isLE(b, m)).toBe(true);
      }),
      RUNS
    );
  });

  it('identifies incomparable vectors as concurrent, and agrees with before/after', () => {
    expect(compareVersionVectors(vv({ a: 2 }), vv({ b: 1 }))).toBe('concurrent');
    expect(compareVersionVectors(vv({ a: 2, b: 1 }), vv({ a: 1, b: 2 }))).toBe('concurrent');
    expect(compareVersionVectors(vv({ a: 1 }), vv({ a: 2, b: 1 }))).toBe('before');
    expect(compareVersionVectors(vv({ a: 2, b: 1 }), vv({ a: 1 }))).toBe('after');
    fc.assert(
      fc.property(vvArb, vvArb, (a, b) => {
        const r = compareVersionVectors(a, b);
        const flipped = compareVersionVectors(b, a);
        const expected = { equal: 'equal', before: 'after', after: 'before', concurrent: 'concurrent' }[r];
        expect(flipped).toBe(expected);
      }),
      RUNS
    );
  });
});

describe('KER-013: advanceContiguous', () => {
  it('advances only to the NEXT sequence number', () => {
    const start = vv({ a: 2 });
    const next = advanceContiguous(start, 'a', 3);
    expect(entries(next)).toEqual([['a', 3]]);
    expect(next).not.toBe(start);
    expect(entries(start)).toEqual([['a', 2]]); // input untouched
  });

  it('treats a missing entry as 0, so seq 1 is the first valid advance', () => {
    expect(entries(advanceContiguous(new Map(), 'a', 1))).toEqual([['a', 1]]);
  });

  it('never skips: a gap leaves the VV unchanged (same object)', () => {
    const start = vv({ a: 2 });
    expect(advanceContiguous(start, 'a', 4)).toBe(start);
    expect(advanceContiguous(start, 'a', 100)).toBe(start);
    const empty: VersionVector = new Map();
    expect(advanceContiguous(empty, 'a', 2)).toBe(empty);
  });

  it('never regresses: re-delivering an old or current seq leaves the VV unchanged (same object)', () => {
    const start = vv({ a: 5 });
    expect(advanceContiguous(start, 'a', 5)).toBe(start);
    expect(advanceContiguous(start, 'a', 4)).toBe(start);
    expect(advanceContiguous(start, 'a', 1)).toBe(start);
  });

  it('only changes the named replica', () => {
    const next = advanceContiguous(vv({ a: 2, b: 7 }), 'a', 3);
    expect(entries(next)).toEqual([['a', 3], ['b', 7]]);
  });

  it('closing a gap advances step by step: 2 arrives after 1, 3 after 2, 4 is blocked until 3', () => {
    let v: VersionVector = new Map();
    v = advanceContiguous(v, 'a', 2); // gap
    expect(get(v, 'a')).toBe(0);
    v = advanceContiguous(v, 'a', 1);
    expect(get(v, 'a')).toBe(1);
    v = advanceContiguous(v, 'a', 3); // gap again
    expect(get(v, 'a')).toBe(1);
    v = advanceContiguous(v, 'a', 2);
    v = advanceContiguous(v, 'a', 3);
    v = advanceContiguous(v, 'a', 4);
    expect(get(v, 'a')).toBe(4);
  });

  it('property: over any sequence of attempts the entry never decreases and never rises by more than 1', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 60 }), (attempts) => {
        let v: VersionVector = new Map();
        for (const seq of attempts) {
          const before = get(v, 'a');
          v = advanceContiguous(v, 'a', seq);
          const after = get(v, 'a');
          expect(after).toBeGreaterThanOrEqual(before);
          expect(after - before === 0 || after - before === 1).toBe(true);
          if (after !== before) expect(seq).toBe(before + 1);
        }
      }),
      RUNS
    );
  });

  it('property: delivering seq 1..N in ANY order, retrying until stable, ends exactly at N', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(Array.from({ length: 15 }, (_, i) => i + 1), { minLength: 15, maxLength: 15 }), (order) => {
        // Models the orchestrator's buffer: an op that cannot advance the VV yet is retried later.
        let v: VersionVector = new Map();
        let pending = [...order];
        let progressed = true;
        while (pending.length > 0 && progressed) {
          progressed = false;
          const still: number[] = [];
          for (const seq of pending) {
            const next = advanceContiguous(v, 'a', seq);
            if (next !== v) {
              v = next;
              progressed = true;
            } else {
              still.push(seq);
            }
          }
          pending = still;
        }
        expect(pending).toEqual([]);
        expect(get(v, 'a')).toBe(15);
      }),
      RUNS
    );
  });
});

describe('KER-014: deterministic serialization and cloning', () => {
  it('serializes identically whatever order the entries were inserted in', () => {
    const one = new Map<string, number>([['zeta', 1], ['alpha', 2], ['mid.0', 3]]);
    const two = new Map<string, number>([['mid.0', 3], ['zeta', 1], ['alpha', 2]]);
    expect(JSON.stringify(serializeVersionVector(one))).toBe(JSON.stringify(serializeVersionVector(two)));
    expect(Object.keys(serializeVersionVector(one))).toEqual(['alpha', 'mid.0', 'zeta']);
  });

  it('is deterministic for integer-like replica IDs too (JavaScript emits those in numeric order)', () => {
    const one = new Map<string, number>([['10', 1], ['9', 2]]);
    const two = new Map<string, number>([['9', 2], ['10', 1]]);
    expect(JSON.stringify(serializeVersionVector(one))).toBe(JSON.stringify(serializeVersionVector(two)));
  });

  it('orders keys by code unit, never by locale ("B" before "a")', () => {
    const v = new Map<string, number>([['a', 1], ['B', 2], ['_', 3]]);
    expect(Object.keys(serializeVersionVector(v))).toEqual(['B', '_', 'a']);
  });

  it('round-trips exactly (seeded property), with sorted, deterministic JSON', () => {
    fc.assert(
      fc.property(vvArb, (original) => {
        const plain = serializeVersionVector(original);
        const restored = deserializeVersionVector(plain);
        expect(entries(restored)).toEqual(entries(original));
        const json = stableStringify(plain);
        expect(stableStringify(serializeVersionVector(deserializeVersionVector(JSON.parse(json))))).toBe(json);
      }),
      RUNS
    );
  });
});

describe('stableFrontier: component-wise minimum, missing entry = 0', () => {
  it('takes the minimum per replica', () => {
    const f = stableFrontier([vv({ a: 5, b: 3 }), vv({ a: 2, b: 9 }), vv({ a: 4, b: 4 })]);
    expect(entries(f)).toEqual([['a', 2], ['b', 3]]);
  });

  it('treats a replica missing from any VV as 0, and omits zero entries', () => {
    expect(entries(stableFrontier([vv({ a: 5, b: 3 }), vv({ a: 2 })]))).toEqual([['a', 2]]);
    expect(entries(stableFrontier([vv({ a: 5 }), new Map()]))).toEqual([]);
  });

  it('a single VV is its own frontier (as a new object)', () => {
    const only = vv({ a: 2, b: 1 });
    const f = stableFrontier([only]);
    expect(entries(f)).toEqual(entries(only));
    expect(f).not.toBe(only);
  });

  it('with no VVs nothing is stable: the frontier is empty', () => {
    expect(entries(stableFrontier([]))).toEqual([]);
  });

  it('equals the brute-force minimum, is below every input, and is monotone (seeded property)', () => {
    fc.assert(
      fc.property(fc.array(vvArb, { minLength: 1, maxLength: 5 }), vvArb, (vvs, bump) => {
        const f = stableFrontier(vvs);
        for (const id of IDS) expect(get(f, id)).toBe(Math.min(...vvs.map((v) => get(v, id))));
        for (const v of vvs) expect(isLE(f, v)).toBe(true);
        // raising every input never lowers the frontier
        const raised = vvs.map((v) => mergeVersionVectors(v, bump));
        expect(isLE(f, stableFrontier(raised))).toBe(true);
      }),
      RUNS
    );
  });

  it('does not mutate its inputs', () => {
    const a = vv({ a: 5, b: 3 });
    const b = vv({ a: 2 });
    stableFrontier([a, b]);
    expect(entries(a)).toEqual([['a', 5], ['b', 3]]);
    expect(entries(b)).toEqual([['a', 2]]);
  });
});
