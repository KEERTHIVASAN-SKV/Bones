/**
 * CoordinatorCore: hello (ack and join), the stable frontier, and status (KER-077).
 * The core is pure: the tests pass `now` themselves and check the effects it returns.
 */

import { describe, it, expect } from 'vitest';
import type { VersionVector } from '@bones/kernel';
import { CoordinatorCore } from '../src/core.js';
import type { Effect, HelloMessage } from '../src/core.js';

const vv = (entries: Record<string, number> = {}): VersionVector => new Map(Object.entries(entries));
const hello = (from: string, epoch: number, entries: Record<string, number> = {}): HelloMessage => ({
  from,
  epoch,
  vv: vv(entries),
});
const ofType = <K extends Effect['type']>(effects: Effect[], type: K): Array<Extract<Effect, { type: K }>> =>
  effects.filter((e): e is Extract<Effect, { type: K }> => e.type === type);
const asObject = (v: VersionVector): Record<string, number> => Object.fromEntries([...v].sort());

/** A coordinator with `ids` joined (each at epoch the join produced) and all caught up to the current epoch. */
function joined(ids: string[], options = {}): CoordinatorCore {
  const core = new CoordinatorCore(options);
  ids.forEach((id, i) => core.onHello(hello(id, i), 1000 + i)); // each join bumps the epoch; a joiner's epoch is not checked
  return core;
}

describe('construction', () => {
  it('starts at epoch 0 with nobody, an empty frontier and no eviction', () => {
    const core = new CoordinatorCore();
    const status = core.getStatus(0, 1000);
    expect(status.epoch).toBe(0);
    expect(status.members).toEqual([]);
    expect(status.evicted).toEqual([]);
    expect(status.eviction).toBeNull();
    expect(core.getFrontier().size).toBe(0);
  });

  it('can start with initial members, who have never been heard from', () => {
    const core = new CoordinatorCore({ initialMembers: ['b.0', 'a.0'] });
    const status = core.getStatus(5, 1000);
    expect(status.members.map((m) => [m.id, m.lastHeard, m.stalled])).toEqual([
      ['a.0', undefined, true],
      ['b.0', undefined, true],
    ]);
    expect(status.epoch).toBe(0);
  });

  it.each([[0], [-1], [NaN], [Infinity]])('rejects frontierResendMs %s', (ms) => {
    expect(() => new CoordinatorCore({ frontierResendMs: ms })).toThrow(RangeError);
  });

  it.each([[0], [-1], [1.5], [NaN]])('rejects maxMembers %s', (n) => {
    expect(() => new CoordinatorCore({ maxMembers: n })).toThrow(RangeError);
  });

  it('rejects an invalid initial member ID', () => {
    expect(() => new CoordinatorCore({ initialMembers: ['ok.0', 'a:1'] })).toThrow(TypeError);
  });
});

describe('a hello from an unknown replica joins it', () => {
  it('adds the member, bumps the epoch by exactly 1 and publishes the view', () => {
    const core = new CoordinatorCore();
    const effects = core.onHello(hello('a.0', 0), 100);
    const [view] = ofType(effects, 'view');
    expect(view.view.epoch).toBe(1);
    expect([...view.view.activeMembers]).toEqual(['a.0']);
    expect(core.getView().epoch).toBe(1);
  });

  it('each further member bumps the epoch by one', () => {
    const core = joined(['a.0', 'b.0', 'c.0']);
    expect(core.getView().epoch).toBe(3);
    expect([...core.getView().activeMembers].sort()).toEqual(['a.0', 'b.0', 'c.0']);
  });

  it('its first vector counts as its first acknowledgement', () => {
    const core = new CoordinatorCore();
    core.onHello(hello('a.0', 0, { 'a.0': 4 }), 100);
    expect(asObject(core.getStatus(100, 1000).members[0].ack)).toEqual({ 'a.0': 4 });
  });

  it('a repeated hello does not join again or change the epoch', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 1), 2000);
    core.onHello(hello('a.0', 1), 3000);
    expect(core.getView().epoch).toBe(1);
  });

  it('ignores a hello once maxMembers is reached', () => {
    const core = new CoordinatorCore({ maxMembers: 2 });
    core.onHello(hello('a.0', 0), 1);
    core.onHello(hello('b.0', 0), 2);
    expect(core.onHello(hello('c.0', 0), 3)).toEqual([]);
    expect(core.getView().activeMembers.size).toBe(2);
  });
});

