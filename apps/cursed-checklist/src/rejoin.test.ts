/**
 * Rejoin (DA-9): who answers a request and who may ask (rejoin.ts, through sync.ts), the restart
 * from a stored snapshot (rejoinSession.ts), and ONE smoke test of the whole story with the real
 * tab code and the real coordinator (no browser). The parser tests for the two new messages are in
 * protocol.test.ts and the ID helper's test is in replica.test.ts. The kernel side (snapshots, the
 * refusal of an evicted ID) is covered by the kernel's own tests and properties.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CRDT, createMembership, deserializeSnapshot, removeReplica, serializeSnapshot } from '@bones/kernel';
import type { MembershipView, OpIdKey } from '@bones/kernel';
import { startCoordinator } from './coordinatorAdapter';
import { decode, encodeSnapshot, encodeSnapshotRequest, encodeView } from './protocol';
import type { Incoming } from './protocol';
import { createReplica, visibleItems } from './replica';
import type { Item } from './replica';
import { MAX_ANSWER_DELAY_MS, REJOIN_TIMEOUT_MS } from './rejoin';
import { createSessionReplica, REJOIN_STORAGE_KEY, stashRejoin, unacceptedEdits } from './rejoinSession';
import type { SessionStore } from './rejoinSession';
import { HELLO_INTERVAL_MS, startSync } from './sync';
import type { Sync } from './sync';
import { createBus, createManualTransport, seededRandom } from './test-support';
import type { RecordingTransport } from './test-support';

const stoppers: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); // once per test: installing them again would drop timers that are already scheduled
});
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  vi.useRealTimers();
});

/** c.0 is evicted at cutoff 2; a.0 and b.0 are the members (epoch 1). */
const evictedView = (): MembershipView => removeReplica(createMembership(['a.0', 'b.0', 'c.0']), 'c.0', 2);

/** A snapshot string from replica `id` that holds the given texts, under `view`. */
function snapshotOf(id: string, view: MembershipView, texts: string[]): string {
  const crdt = new CRDT<Item>(id, view);
  let anchor: OpIdKey | undefined;
  for (const text of texts) anchor = crdt.insert(anchor, { text }).id;
  return serializeSnapshot(crdt.snapshot());
}

const start = (crdt: CRDT<Item>, transport: RecordingTransport, random = 0.5): Sync => {
  const sync = startSync(crdt, transport, undefined, { random: () => random });
  stoppers.push(() => sync.stop());
  return sync;
};
const sentOfType = (t: RecordingTransport, type: Incoming['t']): Incoming[] =>
  t.sent.map((s) => decode(s)).filter((m): m is Incoming => m !== null && m.t === type);
/** The snapshot messages this transport sent to `requester`. */
const snapshotsTo = (t: RecordingTransport, requester: string): Array<{ t: 'snapshot'; to: string; snap: string }> =>
  sentOfType(t, 'snapshot').filter((m): m is { t: 'snapshot'; to: string; snap: string } => m.t === 'snapshot' && m.to === requester);
const texts = (crdt: CRDT<Item>): string[] => visibleItems(crdt).map((e) => e.value.text);

function fakeStore() {
  const map = new Map<string, string>();
  const store: SessionStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { store, map };
}

