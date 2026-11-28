import { describe, it, expect, vi, afterEach } from 'vitest';
import { isValidReplicaId } from '@bones/kernel';
import { createReplica, isItem, MAX_ITEM_LENGTH, newReplicaId, nextIncarnation, visibleItems } from './replica';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('does not need crypto.randomUUID, which only exists in secure contexts (A4: plain http on a LAN IP)', () => {
    const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    const id = newReplicaId();
    expect(id).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    expect(uuid).not.toHaveBeenCalled();
  });

  it('draws its 8 hex characters from crypto.getRandomValues', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint8Array).set([0x0a, 0xff, 0x00, 0x7b]);
      return array;
    });
    expect(newReplicaId()).toBe('tab-0aff007b.0');
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

describe('visibleItems (what the UI renders)', () => {
  it('returns live elements whose value is a well-formed item, in sequence order', () => {
    const c = createReplica('v.0');
    const a = c.insert(undefined, { text: 'a' });
    c.insert(a.id, { text: 'b' });
    expect(visibleItems(c).map((e) => e.value.text)).toEqual(['a', 'b']);
  });

  it('hides deleted items', () => {
    const c = createReplica('v.0');
    const a = c.insert(undefined, { text: 'a' });
    c.insert(a.id, { text: 'b' });
    c.delete(a.id);
    expect(visibleItems(c).map((e) => e.value.text)).toEqual(['b']);
  });

  it('hides elements whose value is not an item, WITHOUT removing them from the CRDT', () => {
    const c = createReplica('v.0');
    // a malformed value that arrived from another tab and was applied (see sync.ts)
    c.insert(undefined, 5 as unknown as { text: string });
    c.insert(undefined, { text: '' });
    c.insert(undefined, { text: 'ok' });
    expect(visibleItems(c).map((e) => e.value.text)).toEqual(['ok']);
    expect(c.getSequence()).toHaveLength(3); // still in the structure: later ops anchored on them still apply
  });
});

describe('nextIncarnation (the ID a tab takes when it rejoins)', () => {
  it('is the same site with the incarnation number one higher, and is a valid replica ID', () => {
    expect(nextIncarnation('tab-1a2b3c4d.0')).toBe('tab-1a2b3c4d.1');
    expect(nextIncarnation('tab-1a2b3c4d.9')).toBe('tab-1a2b3c4d.10');
    expect(isValidReplicaId(nextIncarnation('tab-1a2b3c4d.41'))).toBe(true);
  });
  it('falls back to a fresh random ID when the old one has no .<number> ending or the number cannot go up', () => {
    for (const odd of ['plain', 'tab-1a2b3c4d.x', 'tab-1a2b3c4d.', `tab-1a2b3c4d.${Number.MAX_SAFE_INTEGER}`]) {
      expect(nextIncarnation(odd)).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    }
  });
});
