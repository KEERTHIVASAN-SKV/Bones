/**
 * In-memory networks for tests (never imported by the app). They stand in for BroadcastChannel so
 * sync.ts can be tested without a browser, with delivery under the test's control.
 */
import type { Transport } from './transport';

type Handler = (message: unknown) => void;

/** A transport that also records every string it was asked to send. */
export interface RecordingTransport extends Transport {
  readonly sent: string[];
}

/**
 * A bus that delivers each message SYNCHRONOUSLY to every other connected transport (never back
 * to the sender), like BroadcastChannel minus the asynchrony. Nothing is lost, duplicated or
 * reordered.
 */
export function createBus(): { connect(): RecordingTransport } {
  const handlersByPeer: Array<Set<Handler>> = [];
  return {
    connect() {
      const mine = new Set<Handler>();
      handlersByPeer.push(mine);
      const sent: string[] = [];
      let closed = false;
      return {
        sent,
        send(message) {
          if (closed) throw new Error('transport closed');
          sent.push(message);
          for (const peer of handlersByPeer) {
            if (peer === mine) continue;
            for (const handler of [...peer]) handler(message);
          }
        },
        onMessage(handler) {
          mine.add(handler);
          return () => {
            mine.delete(handler);
          };
        },
        close() {
          closed = true;
          mine.clear();
        },
      };
    },
  };
}

/** Small seeded PRNG (mulberry32): the same seed always gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a {@link createLossyNet} does to messages while it is unreliable. */
export interface Faults {
  /** Chance (0 to 1) that a copy of a message is lost on its way to one peer. */
  drop: number;
  /** Chance (0 to 1) that a copy is delivered twice. */
  duplicate: number;
}

/**
 * A network with a queue between senders and receivers. `send` only queues; the test decides when
 * and in what order messages arrive (a random order, from the seed). While faults are on, copies
 * are lost or duplicated. Delivery is otherwise exact, so a test can first break the network and
 * then make it reliable to check that the replicas still converge.
 */
export function createLossyNet(seed: number, faults: Faults) {
  const random = seededRandom(seed);
  const handlersByPeer: Array<Set<Handler>> = [];
  const queue: Array<{ to: number; message: string }> = [];
  let current: Faults = { ...faults };

  function deliverOne(): void {
    const index = Math.floor(random() * queue.length);
    const last = queue.length - 1;
    const entry = queue[index];
    queue[index] = queue[last];
    queue.pop();
    for (const handler of [...handlersByPeer[entry.to]]) handler(entry.message);
  }

  return {
    connect(): RecordingTransport {
      const me = handlersByPeer.length;
      handlersByPeer.push(new Set());
      const sent: string[] = [];
      return {
        sent,
        send(message) {
          sent.push(message);
          for (let to = 0; to < handlersByPeer.length; to++) {
            if (to === me) continue;
            if (random() < current.drop) continue;
            queue.push({ to, message });
            if (random() < current.duplicate) queue.push({ to, message });
          }
        },
        onMessage(handler) {
          handlersByPeer[me].add(handler);
          return () => {
            handlersByPeer[me].delete(handler);
          };
        },
        close() {
          handlersByPeer[me].clear();
        },
      };
    },
    /** Messages queued and not yet delivered. */
    pending: () => queue.length,
    /** Deliver up to `count` queued messages, picking them in random order. */
    deliver(count: number): void {
      for (let i = 0; i < count && queue.length > 0; i++) deliverOne();
    },
    /** Deliver everything, including messages sent in reply while draining. */
    drain(): void {
      for (let guard = 0; queue.length > 0; guard++) {
        if (guard > 1_000_000) throw new Error('drain: messages keep being produced');
        deliverOne();
      }
    },
    /** From now on nothing is lost or duplicated. */
    makeReliable(): void {
      current = { drop: 0, duplicate: 0 };
    },
  };
}

/** A transport the test drives by hand: `receive` hands ANY value to the handler. */
export interface ManualTransport extends RecordingTransport {
  /** Deliver `message` (of any type, like untrusted data from another tab) to the handler. */
  receive(message: unknown): void;
}

export function createManualTransport(): ManualTransport {
  let handler: Handler | undefined;
  const sent: string[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
    onMessage(next) {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
    close() {
      handler = undefined;
    },
    receive(message) {
      handler?.(message);
    },
  };
}
