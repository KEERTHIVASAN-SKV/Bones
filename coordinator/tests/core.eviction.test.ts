/**
 * CoordinatorCore: the manual two-phase eviction (requirements.md 10.3; KER-077).
 * prepare (survivors freeze the target and reply with their contiguous applied seq) ->
 * cutoff = MAX of the replies -> publish (epoch + 1, cutoff recorded) -> pending until every
 * active member's acknowledged vector holds the target's operations up to the cutoff.
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

/** a.0, b.0, c.0 joined (epoch 3) and each acknowledged at epoch 3 with `acks`. */
function three(acks: Record<string, Record<string, number>> = {}): CoordinatorCore {
  const core = new CoordinatorCore();
  for (const id of ['a.0', 'b.0', 'c.0']) core.onHello(hello(id, 0), 1000);
  for (const id of ['a.0', 'b.0', 'c.0']) core.onHello(hello(id, 3, acks[id] ?? {}), 2000);
  return core;
}

describe('startEviction (the operator pressed Exorcise)', () => {
  it('asks every OTHER active member to freeze the target, and changes no membership yet', () => {
    const core = three();
    const result = core.startEviction('c.0');
    expect(result).toEqual({
      ok: true,
      effects: [{ type: 'prepare', target: 'c.0', epoch: 3, survivors: ['a.0', 'b.0'] }],
    });
    expect(core.getView().epoch).toBe(3);
    expect(core.getView().activeMembers.has('c.0')).toBe(true);
    expect(core.getStatus(2000, 1000).eviction).toEqual({ target: 'c.0', waitingFor: ['a.0', 'b.0'] });
  });

  it('refuses a replica that is not an active member, an invalid ID, a second eviction, and a lone member', () => {
    const core = three();
    expect(core.startEviction('ghost.0')).toEqual({ ok: false, reason: 'not-a-member' });
    expect(core.startEviction('bad:id')).toEqual({ ok: false, reason: 'invalid-id' });
    expect(core.startEviction(7 as unknown as string)).toEqual({ ok: false, reason: 'invalid-id' });
    expect(core.startEviction('c.0').ok).toBe(true);
    expect(core.startEviction('b.0')).toEqual({ ok: false, reason: 'eviction-in-progress' });

    const alone = new CoordinatorCore();
    alone.onHello(hello('only.0', 0), 1);
    expect(alone.startEviction('only.0')).toEqual({ ok: false, reason: 'no-survivors' });
  });

  it('never happens by itself: silence, however long, evicts nobody', () => {
    const core = three();
    expect(core.getStatus(10_000_000, 1000).members.every((m) => m.stalled)).toBe(true);
    expect(core.getView().epoch).toBe(3);
    expect(core.getStatus(10_000_000, 1000).eviction).toBeNull();
  });
});

