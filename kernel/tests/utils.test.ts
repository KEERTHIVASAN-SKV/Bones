/**
 * Tests for utility functions (KER-005).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseOpId,
  createOpId,
  compareOpIds,
  compareVersionVectors,
  mergeVersionVectors,
  updateVersionVector,
  serializeVersionVector,
  deserializeVersionVector,
  isValidReplicaId,
  isValidSequence,
  stableStringify,
  serializeOp,
  deserializeOp,
  assertValidOperation,
  buildOpIndex,
  estimatePayloadSize,
  MAX_LAMPORT,
} from '../src/utils.js';
import type { Element, Operation } from '../src/types.js';

const SEEDED = { seed: 12345, numRuns: 100 } as const;

describe('OpId utilities', () => {
  it('creates and parses OpIds correctly', () => {
    const opId = createOpId('replica-1', 42);
    expect(opId).toBe('replica-1:42');
    expect(parseOpId(opId)).toEqual({ replicaId: 'replica-1', seq: 42 });
  });

  it('rejects malformed OpIds', () => {
    expect(parseOpId('nocolon' as never)).toBeNull();
    expect(parseOpId('a:1e3' as never)).toBeNull();
    expect(parseOpId('a: 5' as never)).toBeNull();
    expect(parseOpId('a:' as never)).toBeNull();
  });

  it('compares OpIds lexicographically by code unit', () => {
    expect(compareOpIds(createOpId('a', 1), createOpId('b', 1))).toBe(-1);
    expect(compareOpIds(createOpId('a', 1), createOpId('a', 1))).toBe(0);
    expect(compareOpIds(createOpId('b', 1), createOpId('a', 1))).toBe(1);
    // Upper case sorts before lower case under code-unit comparison (locale-independent)
    expect(compareOpIds(createOpId('B', 1), createOpId('a', 1))).toBe(-1);
  });

  it('validates replica IDs', () => {
    expect(isValidReplicaId('replica-1')).toBe(true);
    expect(isValidReplicaId('r_2')).toBe(true);
    expect(isValidReplicaId('')).toBe(false);
    expect(isValidReplicaId('replica@bad')).toBe(false);
  });

  it('accepts the "${siteId}.${incarnation}" replica ID format (requirements.md 2.1)', () => {
    expect(isValidReplicaId('site1.2')).toBe(true);
    expect(isValidReplicaId('abc123.0')).toBe(true);
    expect(isValidReplicaId('a.b.c')).toBe(true);
    // ':' separates replicaId from seq inside an OpIdKey, so it stays invalid in a replica ID
    expect(isValidReplicaId('a:b')).toBe(false);
    expect(isValidReplicaId('has space')).toBe(false);
  });

  it('compareOpIds is plain string order, NOT numeric seq order', () => {
    // "a:10" < "a:9" because '1' < '9' as characters
    expect(compareOpIds(createOpId('a', 10), createOpId('a', 9))).toBe(-1);
    expect(compareOpIds(createOpId('a', 9), createOpId('a', 10))).toBe(1);
  });

  it('validates sequences', () => {
    expect(isValidSequence(1)).toBe(true);
    expect(isValidSequence(42)).toBe(true);
    expect(isValidSequence(0)).toBe(false);
    expect(isValidSequence(-1)).toBe(false);
    expect(isValidSequence(1.5)).toBe(false);
  });
});

describe('Version Vector utilities', () => {
  it('merges version vectors correctly', () => {
    const merged = mergeVersionVectors(
      new Map([['a', 1], ['b', 2]]),
      new Map([['a', 3], ['c', 1]])
    );
    expect(merged.get('a')).toBe(3);
    expect(merged.get('b')).toBe(2);
    expect(merged.get('c')).toBe(1);
  });

  it('updates version vectors without mutating the input', () => {
    const vv = new Map([['a', 1]]);
    const updated = updateVersionVector(vv, 'a', 2);
    expect(updated.get('a')).toBe(2);
    expect(vv.get('a')).toBe(1);
    expect(updated).not.toBe(vv);
    // a lower value never decreases the entry, and the result is still a NEW Map (KER-011)
    const same = updateVersionVector(vv, 'a', 1);
    expect(same).not.toBe(vv);
    expect(same.get('a')).toBe(1);
  });

  it('compares version vectors for causality', () => {
    const vv1 = new Map([['a', 1]]);
    const vv2 = new Map([['a', 2]]);
    const vv3 = new Map([['b', 1]]);

    expect(compareVersionVectors(vv1, vv2)).toBe('before');
    expect(compareVersionVectors(vv2, vv1)).toBe('after');
    expect(compareVersionVectors(vv1, vv3)).toBe('concurrent');
  });

  it('keeps a "__proto__" replica ID when serializing a version vector', () => {
    const vv = new Map([['__proto__', 4]]);
    const plain = serializeVersionVector(vv);
    expect(Object.keys(plain)).toEqual(['__proto__']);
    expect(deserializeVersionVector(plain)).toEqual(vv);
  });

  it('serializes and deserializes version vectors round-trip', () => {
    const vv = new Map([['a.0', 3], ['b.1', 12]]);
    expect(deserializeVersionVector(serializeVersionVector(vv))).toEqual(vv);
  });

  it('deserializeVersionVector keeps positive integers and ignores 0 entries', () => {
    expect(deserializeVersionVector({ a: 2, b: 0 })).toEqual(new Map([['a', 2]]));
  });

  it('deserializeVersionVector rejects non-integer, negative, NaN, Infinity and string entries', () => {
    const bad = (v: unknown) => () => deserializeVersionVector({ a: v as number });
    expect(bad(1.5)).toThrow(TypeError);
    expect(bad(-1)).toThrow(TypeError);
    expect(bad(Number.NaN)).toThrow(TypeError);
    expect(bad(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(bad('3')).toThrow(TypeError);
    expect(bad(null)).toThrow(TypeError);
  });

  it('reports equal vectors as equal, treating missing entries as 0', () => {
    expect(compareVersionVectors(new Map(), new Map())).toBe('equal');
    expect(compareVersionVectors(new Map([['a', 1]]), new Map([['a', 1]]))).toBe('equal');
    expect(compareVersionVectors(new Map([['a', 1], ['b', 0]]), new Map([['a', 1]]))).toBe('equal');
    expect(compareVersionVectors(new Map(), new Map([['a', 1]]))).toBe('before');
  });
});

describe('Operation serialization', () => {
  const insertOp: Operation<{ z: number; a: string }> = {
    id: createOpId('r1', 3),
    type: 'insert',
    anchor: createOpId('r1', 2),
    value: { z: 1, a: 'x' },
    lamport: 7,
    replicaId: 'r1',
  };
  const deleteOp: Operation = {
    id: createOpId('r2', 1),
    type: 'delete',
    target: createOpId('r1', 3),
    lamport: 8,
    replicaId: 'r2',
    epoch: 0,
  };

  it('sorts keys at every level and omits undefined fields', () => {
    const json = serializeOp({ ...insertOp, epoch: undefined });
    expect(json).toBe(
      '{"anchor":"r1:2","id":"r1:3","lamport":7,"replicaId":"r1","type":"insert","value":{"a":"x","z":1}}'
    );
  });

  it('is independent of property insertion order', () => {
    const reordered: Operation<{ z: number; a: string }> = {
      value: { a: 'x', z: 1 },
      replicaId: 'r1',
      lamport: 7,
      anchor: createOpId('r1', 2),
      type: 'insert',
      id: createOpId('r1', 3),
    };
    expect(serializeOp(reordered)).toBe(serializeOp(insertOp));
  });

  it('round-trips insert and delete operations', () => {
    expect(deserializeOp(serializeOp(insertOp))).toEqual(insertOp);
    expect(deserializeOp(serializeOp(deleteOp))).toEqual(deleteOp);
  });

  it('round-trips arbitrary JSON values (seeded property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({ min: 1, max: 1000 }), (value, seq) => {
        const op: Operation = {
          id: createOpId('r1', seq),
          type: 'insert',
          value,
          lamport: seq,
          replicaId: 'r1',
        };
        const once = serializeOp(op);
        return serializeOp(deserializeOp(once)) === once;
      }),
      SEEDED
    );
  });

  it('refuses Map and Set values instead of silently serializing them as {}', () => {
    expect(() => serializeOp({ ...insertOp, value: new Map([['a', 1]]) as never })).toThrow(TypeError);
    expect(() => stableStringify({ nested: [new Set([1])] })).toThrow(TypeError);
    expect(() => stableStringify(undefined)).toThrow(TypeError);
  });

  it('keeps a "__proto__" key as plain data', () => {
    const json = '{"__proto__":{"x":1},"a":2}';
    expect(stableStringify(JSON.parse(json))).toBe('{"__proto__":{"x":1},"a":2}');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects malformed or inconsistent operations', () => {
    const bad = (o: unknown) => () => deserializeOp(JSON.stringify(o));
    expect(() => deserializeOp('not json')).toThrow();
    expect(bad([])).toThrow();
    expect(bad({ ...insertOp, id: 'garbage' })).toThrow();
    expect(bad({ ...insertOp, replicaId: 'other' })).toThrow();
    expect(bad({ ...insertOp, type: 'update' })).toThrow();
    expect(bad({ ...insertOp, lamport: -1 })).toThrow();
    expect(bad({ ...insertOp, target: 'r1:1' })).toThrow();
    expect(bad({ ...deleteOp, target: undefined })).toThrow();
    expect(bad({ ...deleteOp, anchor: 'r1:1' })).toThrow();
  });
});

describe('assertValidOperation (for operations that never passed through deserializeOp)', () => {
  const good = (): Record<string, unknown> => ({
    id: 'r1:3',
    type: 'insert',
    anchor: 'r1:2',
    value: 'x',
    lamport: 3,
    replicaId: 'r1',
  });

  it('accepts well-formed inserts and deletes', () => {
    expect(() => assertValidOperation(good())).not.toThrow();
    expect(() => assertValidOperation({ id: 'r2:1', type: 'delete', target: 'r1:3', lamport: 4, replicaId: 'r2' })).not.toThrow();
    expect(() => assertValidOperation({ ...good(), anchor: undefined, epoch: 0 })).not.toThrow();
  });

  it('rejects a replicaId that does not match the replica part of the id', () => {
    expect(() => assertValidOperation({ ...good(), replicaId: 'r2' })).toThrow(TypeError);
    expect(() => assertValidOperation({ ...good(), replicaId: 'r' })).toThrow(TypeError); // prefix is not a match
    expect(() => assertValidOperation({ ...good(), id: 'site1.2:3', replicaId: 'site1' })).toThrow(TypeError);
  });

  it('rejects non-objects, bad ids, bad types, bad lamports and bad epochs', () => {
    for (const bad of [null, undefined, 42, 'op', [], { ...good(), id: 'nocolon' }, { ...good(), id: 'r1:0' },
      { ...good(), id: 'r1:1.5' }, { ...good(), id: 5 }, { ...good(), type: 'update' }, { ...good(), lamport: -1 },
      { ...good(), lamport: 1.5 }, { ...good(), lamport: '3' }, { ...good(), epoch: -1 }, { ...good(), epoch: 'x' }]) {
      expect(() => assertValidOperation(bad)).toThrow(TypeError);
    }
  });

  it('rejects an unknown type even when every other field looks like a valid delete', () => {
    const lookslikeDelete = { id: 'r2:1', type: 'update', target: 'r1:3', lamport: 4, replicaId: 'r2' };
    expect(() => assertValidOperation(lookslikeDelete)).toThrow(/"type" must be/);
    const lookslikeInsert = { id: 'r2:1', type: 'upsert', value: 'x', lamport: 4, replicaId: 'r2' };
    expect(() => assertValidOperation(lookslikeInsert)).toThrow(/"type" must be/);
  });

  it('enforces the Lamport limit: only safe integers in [0, MAX_LAMPORT] are accepted (F1)', () => {
    expect(MAX_LAMPORT).toBe(2 ** 48);
    for (const lamport of [0, 1, 2 ** 32, MAX_LAMPORT]) {
      expect(() => assertValidOperation({ ...good(), lamport })).not.toThrow();
    }
    // 2**53 and 1e300 are what a forged op would use: clock + 1 === clock for them.
    // 2**53 - 1 is a safe integer but still beyond the kernel limit.
    for (const lamport of [MAX_LAMPORT + 1, 2 ** 53 - 1, 2 ** 53, 1e300, Infinity, -Infinity, Number.NaN]) {
      expect(() => assertValidOperation({ ...good(), lamport })).toThrow(/\[0, MAX_LAMPORT\]/);
    }
  });

  it('applies the safe-integer check to epoch too (F1)', () => {
    for (const epoch of [0, 1, 2 ** 53 - 1]) {
      expect(() => assertValidOperation({ ...good(), epoch })).not.toThrow();
    }
    for (const epoch of [2 ** 53, 1e300, Infinity, Number.NaN, -1, 1.5]) {
      expect(() => assertValidOperation({ ...good(), epoch })).toThrow(/"epoch" must be/);
    }
  });

  it('rejects inconsistent insert/delete fields', () => {
    expect(() => assertValidOperation({ ...good(), target: 'r1:1' })).toThrow(TypeError); // insert with a target
    expect(() => assertValidOperation({ ...good(), anchor: 'bad' })).toThrow(TypeError);
    const del = { id: 'r2:1', type: 'delete', target: 'r1:3', lamport: 4, replicaId: 'r2' };
    expect(() => assertValidOperation({ ...del, anchor: 'r1:1' })).toThrow(TypeError); // delete with an anchor
    expect(() => assertValidOperation({ ...del, target: undefined })).toThrow(TypeError);
    expect(() => assertValidOperation({ ...del, target: 'bad' })).toThrow(TypeError);
  });

  it('deserializeOp applies the same checks (single source of truth)', () => {
    expect(() => deserializeOp(JSON.stringify({ ...good(), replicaId: 'r2' }))).toThrow(TypeError);
    expect(() => deserializeOp('[]')).toThrow(TypeError);
    expect(deserializeOp(JSON.stringify(good())).id).toBe('r1:3');
  });
});

describe('buildOpIndex', () => {
  it('maps element ids to their array index', () => {
    const el = (id: ReturnType<typeof createOpId>): Element<string> => ({
      id,
      anchor: undefined,
      lamport: 1,
      deleted: false,
      payloadReclaimed: false,
    });
    const index = buildOpIndex([el(createOpId('a', 1)), el(createOpId('b', 1)), el(createOpId('a', 2))]);
    expect(index.get(createOpId('a', 1))).toBe(0);
    expect(index.get(createOpId('b', 1))).toBe(1);
    expect(index.get(createOpId('a', 2))).toBe(2);
    expect(index.size).toBe(3);
    expect(buildOpIndex([]).size).toBe(0);
  });
});

describe('isValidReplicaId with values that are not strings', () => {
  it.each([[5], [0], [true], [['a.0']], [{ toString: () => 'a.0' }], [null], [undefined], [Symbol('a')]])(
    'is false for %s (the regex would coerce several of them into a match)',
    (value) => {
      expect(isValidReplicaId(value as unknown as string)).toBe(false);
    }
  );

  it('is still true for the IDs the kernel uses', () => {
    for (const id of ['a', 'site1.0', 'tab-0aff007b.0', 'r_1-x.2', '__proto__']) expect(isValidReplicaId(id)).toBe(true);
  });
});

describe('estimatePayloadSize', () => {
  it('returns 0 for undefined, null and non-serializable values', () => {
    expect(estimatePayloadSize(undefined)).toBe(0);
    expect(estimatePayloadSize(null)).toBe(0);
    expect(estimatePayloadSize(() => 1)).toBe(0);
  });

  it('returns the JSON length otherwise', () => {
    expect(estimatePayloadSize('abc')).toBe(5);
    expect(estimatePayloadSize({ a: 1 })).toBe(7);
  });

  it('returns 0 instead of throwing for values JSON.stringify rejects (a cycle, a BigInt)', () => {
    // GC calls this while reclaiming; a throw here would abort a whole GC pass half-way.
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(estimatePayloadSize(cycle)).toBe(0);
    expect(estimatePayloadSize(10n)).toBe(0);
    expect(estimatePayloadSize({ nested: { big: 1n } })).toBe(0);
  });

  it('returns 0 for a value whose toJSON throws', () => {
    expect(estimatePayloadSize({ toJSON: () => { throw new Error('nope'); } })).toBe(0);
  });
});
