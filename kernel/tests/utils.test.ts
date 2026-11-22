/**
 * Tests for utility functions.
 * Basic smoke tests to verify the setup works.
 */

import { describe, it, expect } from 'vitest';
import {
  parseOpId,
  createOpId,
  compareOpIds,
  compareVersionVectors,
  mergeVersionVectors,
  updateVersionVector,
  isValidReplicaId,
  isValidSequence,
} from '../src/utils.js';

describe('OpId utilities', () => {
  it('creates and parses OpIds correctly', () => {
    const opId = createOpId('replica-1', 42);
    expect(opId).toBe('replica-1:42');

    const parsed = parseOpId(opId);
    expect(parsed).toEqual({ replicaId: 'replica-1', seq: 42 });
  });

  it('compares OpIds lexicographically', () => {
    expect(compareOpIds('a:1' as any, 'b:1' as any)).toBe(-1);
    expect(compareOpIds('a:1' as any, 'a:1' as any)).toBe(0);
    expect(compareOpIds('b:1' as any, 'a:1' as any)).toBe(1);
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
    const vv1 = new Map([['a', 1], ['b', 2]]);
    const vv2 = new Map([['a', 3], ['c', 1]]);
    const merged = mergeVersionVectors(vv1, vv2);

    expect(merged.get('a')).toBe(3);
    expect(merged.get('b')).toBe(2);
    expect(merged.get('c')).toBe(1);
  });

  it('updates version vectors', () => {
    const vv = new Map([['a', 1]]);
    const updated = updateVersionVector(vv, 'a', 2);

    expect(updated.get('a')).toBe(2);
    expect(updated).not.toBe(vv); // Should be a new Map
  });

  it('compares version vectors for causality', () => {
    const vv1 = new Map([['a', 1]]);
    const vv2 = new Map([['a', 2]]);
    const vv3 = new Map([['b', 1]]);

    expect(compareVersionVectors(vv1, vv2)).toBe('before');
    expect(compareVersionVectors(vv2, vv1)).toBe('after');
    expect(compareVersionVectors(vv1, vv3)).toBe('concurrent');
  });
});
