import { describe, it, expect, vi, afterEach } from 'vitest';
import { CRDT, serializeOp, serializeVersionVector } from '@bones/kernel';
import type { Operation } from '@bones/kernel';
import { createReplica, visibleItems } from './replica';
import type { Item } from './replica';
import { HELLO_INTERVAL_MS, startSync } from './sync';
import type { Sync } from './sync';
import type { Transport } from './transport';
import { createBroadcastTransport } from './transport';
import { createBus, createLossyNet, createManualTransport, seededRandom } from './test-support';

// ---- helpers ----

const running: Sync[] = [];

/** startSync, remembering the handle so afterEach can stop it (no interval outlives a test). */
function start(crdt: CRDT<Item>, transport: Transport, intervalMs?: number): Sync {
  const sync = startSync(crdt, transport, intervalMs);
  running.push(sync);
  return sync;
}

afterEach(() => {
  for (const sync of running.splice(0)) sync.stop();
  vi.useRealTimers();
});

const texts = (crdt: CRDT<Item>): string[] => visibleItems(crdt).map((e) => e.value.text);
const opMessage = (op: Operation<unknown>): string => JSON.stringify({ t: 'op', op: serializeOp(op) });
const helloMessage = (vv: Record<string, number>): string => JSON.stringify({ t: 'hello', vv });

interface Wire {
  t: string;
  op?: string;
  vv?: Record<string, number>;
  from?: string;
  epoch?: number;
}
const wire = (sent: string[]): Wire[] => sent.map((s) => JSON.parse(s) as Wire);
const opIdsSent = (sent: string[]): string[] =>
  wire(sent)
    .filter((w) => w.t === 'op')
    .map((w) => (JSON.parse(w.op as string) as Operation<unknown>).id);

/** A replica holding `count` items, each inserted after the previous one. */
function replicaWithItems(id: string, count: number): CRDT<Item> {
  const crdt = createReplica(id);
  let anchor: Operation<Item> | undefined;
  for (let i = 1; i <= count; i++) anchor = crdt.insert(anchor?.id, { text: `item ${i}` });
  return crdt;
}

// ---- tests ----

describe('startSync: hello', () => {
  it('sends a hello with its version vector as soon as it starts', () => {
    const t = createBus().connect();
    start(replicaWithItems('a.0', 2), t);
    expect(wire(t.sent)).toEqual([{ t: 'hello', from: 'a.0', epoch: 0, vv: { 'a.0': 2 } }]);
  });

  it('a replica with no operations sends an empty version vector', () => {
    const t = createBus().connect();
    start(createReplica('a.0'), t);
    expect(wire(t.sent)).toEqual([{ t: 'hello', from: 'a.0', epoch: 0, vv: {} }]);
  });

  it('sends a hello every HELLO_INTERVAL_MS (3 seconds) by default, carrying the CURRENT version vector', () => {
    vi.useFakeTimers();
    expect(HELLO_INTERVAL_MS).toBe(3000);
    const t = createBus().connect();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    vi.advanceTimersByTime(HELLO_INTERVAL_MS - 1);
    expect(t.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sent).toHaveLength(2);
    sync.sendOp(crdt.insert(undefined, { text: 'x' }));
    vi.advanceTimersByTime(HELLO_INTERVAL_MS);
    const hellos = wire(t.sent).filter((w) => w.t === 'hello');
    expect(hellos.map((h) => h.vv)).toEqual([{}, {}, { 'a.0': 1 }]);
  });

  it.each([[0], [-5], [NaN], [Infinity]])('rejects the interval %s, before starting anything', (interval) => {
    const t = createManualTransport();
    expect(() => startSync(createReplica('a.0'), t, interval)).toThrow(RangeError);
    expect(t.sent).toEqual([]);
  });

  it('honours a custom interval', () => {
    vi.useFakeTimers();
    const t = createBus().connect();
    start(createReplica('a.0'), t, 500);
    vi.advanceTimersByTime(1500);
    expect(t.sent).toHaveLength(4); // on start, then at 500, 1000, 1500
  });
});

