/**
 * The coordinator adapter: connects the pure core (@bones/coordinator) to a transport and a clock
 * (the control page runs it in a browser). The last describe drives the REAL tab code (sync.ts,
 * protocol.ts, the kernel) with the adapter on a shared bus: the demo story without a browser.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { startCoordinator } from './coordinatorAdapter';
import type { CoordinatorAdapter } from './coordinatorAdapter';
import { decode, encodeHello, encodeOp, encodePrepared } from './protocol';
import type { Incoming } from './protocol';
import { createReplica, visibleItems } from './replica';
import { HELLO_INTERVAL_MS, startSync } from './sync';
import type { Sync } from './sync';
import { createBus, createManualTransport } from './test-support';

const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  vi.useRealTimers();
});
function coordinator(transport: Parameters<typeof startCoordinator>[0], clock: () => number): CoordinatorAdapter {
  const adapter = startCoordinator(transport, clock);
  stoppers.push(() => adapter.stop());
  return adapter;
}
const sentOf = (sent: string[], t: Incoming['t']): Incoming[] =>
  sent.map((s) => decode(s)).filter((m): m is Incoming => m !== null && m.t === t);
const vv = (entries: Record<string, number> = {}): Map<string, number> => new Map(Object.entries(entries));

describe('hello and join', () => {
  it('a hello from an unknown tab joins it: the adapter broadcasts the new view', () => {
    const t = createManualTransport();
    coordinator(t, () => 1000);
    t.receive(encodeHello('a.0', 0, vv()));
    const [view] = sentOf(t.sent, 'view');
    expect(view).toMatchObject({ t: 'view', view: { epoch: 1, activeMembers: new Set(['a.0']) } });
  });

  it('ignores a hello without who it is from, malformed messages, and messages meant for tabs', () => {
    const t = createManualTransport();
    const adapter = coordinator(t, () => 1000);
    for (const message of [
      '{"t":"hello","vv":{}}', // no from / epoch
      'nope', 5, null, undefined,
      '{"t":"hello","from":"bad:id","epoch":0,"vv":{}}',
      encodeOp(createReplica('x.0').insert(undefined, { text: 'x' })),
      '{"t":"view","view":{"activeMembers":["z.0"],"epoch":9,"evictedMembers":{}}}',
    ]) {
      expect(() => t.receive(message)).not.toThrow();
    }
    expect(t.sent).toEqual([]);
    expect(adapter.getStatus().members).toEqual([]);
  });

  it('timestamps hellos with the injected clock, and reports stalled members from it', () => {
    let now = 1000;
    const t = createManualTransport();
    const adapter = coordinator(t, () => now);
    t.receive(encodeHello('a.0', 0, vv()));
    expect(adapter.getStatus().members[0]).toMatchObject({ id: 'a.0', lastHeard: 1000, stalled: false });
    now = 1000 + 10_001;
    expect(adapter.getStatus().members[0].stalled).toBe(true);
  });
});

describe('Exorcise', () => {
  function threeJoined() {
    const t = createManualTransport();
    const adapter = coordinator(t, () => 5000);
    for (const id of ['a.0', 'b.0', 'c.0']) t.receive(encodeHello(id, 0, vv()));
    for (const id of ['a.0', 'b.0', 'c.0']) t.receive(encodeHello(id, 3, vv()));
    t.sent.length = 0;
    return { t, adapter };
  }

  it('asks the survivors to freeze the target; their replies publish the view with the cutoff = max', () => {
    const { t, adapter } = threeJoined();
    expect(adapter.exorcise('c.0')).toEqual({ ok: true });
    expect(sentOf(t.sent, 'prepare')).toEqual([{ t: 'prepare', target: 'c.0', epoch: 3 }]);
    expect(adapter.getStatus().eviction).toEqual({ target: 'c.0', waitingFor: ['a.0', 'b.0'] });

    t.receive(encodePrepared('a.0', 'c.0', 3, 4));
    expect(sentOf(t.sent, 'view')).toEqual([]); // still waiting for b
    t.receive(encodePrepared('b.0', 'c.0', 3, 7));
    const [view] = sentOf(t.sent, 'view');
    expect(view).toMatchObject({ t: 'view', view: { epoch: 4 } });
    expect(view.t === 'view' && view.view.evictedMembers.get('c.0')).toBe(7);
    expect(adapter.getStatus().eviction).toBeNull();
  });

  it('returns why it refused, and sends nothing', () => {
    const { t, adapter } = threeJoined();
    expect(adapter.exorcise('ghost.0')).toEqual({ ok: false, reason: 'not-a-member' });
    expect(adapter.exorcise('bad:id')).toEqual({ ok: false, reason: 'invalid-id' });
    adapter.exorcise('c.0');
    expect(adapter.exorcise('b.0')).toEqual({ ok: false, reason: 'eviction-in-progress' });
    expect(sentOf(t.sent, 'prepare')).toHaveLength(1);
  });

  it('abort tells the survivors to release the target', () => {
    const { t, adapter } = threeJoined();
    adapter.exorcise('c.0');
    t.sent.length = 0;
    adapter.abort();
    expect(sentOf(t.sent, 'release')).toEqual([{ t: 'release', target: 'c.0' }]);
    expect(adapter.getStatus().eviction).toBeNull();
    adapter.abort(); // nothing to abort: nothing sent
    expect(sentOf(t.sent, 'release')).toHaveLength(1);
  });

  it('an evicted tab that says hello is rejected and told the view (so it learns its cutoff)', () => {
    const { t, adapter } = threeJoined();
    adapter.exorcise('c.0');
    t.receive(encodePrepared('a.0', 'c.0', 3, 2));
    t.receive(encodePrepared('b.0', 'c.0', 3, 2));
    t.sent.length = 0;
    t.receive(encodeHello('c.0', 3, vv({ 'c.0': 5 })));
    expect(sentOf(t.sent, 'rejected')).toEqual([{ t: 'rejected', to: 'c.0', epoch: 4 }]);
    const [view] = sentOf(t.sent, 'view');
    expect(view.t === 'view' && view.view.evictedMembers.get('c.0')).toBe(2);
  });

  it('subscribers hear every change, and stop hearing after unsubscribe and stop', () => {
    const t = createManualTransport();
    const adapter = coordinator(t, () => 1);
    let changes = 0;
    const unsubscribe = adapter.subscribe(() => {
      changes++;
    });
    t.receive(encodeHello('a.0', 0, vv()));
    t.receive(encodeHello('b.0', 0, vv()));
    expect(changes).toBe(2);
    unsubscribe();
    t.receive(encodeHello('c.0', 0, vv()));
    expect(changes).toBe(2);
    adapter.stop();
    const before = t.sent.length;
    t.receive(encodeHello('d.0', 0, vv()));
    expect(t.sent.length).toBe(before); // stopped: hears nothing
  });

  it('exorcise and abort tell subscribers; aborting when nothing is being prepared does not', () => {
    const { adapter } = threeJoined();
    let changes = 0;
    adapter.subscribe(() => {
      changes++;
    });
    adapter.abort(); // nothing to abort
    expect(changes).toBe(0);
    adapter.exorcise('ghost.0'); // refused: nothing changed
    expect(changes).toBe(0);
    adapter.exorcise('c.0');
    expect(changes).toBe(1);
    adapter.abort();
    expect(changes).toBe(2);
  });

  it('messages meant for tabs, and malformed ones, do not notify subscribers (nothing changed)', () => {
    const t = createManualTransport();
    const adapter = coordinator(t, () => 1);
    t.receive(encodeHello('a.0', 0, vv()));
    t.receive(encodeHello('b.0', 0, vv()));
    let changes = 0;
    adapter.subscribe(() => {
      changes++;
    });
    t.receive(encodeOp(createReplica('x.0').insert(undefined, { text: 'x' })));
    t.receive('{"t":"view","view":{"activeMembers":["a.0"],"epoch":9,"evictedMembers":{}}}');
    t.receive('{"t":"frontier","epoch":1,"vv":{}}');
    t.receive('{"t":"prepare","target":"a.0","epoch":2}');
    t.receive('{"t":"hello","vv":{}}'); // anonymous
    t.receive('garbage');
    expect(changes).toBe(0);
  });

  it('after stop, subscribers are silent even when the operator keeps clicking', () => {
    const t = createManualTransport();
    const adapter = coordinator(t, () => 1);
    t.receive(encodeHello('a.0', 0, vv()));
    t.receive(encodeHello('b.0', 0, vv()));
    let changes = 0;
    adapter.subscribe(() => {
      changes++;
    });
    adapter.stop();
    adapter.exorcise('a.0');
    adapter.abort();
    expect(changes).toBe(0);
  });

  it('a transport that throws on send (a closed channel) does not crash the coordinator', () => {
    const t = createManualTransport();
    const adapter = coordinator(
      {
        send() {
          throw new Error('InvalidStateError: channel is closed');
        },
        onMessage: (handler) => t.onMessage(handler),
        close: () => undefined,
      },
      () => 1
    );
    expect(() => t.receive(encodeHello('a.0', 0, vv()))).not.toThrow();
    expect(() => t.receive(encodeHello('b.0', 0, vv()))).not.toThrow();
    expect(adapter.exorcise('a.0')).toEqual({ ok: true }); // the state still moved; only the broadcast was lost
    expect(() => adapter.abort()).not.toThrow();
  });

  it('a broken clock or listener cannot break the adapter', () => {
    const t = createManualTransport();
    const adapter = coordinator(t, () => NaN);
    expect(() => t.receive(encodeHello('a.0', 0, vv()))).not.toThrow();
    expect(adapter.getStatus().members).toEqual([]);

    const t2 = createManualTransport();
    const adapter2 = coordinator(t2, () => 1);
    adapter2.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => t2.receive(encodeHello('a.0', 0, vv()))).not.toThrow();
    expect(adapter2.getStatus().members).toHaveLength(1);
  });
});

describe('the demo story with the real tab code (no browser)', () => {
  interface Tab {
    id: string;
    crdt: ReturnType<typeof createReplica>;
    sync: Sync;
  }

  /** Three tabs and the coordinator on one bus; fake timers drive the hello intervals. */
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T10:00:00Z'));
    const bus = createBus();
    const adapter = coordinator(bus.connect(), () => Date.now());
    const tabs: Tab[] = ['a.0', 'b.0', 'c.0'].map((id) => {
      const crdt = createReplica(id);
      const sync = startSync(crdt, bus.connect());
      stoppers.push(() => sync.stop());
      return { id, crdt, sync };
    });
    const tick = (ms: number = HELLO_INTERVAL_MS): void => {
      vi.advanceTimersByTime(ms);
    };
    tick(); // every tab says hello again, now at the epoch the joins produced
    tick();
    return { adapter, tabs: Object.fromEntries(tabs.map((t) => [t.id, t])) as Record<string, Tab>, tick };
  }

  /** Add `n` items of ~60 characters on `tab`, each after the previous one, and return their IDs. */
  function addItems(tab: Tab, n: number) {
    const ids: string[] = [];
    let anchor: string | undefined;
    for (let i = 1; i <= n; i++) {
      const op = tab.crdt.insert(anchor as never, { text: `item-${i}-${'p'.repeat(60)}` });
      tab.sync.sendOp(op);
      ids.push(op.id);
      anchor = op.id;
    }
    return ids;
  }

  it('tabs join, items sync, and every tab learns the membership', () => {
    const { adapter, tabs } = setup();
    expect(adapter.getStatus().epoch).toBe(3);
    for (const tab of Object.values(tabs)) expect(tab.crdt.getMembershipView().epoch).toBe(3);
    addItems(tabs['a.0'], 3);
    for (const tab of Object.values(tabs)) expect(visibleItems(tab.crdt)).toHaveLength(3);
  });

  it('a stalled tab holds the frontier back; Exorcise moves it and reclaims the payloads; its later edits are refused', () => {
    const { adapter, tabs, tick } = setup();
    const [a, b, c] = [tabs['a.0'], tabs['b.0'], tabs['c.0']];
    const ids = addItems(a, 5);
    tick();

    // STALL c, then bury everything
    c.sync.pause();
    for (const id of ids) a.sync.sendOp(a.crdt.delete(id as never));
    tick(2 * HELLO_INTERVAL_MS);
    expect(a.crdt.getGCStats()).toMatchObject({ tombstoneCount: 5, payloadsReclaimed: 0, bytesSaved: 0 });
    expect(adapter.getStatus().frontier.get('a.0') ?? 0).toBeLessThan(10); // stuck behind c

    // EXORCISE c from the control page
    expect(adapter.exorcise('c.0')).toEqual({ ok: true });
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.getStatus().epoch).toBe(4);
    expect(adapter.getStatus().members.map((m) => m.id)).toEqual(['a.0', 'b.0']);
    for (const tab of [a, b]) {
      expect(tab.crdt.getMembershipView().epoch).toBe(4);
      const stats = tab.crdt.getGCStats();
      expect(stats.payloadsReclaimed).toBe(5);
      expect(stats.tombstoneCount).toBe(5); // the structure stays
      expect(stats.bytesSaved).toBeGreaterThan(5 * 60);
    }

    // c kept typing while stalled (its kernel does not know it was evicted): the edits are unsent
    c.sync.sendOp(c.crdt.insert(undefined, { text: 'written while stalled 1' }));
    c.sync.sendOp(c.crdt.insert(undefined, { text: 'written while stalled 2' }));
    expect(c.sync.getStats().unsent).toBe(2);

    // c resumes: the edits go out first, and the survivors REFUSE them and count them
    c.sync.resume();
    tick(2 * HELLO_INTERVAL_MS);
    expect(c.sync.getStats().unsent).toBe(0);
    expect(visibleItems(a.crdt)).toHaveLength(0);
    expect(a.sync.getStats().fenced['c.0']).toBe(2);
    expect(b.sync.getStats().fenced['c.0']).toBe(2);

    // and c itself learns it was evicted, so its own kernel now refuses to write
    expect(c.crdt.getMembershipView().evictedMembers.has('c.0')).toBe(true);
    expect(() => c.crdt.insert(undefined, { text: 'one more' })).toThrow(RangeError);
  });

  it('a live tab can be exorcised: the survivors agree, the eviction completes, and the tab stops writing', () => {
    const { adapter, tabs, tick } = setup();
    const [a, b, c] = [tabs['a.0'], tabs['b.0'], tabs['c.0']];
    addItems(c, 4);
    tick();
    expect(adapter.exorcise('c.0')).toEqual({ ok: true });
    // c was told the view at once, so its own kernel now refuses to write past the cutoff
    expect(() => c.crdt.insert(undefined, { text: 'one more' })).toThrow(RangeError);
    tick(3 * HELLO_INTERVAL_MS);
    const texts = (t: Tab): string[] => visibleItems(t.crdt).map((e) => e.value.text);
    expect(texts(a)).toEqual(texts(b));
    expect(a.crdt.getVV().get('c.0')).toBe(b.crdt.getVV().get('c.0'));
    expect(adapter.getStatus().evicted[0]).toMatchObject({ id: 'c.0', complete: true });
  });

  it('a stalled SURVIVOR blocks the exorcism; abort releases the tabs and the operator exorcises the stalled one instead', () => {
    const { adapter, tabs, tick } = setup();
    const [a, b] = [tabs['a.0'], tabs['b.0']];
    b.sync.pause();
    adapter.exorcise('c.0');
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.getStatus().eviction).toEqual({ target: 'c.0', waitingFor: ['b.0'] });
    expect(a.crdt.isAuthorHeld('c.0')).toBe(true);

    adapter.abort();
    expect(a.crdt.isAuthorHeld('c.0')).toBe(false);
    expect(adapter.exorcise('b.0')).toEqual({ ok: true });
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.getStatus().evicted.map((e) => e.id)).toEqual(['b.0']);
    expect(a.crdt.getMembershipView().evictedMembers.has('b.0')).toBe(true);
  });
});