describe('a hello from a member is its acknowledgement', () => {
  it('records the vector and the time', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 1, { 'a.0': 5, 'b.0': 2 }), 4000);
    const [member] = core.getStatus(4000, 1000).members;
    expect(asObject(member.ack)).toEqual({ 'a.0': 5, 'b.0': 2 });
    expect(member.lastHeard).toBe(4000);
  });

  it('an acknowledgement only ever grows: a late, older hello does not move it back', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 1, { x: 9 }), 2000);
    core.onHello(hello('a.0', 1, { x: 3, y: 1 }), 3000); // arrives late
    expect(asObject(core.getStatus(3000, 1000).members[0].ack)).toEqual({ x: 9, y: 1 });
  });

  it('a hello at a NEWER epoch than the coordinator knows is accepted', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 7, { x: 2 }), 2000);
    expect(asObject(core.getStatus(2000, 1000).members[0].ack)).toEqual({ x: 2 });
  });

  it('a hello at a STALE epoch is not an acknowledgement: it gets the current view instead', () => {
    const core = joined(['a.0', 'b.0']); // epoch 2
    const effects = core.onHello(hello('a.0', 1, { x: 8 }), 5000);
    expect(effects).toHaveLength(1);
    const [view] = ofType(effects, 'view');
    expect(view.view.epoch).toBe(2);
    const a = core.getStatus(5000, 1000).members.find((m) => m.id === 'a.0');
    expect(asObject(a?.ack ?? new Map())).toEqual({}); // the vector was NOT recorded
    expect(a?.lastHeard).toBe(5000); // but it was heard
  });

  it('a hello from an evicted replica is rejected with the current epoch and changes nothing', () => {
    const core = joined(['a.0', 'b.0']);
    core.startEviction('b.0');
    core.onPrepared({ from: 'a.0', target: 'b.0', epoch: 2, seq: 0 }, 6000);
    expect(core.getView().epoch).toBe(3);
    const effects = core.onHello(hello('b.0', 2, { 'b.0': 4 }), 7000);
    expect(effects).toEqual([{ type: 'rejected', to: 'b.0', epoch: 3 }]);
    expect(core.getView().activeMembers.has('b.0')).toBe(false);
  });
});

