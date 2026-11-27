/**
 * Membership (KER-018 to KER-022; requirements.md sections 9 and 10; design.md "MembershipView").
 * Edit ops are fenced by AUTHOR + CUTOFF (never by op.epoch); control messages by EPOCH + membership.
 */

import { describe, it, expect } from 'vitest';
import {
  addReplica,
  applyMembershipView,
  assertValidMembershipView,
  createMembership,
  deserializeMembership,
  getCutoff,
  getEpoch,
  getMembership,
  isBeyondCutoff,
  isControlMessageRejected,
  isFenced,
  isReplicaActive,
  membershipFromJSON,
  membershipToJSON,
  removeReplica,
  serializeMembership,
} from '../src/membership.js';
import type { MembershipView } from '../src/types.js';

/** A view built by hand, so tests do not depend on the functions under test. */
function view(active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView {
  return { activeMembers: new Set(active), evictedMembers: new Map(evicted), epoch };
}

describe('createMembership / getMembership / getEpoch (KER-018)', () => {
  it('starts at epoch 0 with the given active members and nobody evicted', () => {
    const m = createMembership(['a', 'b']);
    expect(getEpoch(m)).toBe(0);
    expect([...m.activeMembers].sort()).toEqual(['a', 'b']);
    expect(m.evictedMembers.size).toBe(0);
  });

  it('accepts any iterable, an empty one, and ignores repeated IDs', () => {
    expect(createMembership(new Set(['x'])).activeMembers.has('x')).toBe(true);
    expect(createMembership([]).activeMembers.size).toBe(0);
    expect(createMembership(['a', 'a', 'a']).activeMembers.size).toBe(1);
  });

  it('copies its input: later changes to the input do not change the membership', () => {
    const input = ['a'];
    const m = createMembership(input);
    input.push('b');
    expect(m.activeMembers.has('b')).toBe(false);
  });

  it.each([[''], ['has space'], ['a:1'], ['é']])('rejects the invalid replica ID %j', (id) => {
    expect(() => createMembership(['ok', id])).toThrow(TypeError);
  });

  it('rejects a non-string replica ID', () => {
    expect(() => createMembership([5 as unknown as string])).toThrow(TypeError);
  });

  it('getMembership returns an independent copy', () => {
    const m = removeReplica(createMembership(['a', 'b']), 'b', 3);
    const copy = getMembership(m);
    expect(copy).toEqual(m);
    copy.activeMembers.add('zzz');
    copy.evictedMembers.set('b', 99);
    expect(m.activeMembers.has('zzz')).toBe(false);
    expect(m.evictedMembers.get('b')).toBe(3);
  });
});

describe('addReplica (KER-019)', () => {
  it('adds the replica and increments the epoch by exactly 1', () => {
    const m = addReplica(createMembership(['a']), 'b');
    expect([...m.activeMembers].sort()).toEqual(['a', 'b']);
    expect(m.epoch).toBe(1);
  });

  it('never changes its input', () => {
    const before = createMembership(['a']);
    addReplica(before, 'b');
    expect(before).toEqual(createMembership(['a']));
  });

  it('adding a member that is already active changes nothing, not even the epoch', () => {
    const m = addReplica(createMembership(['a', 'b']), 'a');
    expect(m.epoch).toBe(0);
    expect(m.activeMembers.size).toBe(2);
  });

  it('an evicted replica ID never returns: adding it throws (a rejoin is a new ID)', () => {
    const m = removeReplica(createMembership(['a', 'b']), 'b', 2);
    expect(() => addReplica(m, 'b')).toThrow(RangeError);
  });

  it('rejects an invalid replica ID', () => {
    expect(() => addReplica(createMembership([]), 'a:1')).toThrow(TypeError);
  });
});

describe('removeReplica (KER-019, KER-022)', () => {
  it('moves the replica to evictedMembers with its cutoff and increments the epoch by exactly 1', () => {
    const m = removeReplica(createMembership(['a', 'b', 'c']), 'c', 7);
    expect([...m.activeMembers].sort()).toEqual(['a', 'b']);
    expect(m.evictedMembers.get('c')).toBe(7);
    expect(m.epoch).toBe(1);
  });

  it('never changes its input', () => {
    const before = createMembership(['a', 'b']);
    removeReplica(before, 'b', 1);
    expect(before).toEqual(createMembership(['a', 'b']));
  });

  it('accepts cutoff 0 (all of that replica\'s operations are fenced)', () => {
    expect(removeReplica(createMembership(['a', 'b']), 'b', 0).evictedMembers.get('b')).toBe(0);
  });

  it.each([[-1], [1.5], [NaN], [Infinity], [2 ** 53], ['3' as unknown as number], [null as unknown as number]])(
    'rejects the invalid cutoff %j',
    (cutoff) => {
      expect(() => removeReplica(createMembership(['a', 'b']), 'b', cutoff)).toThrow(TypeError);
    }
  );

  it('rejects a replica that is not a member', () => {
    expect(() => removeReplica(createMembership(['a']), 'ghost', 1)).toThrow(RangeError);
  });

  it('removing an already evicted replica changes nothing: the epoch and the first cutoff stay', () => {
    const once = removeReplica(createMembership(['a', 'b']), 'b', 3);
    const twice = removeReplica(once, 'b', 9);
    expect(twice.epoch).toBe(1);
    expect(twice.evictedMembers.get('b')).toBe(3);
  });

  it('the epoch rises by one per change over a whole history, never more, never less', () => {
    let m = createMembership(['a']);
    m = addReplica(m, 'b');
    m = addReplica(m, 'c');
    m = removeReplica(m, 'b', 4);
    m = addReplica(m, 'd');
    m = removeReplica(m, 'c', 0);
    expect(m.epoch).toBe(5);
  });
});

describe('isFenced: edit operations by AUTHOR and CUTOFF (KER-020, KER-022)', () => {
  const m = view(['alice', 'bob'], [['carol', 5]], 3);

  it('accepts every op from an active author, whatever its seq', () => {
    expect(isFenced(m, 'alice', 1)).toBe(false);
    expect(isFenced(m, 'alice', 1_000_000)).toBe(false);
  });

  it('accepts an evicted author up to and including its cutoff, rejects above it', () => {
    expect(isFenced(m, 'carol', 1)).toBe(false);
    expect(isFenced(m, 'carol', 4)).toBe(false);
    expect(isFenced(m, 'carol', 5)).toBe(false); // exactly the cutoff
    expect(isFenced(m, 'carol', 6)).toBe(true); // one beyond
  });

  it('with cutoff 0 every op of the evicted author is rejected', () => {
    expect(isFenced(view(['a'], [['z', 0]], 1), 'z', 1)).toBe(true);
  });

  it('rejects an unknown author', () => {
    expect(isFenced(m, 'mallory', 1)).toBe(true);
  });

  it('is not influenced by an epoch: the rule takes only membership, author and seq', () => {
    expect(isFenced.length).toBe(3);
    expect(isFenced(view(['a'], [], 99), 'a', 1)).toBe(false);
    expect(isFenced(view(['a'], [], 0), 'a', 1)).toBe(false);
  });
});

describe('isBeyondCutoff / getCutoff / isReplicaActive (KER-022, KER-020)', () => {
  const m = view(['a'], [['c', 5]], 2);

  it('getCutoff returns the cutoff of an evicted replica and undefined for anyone else', () => {
    expect(getCutoff(m, 'c')).toBe(5);
    expect(getCutoff(m, 'a')).toBeUndefined();
    expect(getCutoff(m, 'nobody')).toBeUndefined();
  });

  it('isBeyondCutoff is true only for an evicted replica and a seq above its cutoff', () => {
    expect(isBeyondCutoff(m, 'c', 5)).toBe(false);
    expect(isBeyondCutoff(m, 'c', 6)).toBe(true);
    expect(isBeyondCutoff(m, 'a', 1_000)).toBe(false); // active: no cutoff
    expect(isBeyondCutoff(m, 'nobody', 1)).toBe(false); // unknown: not "beyond a cutoff" (isFenced rejects it)
  });

  it('isReplicaActive is true for active members only', () => {
    expect(isReplicaActive(m, 'a')).toBe(true);
    expect(isReplicaActive(m, 'c')).toBe(false);
    expect(isReplicaActive(m, 'nobody')).toBe(false);
  });
});

describe('isControlMessageRejected: control messages by EPOCH and membership (KER-020)', () => {
  const m = view(['a', 'b'], [['c', 2]], 4);

  it('accepts an active sender whose epoch is current', () => {
    expect(isControlMessageRejected(m, 'a', 4)).toBe(false);
  });

  it('accepts an active sender whose epoch is newer (it knows a later view than this replica)', () => {
    expect(isControlMessageRejected(m, 'a', 5)).toBe(false);
  });

  it('rejects an active sender whose epoch is stale', () => {
    expect(isControlMessageRejected(m, 'a', 3)).toBe(true);
    expect(isControlMessageRejected(m, 'a', 0)).toBe(true);
  });

  it('rejects a sender that is not active, even with a current epoch (evicted, unknown)', () => {
    expect(isControlMessageRejected(m, 'c', 4)).toBe(true);
    expect(isControlMessageRejected(m, 'ghost', 4)).toBe(true);
  });

  it.each([[NaN], [-1], [1.5], [Infinity], ['4' as unknown as number], [undefined as unknown as number]])(
    'rejects the malformed epoch %j instead of letting a failed comparison pass it',
    (epoch) => {
      expect(isControlMessageRejected(m, 'a', epoch)).toBe(true);
    }
  );
});

describe('applyMembershipView (KER-019)', () => {
  const current = view(['a', 'b'], [], 1);

  it('installs a view with a greater epoch', () => {
    const incoming = view(['a'], [['b', 4]], 2);
    const result = applyMembershipView(current, incoming);
    expect(result.applied).toBe(true);
    expect(result.view).toEqual(incoming);
  });

  it('accepts an epoch that skips numbers (views are full state; a lost one must not block this replica)', () => {
    const result = applyMembershipView(current, view(['a'], [['b', 4]], 9));
    expect(result.applied).toBe(true);
    expect(result.view.epoch).toBe(9);
  });

  it('ignores a view whose epoch is equal or lower, and returns the current view', () => {
    for (const epoch of [1, 0]) {
      const result = applyMembershipView(current, view(['a', 'b', 'x'], [], epoch));
      expect(result.applied).toBe(false);
      expect(result.view).toEqual(current);
    }
  });

  it('the epoch never decreases across a series of views in any order', () => {
    let m = current;
    for (const epoch of [3, 2, 5, 1, 5, 4, 6]) {
      m = applyMembershipView(m, view(['a', 'b'], [], epoch)).view;
    }
    expect(m.epoch).toBe(6);
  });

  it('the result is a copy: changing the incoming view afterwards does not change it', () => {
    const incoming = view(['a'], [['b', 4]], 2);
    const { view: installed } = applyMembershipView(current, incoming);
    incoming.activeMembers.add('hacker');
    incoming.evictedMembers.set('b', 99);
    expect(installed.activeMembers.has('hacker')).toBe(false);
    expect(installed.evictedMembers.get('b')).toBe(4);
  });

  describe('a higher epoch that contradicts what this replica already knows is ignored', () => {
    const known = view(['a'], [['b', 4]], 2);

    it('an evicted replica becomes active again', () => {
      expect(applyMembershipView(known, view(['a', 'b'], [], 3)).applied).toBe(false);
    });

    it('an evicted replica disappears from the view', () => {
      expect(applyMembershipView(known, view(['a'], [], 3)).applied).toBe(false);
    });

    it('an evicted replica gets a different cutoff (higher or lower)', () => {
      expect(applyMembershipView(known, view(['a'], [['b', 5]], 3)).applied).toBe(false);
      expect(applyMembershipView(known, view(['a'], [['b', 3]], 3)).applied).toBe(false);
    });

    it('an active member vanishes without being evicted (all its ops would become "unknown author")', () => {
      expect(applyMembershipView(view(['a', 'c'], [], 1), view(['a'], [], 2)).applied).toBe(false);
    });

    it('a consistent view that adds a member and evicts another IS applied', () => {
      expect(applyMembershipView(known, view(['a', 'n'], [['b', 4]], 3)).applied).toBe(true);
      expect(applyMembershipView(view(['a', 'c'], [], 1), view(['a'], [['c', 7]], 2)).applied).toBe(true);
    });
  });

  it('throws TypeError for a structurally invalid incoming view, even if its epoch is old', () => {
    expect(() => applyMembershipView(current, null as unknown as MembershipView)).toThrow(TypeError);
    expect(() => applyMembershipView(current, view(['a'], [['a', 1]], 5))).toThrow(TypeError); // active AND evicted
    expect(() => applyMembershipView(current, view(['a'], [], -1))).toThrow(TypeError);
  });
});

describe('assertValidMembershipView', () => {
  it('accepts a well-formed view', () => {
    expect(() => assertValidMembershipView(view(['a'], [['b', 0]], 3))).not.toThrow();
    expect(() => assertValidMembershipView(createMembership([]))).not.toThrow();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'view'],
    ['activeMembers as an array', { activeMembers: ['a'], evictedMembers: new Map(), epoch: 0 }],
    ['evictedMembers as an object', { activeMembers: new Set(), evictedMembers: {}, epoch: 0 }],
    ['a missing epoch', { activeMembers: new Set(), evictedMembers: new Map() }],
    ['epoch 1.5', { activeMembers: new Set(), evictedMembers: new Map(), epoch: 1.5 }],
    ['epoch -1', { activeMembers: new Set(), evictedMembers: new Map(), epoch: -1 }],
    ['epoch NaN', { activeMembers: new Set(), evictedMembers: new Map(), epoch: NaN }],
    ['epoch as a string', { activeMembers: new Set(), evictedMembers: new Map(), epoch: '1' }],
    ['an invalid active ID', { activeMembers: new Set(['a:1']), evictedMembers: new Map(), epoch: 0 }],
    ['a non-string active ID', { activeMembers: new Set([1]), evictedMembers: new Map(), epoch: 0 }],
    ['an invalid evicted ID', { activeMembers: new Set(), evictedMembers: new Map([['', 1]]), epoch: 0 }],
    ['a negative cutoff', { activeMembers: new Set(), evictedMembers: new Map([['a', -1]]), epoch: 0 }],
    ['a fractional cutoff', { activeMembers: new Set(), evictedMembers: new Map([['a', 0.5]]), epoch: 0 }],
    ['a string cutoff', { activeMembers: new Set(), evictedMembers: new Map([['a', '1']]), epoch: 0 }],
    ['a replica both active and evicted', { activeMembers: new Set(['a']), evictedMembers: new Map([['a', 1]]), epoch: 0 }],
  ])('rejects %s', (_name, value) => {
    expect(() => assertValidMembershipView(value)).toThrow(TypeError);
  });
});

