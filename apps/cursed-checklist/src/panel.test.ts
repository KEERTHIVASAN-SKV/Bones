/**
 * The Graveyard panel's numbers (panelModel) and the Stress button's work (runStress).
 * The React component only renders what panelModel returns, so the numbers are tested here
 * without a browser; the rendering was checked by hand in real Edge tabs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MembershipView } from '@bones/kernel';
import { panelModel, runStress, STRESS_COUNT, STRESS_LENGTH } from './panel';
import { createReplica, isItem, visibleItems } from './replica';
import { startSync } from './sync';
import type { Sync } from './sync';
import { encodeFrontier, encodeOp, encodeView } from './protocol';
import { createBus, createManualTransport } from './test-support';

const running: Sync[] = [];
function start(...args: Parameters<typeof startSync>): Sync {
  const sync = startSync(...args);
  running.push(sync);
  return sync;
}
afterEach(() => {
  for (const sync of running.splice(0)) sync.stop();
  vi.useRealTimers();
});

const view = (active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView => ({
  activeMembers: new Set(active),
  evictedMembers: new Map(evicted),
  epoch,
});

describe('panelModel', () => {
  it('a fresh replica with no control page: zeros, itself as the only member, and not "coordinated"', () => {
    const crdt = createReplica('a.0');
    const sync = start(crdt, createManualTransport());
    expect(panelModel(crdt, sync.getStats())).toEqual({
      coordinated: false,
      epoch: 0,
      members: ['a.0'],
      evicted: [],
      tombstones: 0,
      payloadsReclaimed: 0,
      bytesReclaimed: 0,
      frontier: [],
      refused: [],
      paused: false,
      unsent: 0,
    });
  });

  it('counts a tombstone for every buried item; reclaiming a payload does NOT lower the count (the structure is kept)', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['a.0'], [], 1)));
    const ops = [crdt.insert(undefined, { text: 'one' }), crdt.insert(undefined, { text: 'two' })];
    for (const op of ops) crdt.delete(op.id);

    const before = panelModel(crdt, sync.getStats());
    expect(before).toMatchObject({ coordinated: true, epoch: 1, tombstones: 2, payloadsReclaimed: 0, bytesReclaimed: 0 });

    t.receive(encodeFrontier(1, new Map([['a.0', 4]])));
    const after = panelModel(crdt, sync.getStats());
    expect(after.tombstones).toBe(2); // unchanged
    expect(after.payloadsReclaimed).toBe(2);
    expect(after.bytesReclaimed).toBeGreaterThan(0);
    expect(after.frontier).toEqual([['a.0', 4]]);
  });

  it('lists members and evicted tabs sorted, with their cutoffs', () => {
    const t = createManualTransport();
    const crdt = createReplica('b.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['c.0', 'b.0', 'a.0'], [['z.0', 4], ['d.0', 0]], 5)));
    const model = panelModel(crdt, sync.getStats());
    expect(model.members).toEqual(['a.0', 'b.0', 'c.0']);
    expect(model.evicted).toEqual([{ id: 'd.0', cutoff: 0 }, { id: 'z.0', cutoff: 4 }]);
  });

  it('sorts members, evicted tabs and the frontier itself, whatever order the kernel holds them in', () => {
    // fed to the kernel directly, in scrambled order (the wire format would sort them before the panel saw them)
    const crdt = createReplica('m.0');
    const sync = start(crdt, createManualTransport());
    crdt.updateMembership(view(['z.0', 'm.0', 'a.0'], [['y.0', 2], ['b.0', 1]], 4));
    crdt.updateStableFrontier(new Map([['z.0', 3], ['a.0', 1], ['m.0', 2]]), 4);
    const model = panelModel(crdt, sync.getStats());
    expect(model.members).toEqual(['a.0', 'm.0', 'z.0']);
    expect(model.evicted.map((e) => e.id)).toEqual(['b.0', 'y.0']);
    expect(model.frontier).toEqual([['a.0', 1], ['m.0', 2], ['z.0', 3]]);
  });

  it('reports operations refused by fencing per author, and the paused and unsent counters', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['a.0'], [['c.0', 0]], 2)));
    const c = createReplica('c.0');
    t.receive(encodeOp(c.insert(undefined, { text: 'refused' })));
    sync.pause();
    sync.sendOp(crdt.insert(undefined, { text: 'mine' }));
    expect(panelModel(crdt, sync.getStats())).toMatchObject({
      refused: [{ author: 'c.0', count: 1 }],
      paused: true,
      unsent: 1,
    });
  });

  it('sorts refused authors by ID, and is a snapshot (changing it changes nothing)', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['a.0'], [['z.0', 0], ['c.0', 0]], 2)));
    for (const id of ['z.0', 'c.0']) t.receive(encodeOp(createReplica(id).insert(undefined, { text: 'x' })));
    const model = panelModel(crdt, sync.getStats());
    expect(model.refused.map((r) => r.author)).toEqual(['c.0', 'z.0']);
    model.members.push('hacker');
    model.frontier.push(['x', 1]);
    expect(panelModel(crdt, sync.getStats()).members).toEqual(['a.0']);
  });
});

describe('runStress: 200 items of about 100 characters, then bury them all, through the normal path', () => {
  it('adds and buries exactly STRESS_COUNT items; each is a valid item of STRESS_LENGTH characters', () => {
    expect(STRESS_COUNT).toBe(200);
    expect(STRESS_LENGTH).toBe(100);
    const crdt = createReplica('a.0');
    const sent: string[] = [];
    const sync = { sendOp: (op: { id: string }) => sent.push(op.id) } as unknown as Sync;
    const result = runStress(crdt, sync);

    expect(result).toEqual({ added: 200, buried: 200 });
    expect(visibleItems(crdt)).toHaveLength(0); // everything is buried
    const all = crdt.getAllElements();
    expect(all).toHaveLength(200);
    expect(all.every((e) => e.deleted)).toBe(true);
    expect(all.every((e) => isItem(e.value) && (e.value as { text: string }).text.length === 100)).toBe(true);
    expect(sent).toHaveLength(400); // 200 inserts and 200 deletes, each broadcast like a user's click
  });

  it('lands after the items already there, and leaves them alone', () => {
    const crdt = createReplica('a.0');
    const keep = crdt.insert(undefined, { text: 'keep me' });
    runStress(crdt, { sendOp: () => undefined } as unknown as Sync);
    expect(visibleItems(crdt).map((e) => e.value.text)).toEqual(['keep me']);
    expect(crdt.getAllElements()[0].id).toBe(keep.id);
  });

  it('reaches other tabs: they end up with the same tombstones and the same (empty) visible list', () => {
    const bus = createBus();
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const syncA = start(a, bus.connect());
    start(b, bus.connect());
    runStress(a, syncA);
    expect(b.getAllElements()).toHaveLength(200);
    expect(visibleItems(b)).toHaveLength(0);
    expect(panelModel(b, { paused: false, unsent: 0, fenced: {} }).tombstones).toBe(200);
  });

  it('stops quietly when the tab was exorcised: it reports what it did, and nothing throws', () => {
    const t = createManualTransport();
    const crdt = createReplica('c.0');
    start(crdt, t);
    t.receive(encodeView(view(['a.0'], [['c.0', 25]], 2))); // may write 25 operations at most
    const result = runStress(crdt, { sendOp: () => undefined } as unknown as Sync);
    expect(result.refused).toBe(true);
    expect(result.added + result.buried).toBe(25);
  });

  it('with the panel and a coordinator frontier, stress turns into reclaimed bytes', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['a.0'], [], 1)));
    runStress(crdt, sync);
    expect(panelModel(crdt, sync.getStats())).toMatchObject({ tombstones: 200, payloadsReclaimed: 0, bytesReclaimed: 0 });
    t.receive(encodeFrontier(1, new Map([['a.0', 400]])));
    const model = panelModel(crdt, sync.getStats());
    expect(model.tombstones).toBe(200); // structure kept
    expect(model.payloadsReclaimed).toBe(200);
    expect(model.bytesReclaimed).toBeGreaterThan(200 * 100); // each payload is at least its 100 characters
  });
});