describe('malformed hello messages are ignored: no effects, no change, no throw', () => {
  const BAD: unknown[] = [
    null,
    undefined,
    'hello',
    42,
    [],
    {},
    { from: 'a.0' },
    { from: 'a.0', epoch: 0 },
    { from: 'a.0', epoch: 0, vv: {} }, // a plain object, not a Map
    { from: 'a.0', epoch: 0, vv: [['a.0', 1]] },
    { from: '', epoch: 0, vv: new Map() },
    { from: 'a:1', epoch: 0, vv: new Map() },
    { from: 'has space', epoch: 0, vv: new Map() },
    { from: 7, epoch: 0, vv: new Map() },
    { from: 'a.0', epoch: -1, vv: new Map() },
    { from: 'a.0', epoch: 1.5, vv: new Map() },
    { from: 'a.0', epoch: NaN, vv: new Map() },
    { from: 'a.0', epoch: '0', vv: new Map() },
    { from: 'a.0', epoch: 0, vv: new Map([['a.0', -1]]) },
    { from: 'a.0', epoch: 0, vv: new Map([['a.0', 1.5]]) },
    { from: 'a.0', epoch: 0, vv: new Map([['a.0', '3']]) },
    { from: 'a.0', epoch: 0, vv: new Map([['bad:id', 3]]) },
    { from: 'a.0', epoch: 0, vv: new Map([['a.0', Infinity]]) },
  ];

  it.each(BAD.map((m) => [m]))('ignores %j', (message) => {
    const core = joined(['m.0']);
    const before = JSON.stringify([core.getView().epoch, [...core.getView().activeMembers], core.getStatus(0, 1).members.map((m) => [m.id, m.lastHeard])]);
    expect(core.onHello(message as HelloMessage, 9000)).toEqual([]);
    const after = JSON.stringify([core.getView().epoch, [...core.getView().activeMembers], core.getStatus(0, 1).members.map((m) => [m.id, m.lastHeard])]);
    expect(after).toBe(before);
  });

  it('throws only for a non-finite clock, which is a bug in the caller, not untrusted input', () => {
    const core = new CoordinatorCore();
    for (const now of [NaN, Infinity, '5' as unknown as number, undefined as unknown as number]) {
      expect(() => core.onHello(hello('a.0', 0), now)).toThrow(RangeError);
    }
  });
});

describe('the stable frontier', () => {
  it('is the minimum over the ACTIVE members, so a member that has not caught up holds it back', () => {
    const core = joined(['a.0', 'b.0']); // epoch 2
    core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3000);
    core.onHello(hello('b.0', 2, { 'a.0': 3 }), 3001);
    expect(asObject(core.getFrontier())).toEqual({ 'a.0': 3 });
  });

  it('a member that has not acknowledged anything yet holds everything back', () => {
    const core = joined(['a.0', 'b.0']);
    core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3000);
    expect(core.getFrontier().size).toBe(0);
  });

  it('never moves backwards: a new, empty member lowers the minimum but not the published frontier', () => {
    const core = joined(['a.0', 'b.0']);
    core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3000);
    core.onHello(hello('b.0', 2, { 'a.0': 5 }), 3001);
    expect(asObject(core.getFrontier())).toEqual({ 'a.0': 5 });
    core.onHello(hello('late.0', 0), 3002); // joins with nothing
    expect(asObject(core.getFrontier())).toEqual({ 'a.0': 5 });
  });

  it('is broadcast when it grows, with the epoch it was computed for', () => {
    const core = joined(['a.0', 'b.0']);
    core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3000);
    const effects = core.onHello(hello('b.0', 2, { 'a.0': 3 }), 3001);
    expect(ofType(effects, 'frontier')).toEqual([{ type: 'frontier', epoch: 2, vv: vv({ 'a.0': 3 }) }]);
  });

  it('is not broadcast again until it grows or the resend interval has passed', () => {
    const core = joined(['a.0', 'b.0'], { frontierResendMs: 3000 });
    core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3000);
    core.onHello(hello('b.0', 2, { 'a.0': 3 }), 3001); // broadcast at 3001
    expect(ofType(core.onHello(hello('a.0', 2, { 'a.0': 5 }), 3500), 'frontier')).toEqual([]); // unchanged, too soon
    expect(ofType(core.onHello(hello('a.0', 2, { 'a.0': 5 }), 6000), 'frontier')).toHaveLength(0); // 2999 ms since the last send
    const again = core.onHello(hello('a.0', 2, { 'a.0': 5 }), 6001); // 3000 ms: resend, so a lost message cannot strand GC
    expect(ofType(again, 'frontier')).toHaveLength(1);
    expect(ofType(core.onHello(hello('b.0', 2, { 'a.0': 5 }), 6002), 'frontier')).toHaveLength(1); // it grew (3 to 5)
  });

  it('sends no frontier while it is empty', () => {
    const core = joined(['a.0']);
    expect(ofType(core.onHello(hello('a.0', 1), 9999), 'frontier')).toEqual([]);
  });

  it('a stale-epoch hello does not feed the frontier', () => {
    const core = joined(['a.0', 'b.0']);
    core.onHello(hello('a.0', 2, { x: 4 }), 3000);
    core.onHello(hello('b.0', 1, { x: 4 }), 3001); // stale: not recorded
    expect(core.getFrontier().size).toBe(0);
  });

  it('the payloads of effects are copies: an adapter that edits them cannot corrupt the coordinator', () => {
    const core = new CoordinatorCore();
    const joinEffects = core.onHello(hello('a.0', 0, { x: 3 }), 100);
    const [view] = ofType(joinEffects, 'view');
    view.view.activeMembers.add('hacker.0');
    view.view.evictedMembers.set('a.0', 0);
    view.view.epoch = 99;
    for (const f of ofType(joinEffects, 'frontier')) f.vv.set('x', 999);
    expect([...core.getView().activeMembers]).toEqual(['a.0']);
    expect(core.getView().evictedMembers.size).toBe(0);
    expect(core.getView().epoch).toBe(1);
    expect(core.getFrontier().get('x')).toBe(3);

    core.onHello(hello('b.0', 1, { x: 3 }), 101);
    const effects = core.startEviction('b.0');
    expect(effects.ok).toBe(true);
    if (effects.ok) {
      const [prepare] = ofType(effects.effects, 'prepare');
      prepare.survivors.push('hacker.0');
    }
    expect(core.getStatus(0, 1).eviction?.waitingFor).toEqual(['a.0']);
  });

  it('getFrontier and getView return copies', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 1, { x: 2 }), 3000);
    core.getFrontier().set('x', 99);
    core.getView().activeMembers.add('hacker');
    expect(core.getFrontier().get('x')).toBe(2);
    expect(core.getView().activeMembers.has('hacker')).toBe(false);
  });
});

