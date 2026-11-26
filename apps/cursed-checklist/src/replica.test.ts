import { describe, it, expect } from 'vitest';
import { isValidReplicaId } from '@bones/kernel';
import { createReplica, isItem, MAX_ITEM_LENGTH, newReplicaId } from './replica';

describe('newReplicaId (G2: a new replica ID on every page load)', () => {
  it('has the form tab-<8 hex>.0 and is a valid kernel replica ID', () => {
    const id = newReplicaId();
    expect(id).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    expect(isValidReplicaId(id)).toBe(true);
  });

  it('is different every time (1,000 calls, no repeats)', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newReplicaId()));
    expect(ids.size).toBe(1000);
  });
});

describe('createReplica', () => {
  it('creates an empty CRDT with a fresh replica ID each time', () => {
    const a = createReplica();
    const b = createReplica();
    expect(a.replicaId).not.toBe(b.replicaId);
    expect(a.getSequence()).toEqual([]);
  });

  it('accepts an explicit replica ID (used by tests)', () => {
    expect(createReplica('fixed.0').replicaId).toBe('fixed.0');
  });
});

describe('isItem (values received from other tabs)', () => {
  it('accepts { text } with 1 to MAX_ITEM_LENGTH characters', () => {
    expect(isItem({ text: 'a' })).toBe(true);
    expect(isItem({ text: 'x'.repeat(MAX_ITEM_LENGTH) })).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [
      undefined,
      null,
      'text',
      42,
      [],
      ['text'],
      {},
      { text: '' },
      { text: 'x'.repeat(MAX_ITEM_LENGTH + 1) },
      { text: 5 },
      { text: null },
      { title: 'a' },
    ]) {
      expect(isItem(bad)).toBe(false);
    }
  });
});