describe('serialization (KER-021)', () => {
  it('has a fixed, readable shape: sorted members, sorted evicted map, epoch', () => {
    const m = view(['b', 'a'], [['d', 4], ['c', 0]], 2);
    expect(serializeMembership(m)).toBe('{"activeMembers":["a","b"],"epoch":2,"evictedMembers":{"c":0,"d":4}}');
  });

  it('is deterministic: the same view built in a different insertion order gives the same string', () => {
    const one = view(['a', 'b', 'c'], [['x', 1], ['y', 2]], 5);
    const two = view(['c', 'a', 'b'], [['y', 2], ['x', 1]], 5);
    expect(serializeMembership(one)).toBe(serializeMembership(two));
  });

  it('round-trips: deserialize(serialize(m)) equals m and serializes to the identical string', () => {
    const m = removeReplica(addReplica(createMembership(['a', 'b']), 'c'), 'b', 6);
    const json = serializeMembership(m);
    const back = deserializeMembership(json);
    expect(back).toEqual(m);
    expect(serializeMembership(back)).toBe(json);
  });

  it('round-trips an empty membership', () => {
    const m = createMembership([]);
    expect(deserializeMembership(serializeMembership(m))).toEqual(m);
  });

  it('keeps a replica called "__proto__" as an ordinary ID (no prototype pollution, no lost entry)', () => {
    const m = view(['a'], [['__proto__', 3]], 1);
    const json = serializeMembership(m);
    const back = deserializeMembership(json);
    expect(back.evictedMembers.get('__proto__')).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(JSON.parse(json).evictedMembers)).toEqual(['__proto__']);
  });

  it('membershipToJSON / membershipFromJSON are the plain-object form used inside other messages', () => {
    const m = view(['b', 'a'], [['c', 2]], 1);
    const plain = membershipToJSON(m);
    expect(plain.activeMembers).toEqual(['a', 'b']);
    expect(plain.epoch).toBe(1);
    expect(membershipFromJSON(JSON.parse(JSON.stringify(plain)))).toEqual(m);
  });

  const BAD_JSON: Array<[string, string]> = [
    ['not JSON', '{'],
    ['an empty string', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['a number', '5'],
    ['an empty object', '{}'],
    ['no epoch', '{"activeMembers":[],"evictedMembers":{}}'],
    ['no activeMembers', '{"epoch":0,"evictedMembers":{}}'],
    ['no evictedMembers', '{"activeMembers":[],"epoch":0}'],
    ['activeMembers not an array', '{"activeMembers":"a","epoch":0,"evictedMembers":{}}'],
    ['activeMembers as an object', '{"activeMembers":{"a":1},"epoch":0,"evictedMembers":{}}'],
    ['a non-string member', '{"activeMembers":[1],"epoch":0,"evictedMembers":{}}'],
    ['an invalid member ID', '{"activeMembers":["a:1"],"epoch":0,"evictedMembers":{}}'],
    ['a repeated member', '{"activeMembers":["a","a"],"epoch":0,"evictedMembers":{}}'],
    ['evictedMembers as an array', '{"activeMembers":[],"epoch":0,"evictedMembers":[]}'],
    ['evictedMembers null', '{"activeMembers":[],"epoch":0,"evictedMembers":null}'],
    ['a fractional cutoff', '{"activeMembers":[],"epoch":0,"evictedMembers":{"a":1.5}}'],
    ['a negative cutoff', '{"activeMembers":[],"epoch":0,"evictedMembers":{"a":-1}}'],
    ['a string cutoff', '{"activeMembers":[],"epoch":0,"evictedMembers":{"a":"1"}}'],
    ['a null cutoff', '{"activeMembers":[],"epoch":0,"evictedMembers":{"a":null}}'],
    ['a huge cutoff', '{"activeMembers":[],"epoch":0,"evictedMembers":{"a":1e999}}'],
    ['a negative epoch', '{"activeMembers":[],"epoch":-1,"evictedMembers":{}}'],
    ['a fractional epoch', '{"activeMembers":[],"epoch":0.5,"evictedMembers":{}}'],
    ['a string epoch', '{"activeMembers":[],"epoch":"0","evictedMembers":{}}'],
    ['a replica both active and evicted', '{"activeMembers":["a"],"epoch":1,"evictedMembers":{"a":1}}'],
  ];

  it.each(BAD_JSON)('deserializeMembership rejects %s', (_name, json) => {
    expect(() => deserializeMembership(json)).toThrow();
  });

  it('a bad input never half-builds a view: it throws before returning anything', () => {
    let result: MembershipView | undefined;
    try {
      result = deserializeMembership('{"activeMembers":["ok"],"epoch":1,"evictedMembers":{"a":-1}}');
    } catch {
      /* expected */
    }
    expect(result).toBeUndefined();
  });
});
