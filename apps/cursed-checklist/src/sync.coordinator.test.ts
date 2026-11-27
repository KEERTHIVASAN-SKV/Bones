/**
 * sync.ts and the coordinator's messages (wire v2): view, frontier, prepare/release, plus pause and
 * the counters the panel shows. One smoke test per feature, as planned; the hostile-input table for
 * the whole parser is in protocol.test.ts and sync.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MembershipView } from '@bones/kernel';
import { createReplica, visibleItems } from './replica';
import type { Item } from './replica';
import { HELLO_INTERVAL_MS, startSync } from './sync';
import type { Sync } from './sync';
import {
  decode,
  encodeFrontier,
  encodeHello,
  encodeOp,
  encodePrepare,
  encodeRelease,
  encodeView,
} from './protocol';
import { createBus, createManualTransport } from './test-support';
import type { Incoming } from './protocol';

const running: Sync[] = [];
function start(...args: Parameters<typeof startSync<Item>>): Sync {
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
const texts = (c: ReturnType<typeof createReplica>): string[] => visibleItems(c).map((e) => e.value.text);
const sentOfType = (sent: string[], t: Incoming['t']): Incoming[] =>
  sent.map((s) => decode(s)).filter((m): m is Incoming => m !== null && m.t === t);

describe('hello says who it is and which epoch it is at', () => {
  it('after a view is installed, the next hello carries the new epoch', () => {
    vi.useFakeTimers();
    const t = createManualTransport();
    start(createReplica('a.0'), t);
    t.receive(encodeView(view(['a.0'], [], 4)));
    vi.advanceTimersByTime(HELLO_INTERVAL_MS);
    const hellos = sentOfType(t.sent, 'hello');
    expect(hellos.map((h) => (h.t === 'hello' ? [h.from, h.epoch] : null))).toEqual([['a.0', 0], ['a.0', 4]]);
  });
});

describe('the coordinator\'s messages reach the kernel', () => {
  it('a view installs the membership; a malformed view is ignored', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    t.receive(encodeView(view(['a.0', 'b.0'], [['c.0', 2]], 3)));
    expect(crdt.getMembershipView()).toEqual(view(['a.0', 'b.0'], [['c.0', 2]], 3));
    t.receive('{"t":"view","view":{"activeMembers":["a.0"],"epoch":9,"evictedMembers":{"a.0":1}}}');
    t.receive('{"t":"view","view":null}');
    expect(crdt.getMembershipView().epoch).toBe(3);
  });

  it('a frontier for this replica\'s epoch reclaims payloads; one for another epoch is ignored', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    const item = crdt.insert(undefined, { text: 'secret' });
    crdt.delete(item.id);
    t.receive(encodeView(view(['a.0'], [], 2)));

    t.receive(encodeFrontier(1, new Map([['a.0', 2]]))); // stale epoch
    expect(crdt.getGCStats().payloadsReclaimed).toBe(0);
    t.receive(encodeFrontier(2, new Map([['a.0', 2]])));
    expect(crdt.getGCStats().payloadsReclaimed).toBe(1);
    expect(crdt.getGCStats().bytesSaved).toBeGreaterThan(0);
  });

  it('prepare freezes the target and replies with the contiguous seq it holds; release ends the freeze', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    const c = createReplica('c.0');
    const c1 = c.insert(undefined, { text: 'one' });
    const c2 = c.insert(c1.id, { text: 'two' });
    t.receive(encodeOp(c1));
    t.sent.length = 0;

    t.receive(encodePrepare('c.0', 0));
    const [reply] = sentOfType(t.sent, 'prepared');
    expect(reply).toEqual({ t: 'prepared', from: 'a.0', target: 'c.0', epoch: 0, seq: 1 });
    expect(crdt.isAuthorHeld('c.0')).toBe(true);

    t.receive(encodeOp(c2)); // arrives after the freeze: buffered, not applied
    expect(texts(crdt)).toEqual(['one']);
    expect(crdt.getPendingCount()).toBe(1);

    t.receive(encodeRelease('c.0'));
    expect(texts(crdt)).toEqual(['one', 'two']);
    expect(crdt.isAuthorHeld('c.0')).toBe(false);
  });

  it('prepare is ignored when it names this tab, or carries another epoch (a stale or replayed message)', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    t.receive(encodeView(view(['a.0', 'c.0'], [], 3)));
    t.sent.length = 0;
    t.receive(encodePrepare('a.0', 3)); // about me
    t.receive(encodePrepare('c.0', 2)); // stale
    t.receive(encodePrepare('c.0', 4)); // from the future
    expect(crdt.isAuthorHeld('c.0')).toBe(false);
    expect(sentOfType(t.sent, 'prepared')).toEqual([]);
  });

  it('the view that evicts a frozen tab ends the freeze: later operations beyond the cutoff are refused and counted', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    t.receive(encodeView(view(['a.0', 'c.0'], [], 1)));
    t.receive(encodePrepare('c.0', 1));
    t.receive(encodeView(view(['a.0'], [['c.0', 0]], 2)));
    expect(crdt.isAuthorHeld('c.0')).toBe(false);
    const late = createReplica('c.0').insert(undefined, { text: 'too late' });
    t.receive(encodeOp(late));
    expect(texts(crdt)).toEqual([]);
  });
});

describe('pause (the demo\'s "stall")', () => {
  it('a paused tab sends nothing and hears nothing, keeps its local edits, and counts the unsent ones', () => {
    vi.useFakeTimers();
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.sent.length = 0;
    sync.pause();
    expect(sync.isPaused()).toBe(true);

    vi.advanceTimersByTime(3 * HELLO_INTERVAL_MS);
    expect(t.sent).toEqual([]); // no hello while paused

    const mine = crdt.insert(undefined, { text: 'written while stalled' });
    sync.sendOp(mine);
    t.receive(encodeOp(createReplica('b.0').insert(undefined, { text: 'from another tab' })));
    t.receive(encodeHello('b.0', 0, new Map()));
    expect(t.sent).toEqual([]); // nothing sent, no reply to the hello
    expect(texts(crdt)).toEqual(['written while stalled']); // the other tab's operation was not heard
    expect(sync.getStats()).toMatchObject({ paused: true, unsent: 1 });
  });

  it('resume sends the operations made while paused, then says hello, and the other tab gets them', () => {
    const bus = createBus();
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const syncA = start(a, bus.connect());
    start(b, bus.connect());

    syncA.pause();
    syncA.sendOp(a.insert(undefined, { text: 'one' }));
    syncA.sendOp(a.insert(undefined, { text: 'two' }));
    expect(texts(b)).toEqual([]);
    expect(syncA.getStats().unsent).toBe(2);

    syncA.resume();
    expect(syncA.isPaused()).toBe(false);
    expect(syncA.getStats().unsent).toBe(0);
    expect(texts(b)).toEqual(texts(a));
    expect(texts(b)).toHaveLength(2);
  });

  it('resume sends the unsent operations first and then exactly one hello (so the tab learns what it missed)', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    sync.pause();
    sync.sendOp(crdt.insert(undefined, { text: 'one' }));
    t.sent.length = 0;
    sync.resume();
    expect(t.sent.map((s) => decode(s)?.t)).toEqual(['op', 'hello']);
    expect(sentOfType(t.sent, 'hello')[0]).toMatchObject({ t: 'hello', from: 'a.0', vv: new Map([['a.0', 1]]) });
  });

  it('pause and resume are idempotent, and do nothing after stop; subscribers hear every change', () => {
    const t = createManualTransport();
    const sync = start(createReplica('a.0'), t);
    let changes = 0;
    const unsubscribe = sync.subscribe(() => {
      changes++;
    });
    sync.pause();
    sync.pause();
    sync.resume();
    sync.resume();
    expect(changes).toBe(2);
    unsubscribe();
    sync.pause();
    expect(changes).toBe(2);
    sync.stop();
    sync.resume();
    expect(sync.isPaused()).toBe(true); // stop froze it as it was
  });
});

describe('operations refused by fencing are counted, once each', () => {
  it('stops remembering after 10,000 distinct refused operations, so a hostile peer cannot grow it without bound', () => {
    const t = createManualTransport();
    const sync = start(createReplica('a.0'), t);
    t.receive(encodeView(view(['a.0'], [['c.0', 0]], 2))); // every operation of c.0 is refused
    const c = createReplica('c.0');
    for (let i = 0; i < 10_050; i++) t.receive(encodeOp(c.insert(undefined, { text: 'x' })));
    expect(sync.getStats().fenced['c.0']).toBe(10_000);
  });

  it('counts distinct refused operations per author, not repeated deliveries, and tells subscribers', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    t.receive(encodeView(view(['a.0'], [['c.0', 1]], 2))); // c.0 evicted, cutoff 1
    let changes = 0;
    sync.subscribe(() => {
      changes++;
    });

    const c = createReplica('c.0');
    const c1 = c.insert(undefined, { text: 'ok' });
    const c2 = c.insert(c1.id, { text: 'refused 1' });
    const c3 = c.insert(c2.id, { text: 'refused 2' });
    t.receive(encodeOp(c1)); // within the cutoff: applied, not counted
    for (const op of [c2, c3, c2, c3, c2]) t.receive(encodeOp(op)); // each refused op arrives again and again

    expect(sync.getStats().fenced).toEqual({ 'c.0': 2 });
    expect(changes).toBe(2);
    expect(texts(crdt)).toEqual(['ok']);

    const stats = sync.getStats();
    stats.fenced['c.0'] = 99;
    expect(sync.getStats().fenced).toEqual({ 'c.0': 2 }); // a copy
  });
});