describe('prepared: the cutoff is the MAX of the survivors\' replies', () => {
  it('waits for every survivor, then publishes the view with epoch + 1 and the cutoff', () => {
    const core = three();
    core.startEviction('c.0');
    expect(core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 4 }, 3000)).toEqual([]); // still waiting for b
    expect(core.getStatus(3000, 1000).eviction).toEqual({ target: 'c.0', waitingFor: ['b.0'] });

    const effects = core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 7 }, 3001);
    const [published] = ofType(effects, 'view');
    expect(published.view.epoch).toBe(4);
    expect([...published.view.activeMembers].sort()).toEqual(['a.0', 'b.0']);
    expect(published.view.evictedMembers.get('c.0')).toBe(7); // max(4, 7)
    expect(core.getStatus(3001, 1000).eviction).toBeNull();
  });

  it.each([
    [[0, 0], 0],
    [[5, 5], 5],
    [[9, 2], 9],
    [[2, 9], 9],
  ])('replies %j give the cutoff %i, whatever the order they arrive in', (replies, expected) => {
    for (const order of [[0, 1], [1, 0]]) {
      const core = three();
      core.startEviction('c.0');
      const survivors = ['a.0', 'b.0'];
      let effects: Effect[] = [];
      for (const i of order) effects = core.onPrepared({ from: survivors[i], target: 'c.0', epoch: 3, seq: replies[i] }, 3000);
      expect(ofType(effects, 'view')[0].view.evictedMembers.get('c.0')).toBe(expected);
    }
  });

  it('the evicted member leaves the active set at once, and its acknowledgement stops counting', () => {
    const core = three({ 'a.0': { 'a.0': 6, 'c.0': 3 }, 'b.0': { 'a.0': 6, 'c.0': 3 }, 'c.0': { 'a.0': 1 } });
    expect(asObject(core.getFrontier())).toEqual({ 'a.0': 1 }); // c holds everything back
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 3 }, 3000);
    const effects = core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 3 }, 3001);
    expect(asObject(core.getFrontier())).toEqual({ 'a.0': 6, 'c.0': 3 }); // liveness: the frontier moved
    const [frontier] = ofType(effects, 'frontier');
    expect(frontier.epoch).toBe(4); // for the NEW epoch
    expect(asObject(frontier.vv)).toEqual({ 'a.0': 6, 'c.0': 3 });
  });

  it('publishes the frontier at the new epoch even if it did not grow (every tab needs it at the new epoch)', () => {
    const core = three({ 'a.0': { 'a.0': 2 }, 'b.0': { 'a.0': 2 }, 'c.0': { 'a.0': 2 } });
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 0 }, 3000);
    const effects = core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 0 }, 3001);
    expect(ofType(effects, 'frontier')).toEqual([{ type: 'frontier', epoch: 4, vv: vv({ 'a.0': 2 }) }]);
  });

  it('the FIRST reply of a survivor wins: a repeated or forged second reply cannot inflate the cutoff', () => {
    const core = three();
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 2 }, 3000);
    expect(core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 999 }, 3001)).toEqual([]);
    const effects = core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 1 }, 3002);
    expect(ofType(effects, 'view')[0].view.evictedMembers.get('c.0')).toBe(2);
  });

  it('ignores replies it did not ask for: no eviction, the wrong target, a non-survivor, the target itself', () => {
    const idle = three();
    expect(idle.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 1 }, 3000)).toEqual([]);

    const core = three();
    core.startEviction('c.0');
    expect(core.onPrepared({ from: 'a.0', target: 'b.0', epoch: 3, seq: 1 }, 3000)).toEqual([]); // wrong target
    expect(core.onPrepared({ from: 'stranger.0', target: 'c.0', epoch: 3, seq: 1 }, 3000)).toEqual([]);
    expect(core.onPrepared({ from: 'c.0', target: 'c.0', epoch: 3, seq: 99 }, 3000)).toEqual([]); // the target does not vote
    expect(core.getStatus(3000, 1000).eviction?.waitingFor).toEqual(['a.0', 'b.0']);
  });

  it.each([
    [{ from: 'a.0', target: 'c.0', epoch: 3, seq: -1 }],
    [{ from: 'a.0', target: 'c.0', epoch: 3, seq: 1.5 }],
    [{ from: 'a.0', target: 'c.0', epoch: 3, seq: NaN }],
    [{ from: 'a.0', target: 'c.0', epoch: 3, seq: '2' }],
    [{ from: 'a.0', target: 'c.0', epoch: 3, seq: Infinity }],
    [{ from: 'a.0', target: 'c.0', epoch: -1, seq: 1 }],
    [{ from: 'a.0', target: 'c.0', epoch: '3', seq: 1 }],
    [{ from: 5, target: 'c.0', epoch: 3, seq: 1 }],
    [{ from: 'a.0', target: 5, epoch: 3, seq: 1 }],
    [null],
    [undefined],
    ['prepared'],
  ])('ignores the malformed reply %j', (message) => {
    const core = three();
    core.startEviction('c.0');
    expect(core.onPrepared(message as never, 3000)).toEqual([]);
    expect(core.getStatus(3000, 1000).eviction?.waitingFor).toEqual(['a.0', 'b.0']);
  });

  it('a reply from an old epoch is rejected with the current epoch, and does not count', () => {
    const core = three();
    core.startEviction('c.0');
    expect(core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 1, seq: 5 }, 3000)).toEqual([{ type: 'rejected', to: 'a.0', epoch: 3 }]);
    expect(core.getStatus(3000, 1000).eviction?.waitingFor).toEqual(['a.0', 'b.0']);
  });
});

describe('while the eviction is being prepared', () => {
  it('a survivor that has not replied is asked again when it says hello (a lost prepare is retried)', () => {
    const core = three();
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 1 }, 3000);
    const toB = core.onHello(hello('b.0', 3), 4000);
    expect(ofType(toB, 'prepare')).toEqual([{ type: 'prepare', target: 'c.0', epoch: 3, survivors: ['a.0', 'b.0'] }]);
    expect(ofType(core.onHello(hello('a.0', 3), 4000), 'prepare')).toEqual([]); // a already replied
    expect(ofType(core.onHello(hello('c.0', 3), 4000), 'prepare')).toEqual([]); // the target is not asked
  });

  it('a newcomer is NOT joined mid-prepare (it was never asked to freeze the target); it joins on a later hello', () => {
    const core = three();
    core.startEviction('c.0');
    expect(core.onHello(hello('late.0', 0), 3000)).toEqual([]);
    expect(core.getView().activeMembers.has('late.0')).toBe(false);
    expect(core.getView().epoch).toBe(3);

    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 0 }, 3001);
    core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 0 }, 3002); // published: epoch 4
    const joined = core.onHello(hello('late.0', 0), 3003);
    expect(ofType(joined, 'view')[0].view.epoch).toBe(5);
    expect(core.getView().activeMembers.has('late.0')).toBe(true);
  });

  it('the target keeps being acknowledged until the view is published', () => {
    const core = three();
    core.startEviction('c.0');
    core.onHello(hello('c.0', 3, { 'c.0': 4 }), 3500);
    expect(asObject(core.getStatus(3500, 1000).members.find((m) => m.id === 'c.0')?.ack ?? new Map())).toEqual({ 'c.0': 4 });
  });
});

