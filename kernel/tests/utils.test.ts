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
  isValidReplicaId,
  isValidSequence,
  stableStringify,
  serializeOp,
  deserializeOp,
  buildOpIndex,
  estimatePayloadSize,
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
    expect(updateVersionVector(vv, 'a', 1)).toBe(vv);
  });

  it('compares version vectors for causality', () => {
    const vv1 = new Map([['a', 1]]);
    const vv2 = new Map([['a', 2]]);
    const vv3 = new Map([['b', 1]]);

    expect(compareVersionVectors(vv1, vv2)).toBe('before');
    expect(compareVersionVectors(vv2, vv1)).toBe('after');
    expect(compareVersionVectors(vv1, vv3)).toBe('concurrent');
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
});
