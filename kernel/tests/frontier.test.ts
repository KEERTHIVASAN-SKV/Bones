/**
 * Stable frontier computation and causal stability (KER-024, KER-025; requirements.md section 11).
 * `stableFrontier` (the plain component-wise minimum) is covered in vv.test.ts; this file covers
 * the membership-aware wrapper `computeStableFrontier` and the `isCausallyStable` check.
 */

import { describe, it, expect } from 'vitest';
import { computeStableFrontier, isCausallyStable } from '../src/vv.js';
import type { OpIdKey, VersionVector } from '../src/types.js';

const vv = (entries: Record<string, number>): VersionVector => new Map(Object.entries(entries));
const asObject = (v: VersionVector): Record<string, number> => Object.fromEntries([...v].sort());

describe('computeStableFrontier (KER-024)', () => {
  it('is the component-wise minimum over the ACTIVE members', () => {
    const acks = new Map([
      ['a', vv({ a: 5, b: 3, c: 9 })],
      ['b', vv({ a: 4, b: 3, c: 2 })],
      ['c', vv({ a: 6, b: 1, c: 7 })],
    ]);
    expect(asObject(computeStableFrontier(acks, new Set(['a', 'b', 'c'])))).toEqual({ a: 4, b: 1, c: 2 });
  });

  it('counts an active member that has not acknowledged yet as knowing nothing: the frontier is empty', () => {
    const acks = new Map([['a', vv({ a: 5 })]]);
    expect(asObject(computeStableFrontier(acks, new Set(['a', 'b'])))).toEqual({});
  });

  it('a replica missing from one member\'s ack counts as 0 for that member', () => {
    const acks = new Map([
      ['a', vv({ a: 5, z: 4 })],
      ['b', vv({ a: 5 })],
    ]);
    expect(asObject(computeStableFrontier(acks, new Set(['a', 'b'])))).toEqual({ a: 5 });
  });

  it('ignores the acks of members that are not active (an evicted member must not hold the frontier back)', () => {
    const acks = new Map([
      ['a', vv({ a: 5, b: 5 })],
      ['b', vv({ a: 5, b: 5 })],
      ['evicted', vv({ a: 1 })], // far behind, but not active
    ]);
    expect(asObject(computeStableFrontier(acks, new Set(['a', 'b'])))).toEqual({ a: 5, b: 5 });
  });

  it('an ack from a non-member cannot raise the frontier either', () => {
    const acks = new Map([['a', vv({ a: 1 })], ['stranger', vv({ a: 99 })]]);
    expect(asObject(computeStableFrontier(acks, new Set(['a'])))).toEqual({ a: 1 });
  });

  it('with no active members nothing is stable', () => {
    const acks = new Map([['a', vv({ a: 5 })]]);
    expect(asObject(computeStableFrontier(acks, new Set()))).toEqual({});
    expect(asObject(computeStableFrontier(new Map(), new Set()))).toEqual({});
  });

  it('a single active member: the frontier is its own ack', () => {
    expect(asObject(computeStableFrontier(new Map([['a', vv({ a: 3, b: 2 })]]), new Set(['a'])))).toEqual({ a: 3, b: 2 });
  });

  it('omits entries that come out as 0 and returns a fresh Map each time', () => {
    const acks = new Map([['a', vv({ a: 2, b: 0 })], ['b', vv({ a: 2 })]]);
    const first = computeStableFrontier(acks, new Set(['a', 'b']));
    expect([...first.keys()]).toEqual(['a']);
    first.set('a', 99);
    expect(asObject(computeStableFrontier(acks, new Set(['a', 'b'])))).toEqual({ a: 2 });
  });

  it('does not change its inputs', () => {
    const ackA = vv({ a: 5, b: 1 });
    const acks = new Map([['a', ackA], ['b', vv({ a: 2 })]]);
    const active = new Set(['a', 'b']);
    computeStableFrontier(acks, active);
    expect(asObject(ackA)).toEqual({ a: 5, b: 1 });
    expect([...active]).toEqual(['a', 'b']);
    expect(acks.size).toBe(2);
  });

  it('does not depend on the order the members are listed in', () => {
    const acks = new Map([['a', vv({ a: 3, b: 9 })], ['b', vv({ a: 7, b: 2 })], ['c', vv({ a: 5, b: 5 })]]);
    const one = computeStableFrontier(acks, new Set(['a', 'b', 'c']));
    const two = computeStableFrontier(new Map([...acks].reverse()), new Set(['c', 'b', 'a']));
    expect(asObject(one)).toEqual(asObject(two));
  });

  it('never exceeds any active member\'s own ack (safety: stable means everyone applied it)', () => {
    const acks = new Map([['a', vv({ a: 8, b: 4 })], ['b', vv({ a: 6, b: 9 })]]);
    const frontier = computeStableFrontier(acks, new Set(['a', 'b']));
    for (const ack of acks.values()) {
      for (const [id, seq] of frontier) expect(seq).toBeLessThanOrEqual(ack.get(id) ?? 0);
    }
  });
});

describe('isCausallyStable (KER-025)', () => {
  const frontier = vv({ a: 5, b: 2 });

  it('an op at the frontier is stable, below it is stable, above it is not', () => {
    expect(isCausallyStable('a:5' as OpIdKey, frontier)).toBe(true);
    expect(isCausallyStable('a:1' as OpIdKey, frontier)).toBe(true);
    expect(isCausallyStable('a:6' as OpIdKey, frontier)).toBe(false);
    expect(isCausallyStable('b:2' as OpIdKey, frontier)).toBe(true);
    expect(isCausallyStable('b:3' as OpIdKey, frontier)).toBe(false);
  });

  it('an op from a replica the frontier does not mention is not stable', () => {
    expect(isCausallyStable('c:1' as OpIdKey, frontier)).toBe(false);
  });

  it('compares sequence NUMBERS, not strings ("a:10" vs frontier 9, "a:9" vs frontier 10)', () => {
    expect(isCausallyStable('a:10' as OpIdKey, vv({ a: 9 }))).toBe(false);
    expect(isCausallyStable('a:9' as OpIdKey, vv({ a: 10 }))).toBe(true);
    expect(isCausallyStable('a:10' as OpIdKey, vv({ a: 10 }))).toBe(true);
  });

  it('uses the part after the LAST colon, so a replica ID is never confused with a seq', () => {
    expect(isCausallyStable('site.0:3' as OpIdKey, vv({ 'site.0': 3 }))).toBe(true);
    expect(isCausallyStable('site.0:4' as OpIdKey, vv({ 'site.0': 3 }))).toBe(false);
  });

  it('an empty frontier makes nothing stable', () => {
    expect(isCausallyStable('a:1' as OpIdKey, new Map())).toBe(false);
  });

  it.each([['nocolon'], ['a:'], ['a:x'], ['a:01'], ['a:-1'], ['a:1.5'], [':3']])(
    'a malformed op id %j is never stable',
    (id) => {
      expect(isCausallyStable(id as OpIdKey, vv({ a: 100, '': 100 }))).toBe(false);
    }
  );

  it('seq 0 is never stable (sequence numbers start at 1)', () => {
    expect(isCausallyStable('a:0' as OpIdKey, vv({ a: 5 }))).toBe(false);
  });

  it('is deterministic and does not change the frontier', () => {
    const f = vv({ a: 2 });
    expect(isCausallyStable('a:2' as OpIdKey, f)).toBe(isCausallyStable('a:2' as OpIdKey, f));
    expect(asObject(f)).toEqual({ a: 2 });
  });
});