describe('startSync: operations', () => {
  it('sendOp broadcasts one op message holding the serialized operation', () => {
    const t = createBus().connect();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    const op = crdt.insert(undefined, { text: 'milk' });
    sync.sendOp(op);
    const messages = wire(t.sent).filter((w) => w.t === 'op');
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].op as string)).toEqual(JSON.parse(serializeOp(op)));
  });

  it('two replicas stay equal through insert, insert-after and delete', () => {
    const bus = createBus();
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const syncA = start(a, bus.connect());
    const syncB = start(b, bus.connect());

    const milk = a.insert(undefined, { text: 'milk' });
    syncA.sendOp(milk);
    expect(texts(b)).toEqual(['milk']);

    const eggs = b.insert(milk.id, { text: 'eggs' });
    syncB.sendOp(eggs);
    expect(texts(a)).toEqual(['milk', 'eggs']);

    syncA.sendOp(a.delete(milk.id));
    expect(texts(a)).toEqual(['eggs']);
    expect(texts(b)).toEqual(['eggs']);
  });
});

describe('startSync: answering a hello (catch-up)', () => {
  it('a replica that starts late catches up from the hello it sends on start', () => {
    const bus = createBus();
    const a = replicaWithItems('a.0', 3);
    start(a, bus.connect());
    const b = createReplica('b.0');
    start(b, bus.connect());
    expect(texts(b)).toEqual(['item 1', 'item 2', 'item 3']);
  });

  it('replies with only the operations the sender lacks, one op message each, in log order', () => {
    const bus = createBus();
    const a = replicaWithItems('a.0', 3);
    const ta = bus.connect();
    start(a, ta);
    const probe = bus.connect();
    ta.sent.length = 0;
    probe.send(helloMessage({ 'a.0': 1 }));
    expect(opIdsSent(ta.sent)).toEqual(['a.0:2', 'a.0:3']);
    expect(wire(ta.sent).every((w) => w.t === 'op')).toBe(true);
  });

  it('replies with nothing when the sender is already up to date', () => {
    const bus = createBus();
    const ta = bus.connect();
    start(replicaWithItems('a.0', 3), ta);
    const probe = bus.connect();
    ta.sent.length = 0;
    probe.send(helloMessage({ 'a.0': 3 }));
    expect(ta.sent).toEqual([]);
  });

  it('relays operations written by OTHER replicas too, not only its own', () => {
    const bus = createBus();
    const a = replicaWithItems('a.0', 1);
    const c = replicaWithItems('c.0', 2);
    for (const op of c.getOps()) a.applyOp(op as Operation<Item>); // a learned c's ops earlier
    const ta = bus.connect();
    start(a, ta);
    const probe = bus.connect();
    ta.sent.length = 0;
    probe.send(helloMessage({}));
    expect(opIdsSent(ta.sent).sort()).toEqual(['a.0:1', 'c.0:1', 'c.0:2']);
  });

  it('an empty hello gets every operation back', () => {
    const bus = createBus();
    const a = replicaWithItems('a.0', 4);
    const ta = bus.connect();
    start(a, ta);
    const probe = bus.connect();
    ta.sent.length = 0;
    probe.send(helloMessage({}));
    expect(opIdsSent(ta.sent)).toEqual(['a.0:1', 'a.0:2', 'a.0:3', 'a.0:4']);
  });
});