describe('getStatus', () => {
  it('marks a member stalled when it has been silent for longer than the limit (detection only, nobody is evicted)', () => {
    const core = joined(['a.0', 'b.0']);
    core.onHello(hello('a.0', 2), 5000);
    core.onHello(hello('b.0', 2), 1000);
    const members = core.getStatus(6000, 3000).members;
    expect(members.map((m) => [m.id, m.stalled])).toEqual([['a.0', false], ['b.0', true]]);
    expect(core.getView().activeMembers.has('b.0')).toBe(true);
    expect(core.getView().epoch).toBe(2);
  });

  it('the boundary is exact: silent for exactly the limit is not stalled', () => {
    const core = joined(['a.0']);
    core.onHello(hello('a.0', 1), 5000);
    expect(core.getStatus(8000, 3000).members[0].stalled).toBe(false);
    expect(core.getStatus(8001, 3000).members[0].stalled).toBe(true);
  });

  it('returns copies, sorted by replica ID', () => {
    const core = joined(['c.0', 'a.0', 'b.0']);
    const status = core.getStatus(0, 1);
    expect(status.members.map((m) => m.id)).toEqual(['a.0', 'b.0', 'c.0']);
    status.members[0].ack.set('x', 1);
    expect(core.getStatus(0, 1).members[0].ack.has('x')).toBe(false);
  });

  it('is deterministic: the same calls always give the same effects', () => {
    const replacer = (_key: string, value: unknown): unknown =>
      value instanceof Map ? [...value] : value instanceof Set ? [...value] : value;
    const run = (): string => {
      const core = new CoordinatorCore();
      return JSON.stringify(
        [
          core.onHello(hello('a.0', 0, { x: 1 }), 1),
          core.onHello(hello('b.0', 0, { x: 2 }), 2),
          core.onHello(hello('a.0', 2, { x: 4 }), 3),
          core.onHello(hello('b.0', 2, { x: 3 }), 4),
          core.getStatus(10, 5),
        ],
        replacer
      );
    };
    expect(run()).toBe(run());
  });
});