describe('who answers a rejoin request', () => {
  /** A tab with one item that was told `view` by the coordinator (the same path the real app uses). */
  function survivor(id: string, view: MembershipView, random = 0.5) {
    const transport = createManualTransport();
    const crdt = createReplica(id);
    crdt.insert(undefined, { text: 'x' }); // before the view: an exorcised tab could not write any more
    const sync = start(crdt, transport, random);
    transport.receive(encodeView(view));
    expect(crdt.getMembershipView().epoch).toBe(view.epoch);
    return { transport, crdt, sync };
  }

  it('a running member answers an evicted requester ONCE, after the random wait, with a snapshot that shows the requester as evicted', () => {
    const { transport } = survivor('a.0', evictedView(), 0.5); // 0.5 of 0 to 300 ms = 150 ms
    transport.receive(encodeSnapshotRequest('c.0'));
    transport.receive(encodeSnapshotRequest('c.0')); // asked twice: still one answer
    vi.advanceTimersByTime(149);
    expect(snapshotsTo(transport, 'c.0')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const answers = snapshotsTo(transport, 'c.0');
    expect(answers).toHaveLength(1);
    expect(deserializeSnapshot(answers[0]!.snap).membership.evictedMembers.has('c.0')).toBe(true);
    vi.advanceTimersByTime(2 * MAX_ANSWER_DELAY_MS);
    expect(snapshotsTo(transport, 'c.0')).toHaveLength(1);
  });

  it('is silent when paused (before or during the wait), when it is not an active member, or when the requester is not evicted in its view', () => {
    const both = removeReplica(removeReplica(createMembership(['a.0', 'b.0', 'c.0', 'd.0']), 'c.0', 2), 'd.0', 2); // c.0 and d.0 evicted

    const control = survivor('a.0', evictedView()); // answers: proves the silence of the others is not just a broken setup
    control.transport.receive(encodeSnapshotRequest('c.0'));

    const paused = survivor('a.0', evictedView());
    paused.sync.pause();
    paused.transport.receive(encodeSnapshotRequest('c.0'));
    const pausedLater = survivor('a.0', evictedView());
    pausedLater.transport.receive(encodeSnapshotRequest('c.0'));
    pausedLater.sync.pause();
    const exorcisedItself = survivor('c.0', both); // this tab is evicted itself: it must not answer d.0
    exorcisedItself.transport.receive(encodeSnapshotRequest('d.0'));
    const notAMember = survivor('x.0', evictedView()); // in nobody's member list
    notAMember.transport.receive(encodeSnapshotRequest('c.0'));
    const requesterNotEvicted = survivor('a.0', evictedView());
    requesterNotEvicted.transport.receive(encodeSnapshotRequest('b.0')); // b.0 is a member, not evicted
    requesterNotEvicted.transport.receive(encodeSnapshotRequest('z.0')); // unknown

    vi.advanceTimersByTime(MAX_ANSWER_DELAY_MS + 1);
    expect(snapshotsTo(control.transport, 'c.0')).toHaveLength(1);
    for (const tab of [paused, pausedLater, exorcisedItself, notAMember, requesterNotEvicted]) {
      expect(sentOfType(tab.transport, 'snapshot')).toEqual([]);
    }
  });

  it('drops its own answer when another tab answers the same requester first', () => {
    const { transport } = survivor('a.0', evictedView());
    transport.receive(encodeSnapshotRequest('c.0'));
    vi.advanceTimersByTime(100);
    transport.receive(encodeSnapshot('c.0', '{"from":"another tab"}'));
    vi.advanceTimersByTime(2 * MAX_ANSWER_DELAY_MS);
    expect(snapshotsTo(transport, 'c.0')).toHaveLength(0);
  });
});

describe('asking to rejoin', () => {
  function exorcisedTab() {
    const transport = createManualTransport();
    const crdt = createReplica('c.0');
    const sync = start(crdt, transport);
    transport.receive(encodeView(evictedView())); // the coordinator told this tab it was exorcised
    expect(crdt.getMembershipView().evictedMembers.has('c.0')).toBe(true);
    return { transport, crdt, sync };
  }

  it('keeps the FIRST reply that is a valid snapshot showing this tab as evicted, and ignores unusable ones and later ones', () => {
    const { transport, sync } = exorcisedTab();
    expect(sync.getRejoin()).toEqual({ state: 'idle' });
    expect(sync.requestRejoin()).toBe(true);
    expect(sentOfType(transport, 'snapshot-request')).toEqual([{ t: 'snapshot-request', from: 'c.0' }]);
    expect(sync.getRejoin()).toEqual({ state: 'waiting' });

    const good = snapshotOf('a.0', evictedView(), ['one']);
    const later = snapshotOf('b.0', evictedView(), ['one', 'two']);
    const beforeEviction = snapshotOf('a.0', createMembership(['a.0', 'b.0', 'c.0']), ['one']);
    transport.receive(encodeSnapshot('c.0', 'not a snapshot'));
    transport.receive(encodeSnapshot('c.0', beforeEviction)); // valid, but it does not show c.0 as evicted
    transport.receive(encodeSnapshot('d.0', good)); // for another tab
    expect(sync.getRejoin()).toEqual({ state: 'waiting' });
    transport.receive(encodeSnapshot('c.0', good));
    expect(sync.getRejoin()).toEqual({ state: 'ready', snapshot: good });
    transport.receive(encodeSnapshot('c.0', later));
    expect(sync.getRejoin()).toEqual({ state: 'ready', snapshot: good });
  });

  it('says nobody answered after the timeout and can ask again; a stalled tab, or one that was not exorcised, cannot ask', () => {
    const { transport, sync } = exorcisedTab();
    sync.requestRejoin();
    vi.advanceTimersByTime(REJOIN_TIMEOUT_MS - 1);
    expect(sync.getRejoin()).toEqual({ state: 'waiting' });
    vi.advanceTimersByTime(1);
    expect(sync.getRejoin()).toEqual({ state: 'timed-out' });
    expect(sync.requestRejoin()).toBe(true);
    expect(sync.getRejoin()).toEqual({ state: 'waiting' });
    expect(sentOfType(transport, 'snapshot-request')).toHaveLength(2);
    sync.pause();
    expect(sync.requestRejoin()).toBe(false);

    const member = start(createReplica('q.0'), createManualTransport());
    expect(member.requestRejoin()).toBe(false);
    expect(member.getRejoin()).toEqual({ state: 'idle' });
  });
});

describe('restarting from a stored snapshot (the page reload)', () => {
  it('restores as the next incarnation, removes the key first, and a second load is a fresh replica', () => {
    const { store, map } = fakeStore();
    const snap = snapshotOf('a.0', evictedView(), ['one', 'two']);
    expect(stashRejoin(store, snap, 'c.0')).toBe(true);
    expect(map.has(REJOIN_STORAGE_KEY)).toBe(true);

    const restored = createSessionReplica(store);
    expect(restored.replicaId).toBe('c.1');
    expect(texts(restored)).toEqual(['one', 'two']);
    expect(restored.getMembershipView().evictedMembers.has('c.0')).toBe(true);
    expect(map.has(REJOIN_STORAGE_KEY)).toBe(false);

    expect(createSessionReplica(store).replicaId).toMatch(/^tab-[0-9a-f]{8}\.0$/); // the same snapshot is never restored twice
  });

  it('anything unusable gives a fresh random replica, and never a half-restored one', () => {
    const good = snapshotOf('a.0', evictedView(), ['one']);
    const stash = (snapshot: unknown, previousId: unknown): string => JSON.stringify({ snapshot, previousId });
    // a snapshot whose author is the next incarnation of the evicted ID: taking it would make two live replicas share an ID
    const sameAuthor = snapshotOf('a.1', removeReplica(createMembership(['a.1', 'b.0', 'a.0']), 'a.0', 0), ['one']);
    // the next incarnation (c.1) is itself evicted: the kernel refuses it
    const bothEvicted = snapshotOf('a.0', removeReplica(removeReplica(createMembership(['a.0', 'c.0', 'c.1']), 'c.0', 0), 'c.1', 0), ['one']);
    const bad: Array<[string, string]> = [
      ['not JSON', 'not json'],
      ['JSON but not an object', '5'],
      ['snapshot is not a string', stash(5, 'c.0')],
      ['previous ID is not a string', stash(good, 7)],
      ['previous ID is invalid', stash(good, 'bad:id')],
      ['snapshot is garbage', stash('{"nope":true}', 'c.0')],
      ['previous ID is not evicted in the snapshot', stash(good, 'b.0')],
      ['the next ID equals the snapshot author', stash(sameAuthor, 'a.0')],
      ['the next ID is evicted too', stash(bothEvicted, 'c.0')],
    ];
    for (const [why, stored] of bad) {
      const { store, map } = fakeStore();
      map.set(REJOIN_STORAGE_KEY, stored);
      expect(createSessionReplica(store).replicaId, why).toMatch(/^tab-[0-9a-f]{8}\.0$/);
      expect(map.has(REJOIN_STORAGE_KEY), `${why}: the key is removed`).toBe(false);
    }

    expect(createSessionReplica(undefined).replicaId).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    expect(createSessionReplica(fakeStore().store).replicaId).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    const broken: SessionStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(createSessionReplica(broken).replicaId).toMatch(/^tab-[0-9a-f]{8}\.0$/);
    expect(stashRejoin(broken, good, 'c.0')).toBe(false);
    expect(stashRejoin(undefined, good, 'c.0')).toBe(false);

    // an item that does not remove its key cannot be restored twice: if removal fails, nothing is restored
    const stuck = fakeStore();
    stuck.map.set(REJOIN_STORAGE_KEY, stash(good, 'c.0'));
    const noRemove: SessionStore = { ...stuck.store, removeItem: () => { throw new Error('blocked'); } };
    expect(createSessionReplica(noRemove).replicaId).toMatch(/^tab-[0-9a-f]{8}\.0$/);
  });
});

describe('SMOKE: the whole rejoin story with the real tab code and the real coordinator (no browser)', () => {
  it('stall, exorcise, the exorcised tab asks, gets a snapshot, restarts as c.1 with the same list, and its edits are accepted again', () => {
    vi.setSystemTime(new Date('2026-11-28T10:00:00Z'));
    const bus = createBus();
    const adapter = startCoordinator(bus.connect(), () => Date.now());
    stoppers.push(() => adapter.stop());
    const tab = (id: string, seed: number) => {
      const crdt = createReplica(id);
      const transport = bus.connect();
      const sync = startSync(crdt, transport, undefined, { random: seededRandom(seed) });
      stoppers.push(() => sync.stop());
      return { crdt, transport, sync };
    };
    const [a, b, c] = [tab('a.0', 11), tab('b.0', 22), tab('c.0', 33)];
    const tick = (ms: number = HELLO_INTERVAL_MS): void => {
      vi.advanceTimersByTime(ms);
    };
    tick();
    tick();
    expect(adapter.getStatus().epoch).toBe(3);

    // three items; c is stalled; a buries two of them; the operator exorcises c
    const ids: OpIdKey[] = [];
    let anchor: OpIdKey | undefined;
    for (const text of ['one', 'two', 'three']) {
      const op = a.crdt.insert(anchor, { text });
      a.sync.sendOp(op);
      ids.push(op.id);
      anchor = op.id;
    }
    tick();
    c.sync.sendOp(c.crdt.insert(anchor, { text: 'from c' })); // c writes one item BEFORE it is stalled: its cutoff will be 1
    tick();
    c.sync.pause();
    a.sync.sendOp(a.crdt.delete(ids[0] as OpIdKey));
    a.sync.sendOp(a.crdt.delete(ids[1] as OpIdKey));
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.exorcise('c.0')).toEqual({ ok: true });
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.getStatus().epoch).toBe(4);

    // c does not know yet and writes two edits; on resume it learns, and the survivors refuse them
    c.sync.sendOp(c.crdt.insert(undefined, { text: 'offline 1' }));
    c.sync.sendOp(c.crdt.insert(undefined, { text: 'offline 2' }));
    c.sync.resume();
    tick(2 * HELLO_INTERVAL_MS);
    expect(c.crdt.getMembershipView().evictedMembers.has('c.0')).toBe(true);
    expect(c.crdt.getMembershipView().evictedMembers.get('c.0')).toBe(1); // the survivors keep c's first operation
    expect(unacceptedEdits(c.crdt)).toBe(2); // 3 operations made, 1 kept, 2 refused
    expect(unacceptedEdits(a.crdt)).toBe(0); // a tab that was not exorcised has nothing to discard
    expect(texts(a.crdt)).toEqual(['three', 'from c']);
    expect(texts(b.crdt)).toEqual(['three', 'from c']);

    // c asks; ONE surviving tab answers (the first answer wins) and c holds a validated snapshot
    expect(c.sync.requestRejoin()).toBe(true);
    vi.advanceTimersByTime(MAX_ANSWER_DELAY_MS + 1);
    expect([a, b].flatMap((tabX) => snapshotsTo(tabX.transport, 'c.0'))).toHaveLength(1);
    const status = c.sync.getRejoin();
    if (status.state !== 'ready') throw new Error(`expected a ready snapshot, got ${status.state}`);

    // the old page stores the snapshot and reloads; the new page restores it as c.1
    const { store } = fakeStore();
    expect(stashRejoin(store, status.snapshot, 'c.0')).toBe(true);
    c.sync.stop();
    const restored = createSessionReplica(store);
    expect(restored.replicaId).toBe('c.1');
    expect(texts(restored)).toEqual(['three', 'from c']); // the same list as the survivors; the offline edits are gone
    const c1 = startSync(restored, bus.connect(), undefined, { random: seededRandom(44) });
    stoppers.push(() => c1.stop());
    tick(2 * HELLO_INTERVAL_MS);
    expect(adapter.getStatus().members.map((m) => m.id).sort()).toEqual(['a.0', 'b.0', 'c.1']);
    expect(restored.getMembershipView().activeMembers.has('c.1')).toBe(true);

    // its edits are accepted again, and it hears the others
    c1.sendOp(restored.insert(undefined, { text: 'back from the dead' }));
    a.sync.sendOp(a.crdt.insert(undefined, { text: 'from a' }));
    tick(2 * HELLO_INTERVAL_MS);
    const everyone = [texts(a.crdt), texts(b.crdt), texts(restored)];
    expect(everyone[1]).toEqual(everyone[0]);
    expect(everyone[2]).toEqual(everyone[0]);
    expect(everyone[0]).toEqual(expect.arrayContaining(['three', 'from c', 'back from the dead', 'from a']));
    expect(a.sync.getStats().fenced['c.1']).toBeUndefined();
    expect(a.sync.getStats().fenced['c.0']).toBe(2); // the history stays: what c.0 wrote offline was refused

    // a SECOND cycle: the restored tab (c.1, which started with an empty log) is exorcised in turn and rejoins as c.2
    expect(adapter.exorcise('c.1')).toEqual({ ok: true });
    tick(2 * HELLO_INTERVAL_MS);
    expect(restored.getMembershipView().evictedMembers.has('c.1')).toBe(true);
    expect(c1.requestRejoin()).toBe(true);
    vi.advanceTimersByTime(MAX_ANSWER_DELAY_MS + 1);
    const second = c1.getRejoin();
    if (second.state !== 'ready') throw new Error(`expected a ready snapshot, got ${second.state}`);
    const again = fakeStore();
    expect(stashRejoin(again.store, second.snapshot, 'c.1')).toBe(true);
    c1.stop();
    const restoredAgain = createSessionReplica(again.store);
    expect(restoredAgain.replicaId).toBe('c.2');
    expect(texts(restoredAgain)).toEqual(texts(a.crdt));
    const c2 = startSync(restoredAgain, bus.connect(), undefined, { random: seededRandom(55) });
    stoppers.push(() => c2.stop());
    tick(2 * HELLO_INTERVAL_MS);
    c2.sendOp(restoredAgain.insert(undefined, { text: 'second life' }));
    tick(2 * HELLO_INTERVAL_MS);
    expect(texts(a.crdt)).toContain('second life');
    expect(texts(b.crdt)).toEqual(texts(a.crdt));
    expect(texts(restoredAgain)).toEqual(texts(a.crdt));
    expect(a.sync.getStats().fenced['c.2']).toBeUndefined();
  });
});