describe('startSync: stop', () => {
  it('stops the hello timer, ignores incoming messages and sends nothing more', () => {
    vi.useFakeTimers();
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    const sync = start(crdt, t);
    const local = crdt.insert(undefined, { text: 'mine' });
    sync.stop();
    const sentBefore = t.sent.length;

    vi.advanceTimersByTime(10 * HELLO_INTERVAL_MS);
    sync.sendOp(local);
    const other = createReplica('b.0').insert(undefined, { text: 'theirs' });
    t.receive(opMessage(other));
    t.receive(helloMessage({}));

    expect(t.sent.length).toBe(sentBefore);
    expect(texts(crdt)).toEqual(['mine']);
  });

  it('unsubscribes exactly once, and ignores messages even from a transport that keeps delivering', () => {
    let deliver: ((message: unknown) => void) | undefined;
    let unsubscribed = 0;
    const leaky: Transport = {
      send: () => undefined,
      onMessage(handler) {
        deliver = handler;
        return () => {
          unsubscribed++; // but it does NOT actually stop delivering
        };
      },
      close: () => undefined,
    };
    const crdt = createReplica('a.0');
    const sync = start(crdt, leaky);
    sync.stop();
    sync.stop();
    expect(unsubscribed).toBe(1);
    deliver?.(opMessage(createReplica('b.0').insert(undefined, { text: 'late' })));
    expect(texts(crdt)).toEqual([]);
  });

  it('can be called twice, and does not close the transport (the caller owns it)', () => {
    const t = createBus().connect();
    const sync = start(createReplica('a.0'), t);
    sync.stop();
    expect(() => sync.stop()).not.toThrow();
    expect(() => t.send('still open')).not.toThrow();
  });
});

describe('startSync: a failing transport must not crash the app', () => {
  const broken: Transport = {
    send() {
      throw new Error('InvalidStateError: channel is closed');
    },
    onMessage: () => () => undefined,
    close: () => undefined,
  };

  it('starting, sendOp and the hello timer all swallow send errors; the local edit is kept', () => {
    vi.useFakeTimers();
    const crdt = createReplica('a.0');
    let sync: Sync | undefined;
    expect(() => {
      sync = start(crdt, broken);
    }).not.toThrow();
    const op = crdt.insert(undefined, { text: 'kept' });
    expect(() => sync?.sendOp(op)).not.toThrow();
    expect(() => vi.advanceTimersByTime(3 * HELLO_INTERVAL_MS)).not.toThrow();
    expect(texts(crdt)).toEqual(['kept']);
  });

  it('a send error while answering a hello does not break later messages', () => {
    const t = createManualTransport();
    const a = replicaWithItems('a.0', 2);
    let failNext = false;
    const flaky: Transport = {
      ...t,
      send(message) {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        t.send(message);
      },
      onMessage: (handler) => t.onMessage(handler),
    };
    start(a, flaky);
    failNext = true;
    expect(() => t.receive(helloMessage({}))).not.toThrow();
    const b = createReplica('b.0');
    t.receive(opMessage(b.insert(undefined, { text: 'after the error' })));
    expect(texts(a)).toContain('after the error');
  });
});

