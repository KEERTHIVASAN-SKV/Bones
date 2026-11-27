/**
 * assertValidVersionVector: the trust-boundary check for a version vector that arrives as a Map
 * (a frontier from the coordinator, a snapshot field). `deserializeVersionVector` handles the
 * plain-object JSON form; this handles the in-memory form.
 */

import { describe, it, expect } from 'vitest';
import { assertValidVersionVector } from '../src/utils.js';

describe('assertValidVersionVector', () => {
  it('accepts an empty vector, entries of 0 (they mean "nothing applied") and large safe integers', () => {
    expect(() => assertValidVersionVector(new Map())).not.toThrow();
    expect(() => assertValidVersionVector(new Map([['a', 0]]))).not.toThrow();
    expect(() => assertValidVersionVector(new Map([['site.0', 5], ['b-2', Number.MAX_SAFE_INTEGER]]))).not.toThrow();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { a: 1 }],
    ['an array of pairs', [['a', 1]]],
    ['a Set', new Set(['a'])],
    ['a string', 'a:1'],
    ['a number', 3],
  ])('rejects %s (not a Map)', (_name, value) => {
    expect(() => assertValidVersionVector(value)).toThrow(TypeError);
  });

  it.each([
    ['an empty key', new Map([['', 1]])],
    ['a key with a colon', new Map([['a:b', 1]])],
    ['a key with a space', new Map([['a b', 1]])],
    ['a non-ASCII key', new Map([['é', 1]])],
    ['a numeric key', new Map([[7, 1]])],
    ['a null key', new Map([[null, 1]])],
  ])('rejects %s', (_name, value) => {
    expect(() => assertValidVersionVector(value)).toThrow(TypeError);
  });

  it.each([
    ['a negative entry', -1],
    ['a fractional entry', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an unsafe integer', 2 ** 53],
    ['a string', '3'],
    ['null', null],
    ['undefined', undefined],
    ['a BigInt', 3n],
    ['a boolean', true],
  ])('rejects %s as an entry value', (_name, seq) => {
    expect(() => assertValidVersionVector(new Map([['a', seq]]))).toThrow(TypeError);
  });

  it('rejects the whole vector if ANY entry is bad, even after good ones', () => {
    expect(() => assertValidVersionVector(new Map([['a', 1], ['b', 2], ['c', -3]]))).toThrow(TypeError);
  });

  it('keeps "__proto__" as an ordinary replica ID', () => {
    expect(() => assertValidVersionVector(new Map([['__proto__', 2]]))).not.toThrow();
  });
});