describe('abortEviction (the operator backs out during the prepare phase)', () => {
  it('tells the survivors to release the target, changes no membership, and lets a new eviction start', () => {
    const core = three();
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: 4 }, 3000);
    expect(core.abortEviction()).toEqual([{ type: 'release', target: 'c.0', survivors: ['a.0', 'b.0'] }]);
    expect(core.getView().epoch).toBe(3);
    expect(core.getView().activeMembers.has('c.0')).toBe(true);
    expect(core.getStatus(3000, 1000).eviction).toBeNull();
    expect(core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: 4 }, 3001)).toEqual([]); // late reply: nothing happens
    expect(core.startEviction('b.0').ok).toBe(true); // e.g. the stalled survivor is exorcised instead
  });

  it('does nothing when no eviction is being prepared', () => {
    expect(three().abortEviction()).toEqual([]);
  });
});

describe('after the publish the eviction is PENDING until every active member holds the target\'s operations up to the cutoff', () => {
  function evicted(cutoffReplies: [number, number]) {
    const core = three({ 'a.0': { 'c.0': cutoffReplies[0] }, 'b.0': { 'c.0': cutoffReplies[1] } });
    core.startEviction('c.0');
    core.onPrepared({ from: 'a.0', target: 'c.0', epoch: 3, seq: cutoffReplies[0] }, 3000);
    core.onPrepared({ from: 'b.0', target: 'c.0', epoch: 3, seq: cutoffReplies[1] }, 3001);
    return core;
  }

  it('lists who still has to backfill: the survivor whose acknowledged vector is below the cutoff', () => {
    const core = evicted([6, 4]); // cutoff 6; b only holds 4
    expect(core.getStatus(3002, 1000).evicted).toEqual([{ id: 'c.0', cutoff: 6, waitingFor: ['b.0'], complete: false }]);
  });

  it('completes when that survivor\'s next hello shows it holds the operations (that hello is the confirmation)', () => {
    const core = evicted([6, 4]);
    core.onHello(hello('b.0', 4, { 'c.0': 6 }), 4000);
    expect(core.getStatus(4000, 1000).evicted).toEqual([{ id: 'c.0', cutoff: 6, waitingFor: [], complete: true }]);
  });

  it('is complete at once when every survivor already holds the cutoff, and when the cutoff is 0', () => {
    expect(evicted([5, 5]).getStatus(3002, 1000).evicted[0].complete).toBe(true);
    expect(evicted([0, 0]).getStatus(3002, 1000).evicted[0]).toEqual({ id: 'c.0', cutoff: 0, waitingFor: [], complete: true });
  });

  it('holds the frontier back for the target\'s entry while a survivor has not backfilled (nothing of the target is reclaimed early)', () => {
    const core = evicted([6, 4]);
    expect(core.getFrontier().get('c.0')).toBe(4); // min over the survivors
    core.onHello(hello('b.0', 4, { 'c.0': 6 }), 4000);
    expect(core.getFrontier().get('c.0')).toBe(6);
  });

  it('a member that joins after the eviction must also catch up before it completes', () => {
    const core = evicted([3, 3]);
    expect(core.getStatus(3002, 1000).evicted[0].complete).toBe(true);
    core.onHello(hello('n.0', 0), 4000); // joins empty
    expect(core.getStatus(4000, 1000).evicted[0]).toMatchObject({ complete: false, waitingFor: ['n.0'] });
  });

  it('the evicted member can never return under the same ID (its hello is rejected from then on)', () => {
    const core = evicted([2, 2]);
    expect(core.onHello(hello('c.0', 4), 5000)).toEqual([{ type: 'rejected', to: 'c.0', epoch: 4 }]);
    expect(core.getView().activeMembers.has('c.0')).toBe(false);
  });

  it('a second eviction can start while the first is still pending', () => {
    const core = evicted([6, 4]);
    expect(core.startEviction('b.0')).toEqual({
      ok: true,
      effects: [{ type: 'prepare', target: 'b.0', epoch: 4, survivors: ['a.0'] }],
    });
  });

  it('once the lagging survivor is itself evicted it no longer blocks the first one', () => {
    const core = evicted([6, 4]);
    core.startEviction('b.0');
    core.onPrepared({ from: 'a.0', target: 'b.0', epoch: 4, seq: 0 }, 4000);
    const status = core.getStatus(4000, 1000);
    expect(status.epoch).toBe(5);
    expect(status.members.map((m) => m.id)).toEqual(['a.0']);
    // only a.0 is left, and it holds c.0's operations up to the cutoff (6): nobody is waiting for any more
    expect(status.evicted.find((e) => e.id === 'c.0')).toEqual({ id: 'c.0', cutoff: 6, waitingFor: [], complete: true });
  });
});
