/**
 * Sync between the tabs of one browser: it connects a CRDT to a transport (kernel `opsSince` does
 * the catch-up) and carries the coordinator's messages to the kernel. Nothing here knows about
 * React or about BroadcastChannel specifically. The wire format is in protocol.ts.
 *
 * Why hello: BroadcastChannel does not replay messages sent before a tab opened, and any message
 * can be lost while a tab is busy or in the background. Every replica announces its version
 * vector (with its ID and epoch) when it starts and every `intervalMs` after that. A replica that
 * hears a hello answers with the operations the sender lacks (`crdt.opsSince`). So a late tab, or
 * a tab that missed a message, catches up within one interval, and duplicated or reordered
 * messages are harmless (the kernel drops duplicates and buffers out-of-order ops). The same hello
 * is the acknowledgement the coordinator uses to compute the stable frontier.
 *
 * Coordinator messages: `view` -> `crdt.updateMembership`, `frontier` -> `crdt.updateStableFrontier`
 * (the kernel applies it only at this replica's epoch), `prepare` -> `crdt.holdAuthor` and a
 * `prepared` reply, `release` -> `crdt.releaseAuthor`. Any script on the same origin can post
 * these, so the app assumes honest peers (see the README).
 *
 * Pause (the demo's "stall"): a paused tab sends nothing and hears nothing, but its local edits
 * keep working and are counted. `resume()` sends them, then says hello.
 *
 * Browsers throttle timers in background tabs (to once a second, or once a minute after a few
 * minutes hidden), so catching up can take that long for a hidden tab.
 *
 * Everything received is untrusted: another script on the same origin can post to the channel.
 */
import type { CRDT, OpIdKey, Operation } from '@bones/kernel';
import {
  decode,
  encodeHello,
  encodeOp,
  encodePrepared,
} from './protocol';
import type { Incoming } from './protocol';
import type { Transport } from './transport';

/** How often a replica announces its version vector. */
export const HELLO_INTERVAL_MS = 3000;

/** Most distinct fenced operations remembered (a hostile peer cannot grow it without bound). */
const MAX_FENCED_REMEMBERED = 10_000;

/** What the panel shows about this tab's sync. */
export interface SyncStats {
  /** True between `pause()` and `resume()`. */
  paused: boolean;
  /** Local operations made while paused that have not been sent yet. */
  unsent: number;
  /** Distinct operations REFUSED because their author is evicted and they lie beyond its cutoff, per author. */
  fenced: Record<string, number>;
}

/** The handle returned by {@link startSync}. */
export interface Sync {
  /**
   * Broadcast an operation that this replica just created (`crdt.insert` / `crdt.delete`). The
   * operation is already applied locally. While paused it is kept and counted instead. If sending
   * fails the edit is kept, and the next hello round delivers it. Does nothing after `stop`.
   */
  sendOp(op: Operation<unknown>): void;
  /** Stop sending and hearing (a "stalled" tab). Local edits keep working. */
  pause(): void;
  /** Send the operations made while paused, then say hello. */
  resume(): void;
  isPaused(): boolean;
  /** A fresh copy of the counters the panel shows. */
  getStats(): SyncStats;
  /** Call `listener` when the stats change (pause, resume, a new refused operation). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Stop the hello timer and the message handler. Safe to call twice. Does NOT close the transport. */
  stop(): void;
}

/**
 * Start syncing `crdt` over `transport`. Sends a hello right away.
 *
 * Operations are applied whatever their value is: dropping one would leave a gap in its author's
 * sequence and every later operation from that author would wait in the buffer forever. The UI
 * hides values it cannot render (`visibleItems`).
 *
 * @param crdt - This tab's replica
 * @param transport - Where messages go; the caller owns it and closes it
 * @param intervalMs - Time between hellos (default {@link HELLO_INTERVAL_MS})
 * @returns A handle to broadcast local operations, pause, and stop
 * @throws RangeError if `intervalMs` is not a positive finite number
 */
export function startSync<T>(
  crdt: CRDT<T>,
  transport: Transport,
  intervalMs: number = HELLO_INTERVAL_MS
): Sync {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`startSync: intervalMs must be a positive number, got ${String(intervalMs)}`);
  }
  let stopped = false;
  let paused = false;
  const unsent = new Map<OpIdKey, Operation<unknown>>();
  const fencedIds = new Set<OpIdKey>();
  const fencedByAuthor = new Map<string, number>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a broken listener must not break syncing
      }
    }
  };

  /** Send, never throw: a closed channel must not crash the app; the next hello round retries. */
  const trySend = (build: () => string): void => {
    try {
      transport.send(build());
    } catch {
      // ignored on purpose, see above
    }
  };
  const sendOpMessage = (op: Operation<unknown>): void => trySend(() => encodeOp(op));
  const sendHello = (): void => {
    if (paused) return;
    trySend(() => encodeHello(crdt.replicaId, crdt.getMembershipView().epoch, crdt.getVV()));
  };

  const countFenced = (op: Operation<unknown>): void => {
    if (fencedIds.has(op.id) || fencedIds.size >= MAX_FENCED_REMEMBERED) return;
    fencedIds.add(op.id);
    fencedByAuthor.set(op.replicaId, (fencedByAuthor.get(op.replicaId) ?? 0) + 1);
    notify();
  };

  const onMessage = (msg: Incoming): void => {
    switch (msg.t) {
      case 'op': {
        const result = crdt.applyOp(msg.op as Operation<T>); // validated by decode; the kernel validates again
        if (result.status === 'fenced') countFenced(msg.op);
        return;
      }
      case 'hello':
        for (const op of crdt.opsSince(msg.vv)) sendOpMessage(op);
        return;
      case 'view':
        crdt.updateMembership(msg.view);
        return;
      case 'frontier':
        crdt.updateStableFrontier(msg.vv, msg.epoch); // the kernel ignores another epoch's frontier
        return;
      case 'prepare': {
        const epoch = crdt.getMembershipView().epoch;
        // The target does not freeze itself, and a prepare for another epoch is stale (or a replay):
        // acting on it would freeze an author for nothing.
        if (msg.target === crdt.replicaId || msg.epoch !== epoch) return;
        const seq = crdt.holdAuthor(msg.target);
        trySend(() => encodePrepared(crdt.replicaId, msg.target, epoch, seq));
        return;
      }
      case 'release':
        crdt.releaseAuthor(msg.target);
        return;
      default:
        return; // 'prepared' and 'rejected' are for the coordinator
    }
  };

  const handle = (message: unknown): void => {
    if (stopped || paused) return;
    const msg = decode(message);
    if (msg === null) return;
    try {
      onMessage(msg);
    } catch {
      // A valid-looking message the kernel refused (for example a malformed operation, or a hold
      // on an invalid ID). Ignored: it must not crash the page or change any state.
    }
  };

  // Subscribe BEFORE the first hello: the replies to it must not be missed.
  const unsubscribe = transport.onMessage(handle);
  const timer = setInterval(sendHello, intervalMs);
  sendHello();

  return {
    sendOp(op) {
      if (stopped) return;
      if (paused) {
        unsent.set(op.id, op);
        notify();
        return;
      }
      sendOpMessage(op);
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      notify();
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      const pending = [...unsent.values()];
      unsent.clear();
      for (const op of pending) sendOpMessage(op);
      sendHello();
      notify();
    },
    isPaused: () => paused,
    getStats: () => ({ paused, unsent: unsent.size, fenced: Object.fromEntries(fencedByAuthor) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      listeners.clear();
    },
  };
}