describe('startSync: loss, duplication and reordering', () => {
  it('an operation lost on the wire reaches the other replica with the next hello round', () => {
    vi.useFakeTimers();
    const net = createLossyNet(1, { drop: 1, duplicate: 0 }); // everything is lost
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const syncA = start(a, net.connect());
    start(b, net.connect());
    syncA.sendOp(a.insert(undefined, { text: 'lost once' }));
    net.drain();
    expect(texts(b)).toEqual([]);

    net.makeReliable();
    vi.advanceTimersByTime(HELLO_INTERVAL_MS); // both replicas say hello again
    net.drain();
    expect(texts(b)).toEqual(['lost once']);
  });

  it('delivering every message twice, in random order, gives the same result as in-order delivery', () => {
    const net = createLossyNet(7, { drop: 0, duplicate: 1 });
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const syncA = start(a, net.connect());
    start(b, net.connect());
    let anchor: Operation<Item> | undefined;
    for (let i = 1; i <= 8; i++) {
      anchor = a.insert(anchor?.id, { text: `n${i}` });
      syncA.sendOp(anchor);
    }
    net.drain();
    expect(texts(b)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
    expect(b.getPendingCount()).toBe(0);
  });

  const SEEDS = Array.from({ length: 25 }, (_, i) => [i + 1]);
  it.each(SEEDS)(
    'three replicas editing over a network that loses 30%% and duplicates 20%% of messages converge once it recovers (seed %i)',
    (seed) => {
      vi.useFakeTimers();
      const net = createLossyNet(seed, { drop: 0.3, duplicate: 0.2 });
      const pick = seededRandom(seed + 1000);
      const replicas = ['a.0', 'b.0', 'c.0'].map((id) => createReplica(id));
      const syncs = replicas.map((r) => start(r, net.connect()));

      for (let step = 0; step < 40; step++) {
        const who = Math.floor(pick() * replicas.length);
        const replica = replicas[who];
        const items = visibleItems(replica);
        if (items.length > 0 && pick() < 0.35) {
          syncs[who].sendOp(replica.delete(items[Math.floor(pick() * items.length)].id));
        } else {
          const slot = Math.floor(pick() * (items.length + 1)); // 0 = at the head
          const anchor = slot === 0 ? undefined : items[slot - 1].id;
          syncs[who].sendOp(replica.insert(anchor, { text: `${replica.replicaId}#${step}` }));
        }
        net.deliver(Math.floor(pick() * 4));
        if (step % 10 === 9) vi.advanceTimersByTime(HELLO_INTERVAL_MS);
      }

      net.makeReliable();
      const converged = (): boolean => {
        const reference = JSON.stringify([
          texts(replicas[0]),
          replicas[0].getAllElements().map((e) => `${e.id}${e.deleted ? 'x' : ''}`),
          serializeVersionVector(replicas[0].getVV()),
        ]);
        return replicas.every(
          (r) =>
            r.getPendingCount() === 0 &&
            JSON.stringify([
              texts(r),
              r.getAllElements().map((e) => `${e.id}${e.deleted ? 'x' : ''}`),
              serializeVersionVector(r.getVV()),
            ]) === reference
        );
      };
      for (let round = 0; round < 6 && !converged(); round++) {
        net.drain();
        vi.advanceTimersByTime(HELLO_INTERVAL_MS);
        net.drain();
      }
      expect(converged()).toBe(true);
    }
  );
});

describe('startSync: over a real BroadcastChannel', () => {
  it('two replicas on the same channel stay in sync, including a late joiner', async () => {
    const name = `sync-test-${Math.random()}`;
    const a = createReplica('a.0');
    const b = createReplica('b.0');
    const ta = createBroadcastTransport(name);
    const tb = createBroadcastTransport(name);
    const tc = createBroadcastTransport(name);
    try {
      const syncA = start(a, ta);
      start(b, tb);
      const first = a.insert(undefined, { text: 'first' });
      syncA.sendOp(first);
      await vi.waitFor(() => expect(texts(b)).toEqual(['first']));

      const late = createReplica('c.0');
      start(late, tc); // its hello makes a and b send what it missed
      await vi.waitFor(() => expect(texts(late)).toEqual(['first']));
    } finally {
      ta.close();
      tb.close();
      tc.close();
    }
  });
});

describe('startSync: untrusted input (anything another tab, or any script on the origin, can post)', () => {
  const validOp: Operation<Item> = createReplica('x.0').insert(undefined, { text: 'ok' });
  const forged = (change: Record<string, unknown>): string => opMessage({ ...validOp, ...change } as Operation<unknown>);

  const BAD: unknown[] = [
    // not strings at all (including objects that would turn into a valid message if converted with String())
    undefined, null, 42, true, {}, [], ['hello'], { t: 'op' }, { t: 'hello', vv: {} }, new Uint8Array(3),
    ['{"t":"hello","vv":{}}'],
    { toString: () => '{"t":"hello","vv":{}}' },
    // strings that are not JSON, or not an object
    'nope', '', 'null', '[]', '"x"', '123', '{}', '{not json',
    // unknown or incomplete messages
    '{"t":"x"}', '{"t":"op"}',
    // an unknown or differently-cased tag is ignored even when the rest is a perfectly valid payload
    '{"t":"bye","vv":{}}', '{"t":"Hello","vv":{}}', '{"t":"HELLO","vv":{}}', '{"vv":{}}',
    JSON.stringify({ t: 'oops', op: serializeOp(validOp) }), JSON.stringify({ t: 'OP', op: serializeOp(validOp) }),
    JSON.stringify({ op: serializeOp(validOp) }), '{"t":"op","op":5}', '{"t":"op","op":null}', '{"t":"op","op":{}}',
    '{"t":"op","op":"not json"}', '{"t":"op","op":"{}"}', '{"t":"op","op":"null"}', '{"t":"op","op":"[]"}',
    JSON.stringify({ t: 'op', op: [serializeOp(validOp)] }), // op must be a string, not a one-element array
    // operations that fail the kernel's validation
    forged({ id: 'nocolon' }),
    forged({ id: 'x.0:0', replicaId: 'x.0' }),
    forged({ replicaId: 'someone-else.0' }),
    forged({ lamport: -1 }),
    forged({ lamport: 1.5 }),
    forged({ lamport: 2 ** 48 + 1 }),
    forged({ type: 'frob' }),
    forged({ target: 'x.0:1' }),
    forged({ type: 'delete', anchor: 'x.0:1', target: 'x.0:1' }),
    forged({ type: 'delete' }),
    // hello messages whose version vector is not a plain { replicaId: positive integer } object
    '{"t":"hello"}', '{"t":"hello","vv":null}', '{"t":"hello","vv":"abc"}', '{"t":"hello","vv":5}',
    '{"t":"hello","vv":[]}', '{"t":"hello","vv":[3]}', '{"t":"hello","vv":{"a":1.5}}',
    '{"t":"hello","vv":{"a":-1}}', '{"t":"hello","vv":{"a":"3"}}', '{"t":"hello","vv":{"a":null}}',
    '{"t":"hello","vv":{"a":1e999}}',
  ];

  it.each(BAD.map((message) => [message]))('ignores %j: no throw, no change, no reply', (message) => {
    const t = createManualTransport();
    const crdt = replicaWithItems('a.0', 2);
    start(crdt, t);
    const before = JSON.stringify([crdt.getAllElements(), serializeVersionVector(crdt.getVV()), crdt.getPendingCount()]);
    t.sent.length = 0;

    expect(() => t.receive(message)).not.toThrow();

    expect(JSON.stringify([crdt.getAllElements(), serializeVersionVector(crdt.getVV()), crdt.getPendingCount()])).toBe(before);
    expect(t.sent).toEqual([]);
  });

  it('the control case: the same shapes, well formed, ARE accepted (so the table above is not vacuous)', () => {
    const t = createManualTransport();
    const crdt = replicaWithItems('a.0', 2);
    start(crdt, t);
    t.sent.length = 0;
    t.receive(helloMessage({ 'a.0': 1 }));
    expect(opIdsSent(t.sent)).toEqual(['a.0:2']);
    t.receive(opMessage(validOp));
    expect(texts(crdt)).toContain('ok');
  });

  it('keeps working after bad messages', () => {
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    for (const message of BAD) t.receive(message);
    t.receive(opMessage(validOp));
    expect(texts(crdt)).toEqual(['ok']);
  });

  it('applies an operation whose VALUE is not a valid item, and the UI hides it', () => {
    // Dropping such an op would leave a gap in its author's sequence and stall everything after it.
    const t = createManualTransport();
    const crdt = createReplica('a.0');
    start(crdt, t);
    const stranger = new CRDT<unknown>('s.0');
    const bad = stranger.insert(undefined, 5);
    const worse = stranger.insert(bad.id, { text: '' });
    const good = stranger.insert(worse.id, { text: 'after the bad ones' });
    t.receive(opMessage(bad));
    t.receive(opMessage(worse));
    t.receive(opMessage(good));

    expect(crdt.getVV().get('s.0')).toBe(3); // all three applied, none stuck in the buffer
    expect(crdt.getPendingCount()).toBe(0);
    expect(texts(crdt)).toEqual(['after the bad ones']);
  });
});
