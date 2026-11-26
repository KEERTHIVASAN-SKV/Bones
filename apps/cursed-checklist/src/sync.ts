/**
 * Sync between the tabs of one browser: it connects a CRDT to a transport (kernel `opsSince` does
 * the catch-up). Nothing here knows about React or about BroadcastChannel specifically.
 *
 * Wire format: every message is a JSON string, one of
 *   { "t": "op",    "op": "<serializeOp output>" }     one operation
 *   { "t": "hello", "vv": { "<replicaId>": <seq> } }   "this is what I have applied"
 *
 * Why hello: BroadcastChannel does not replay messages sent before a tab opened, and any message
 * can be lost while a tab is busy or in the background. Every replica announces its version
 * vector when it starts and every `intervalMs` after that. A replica that hears a hello answers
 * with the operations the sender lacks (`crdt.opsSince`). So a late tab, or a tab that missed a
 * message, catches up within one interval, and duplicated or reordered messages are harmless
 * (the kernel drops duplicates and buffers out-of-order ops).
 *
 * Browsers throttle timers in background tabs (to once a second, or once a minute after a few
 * minutes hidden), so catching up can take that long for a hidden tab.
 *
 * Everything received is untrusted: another script on the same origin can post to the channel.
 */
import { deserializeOp, deserializeVersionVector, serializeOp, serializeVersionVector } from '@bones/kernel';
import type { CRDT, Operation } from '@bones/kernel';
import type { Transport } from './transport';

/** How often a replica announces its version vector. */
export const HELLO_INTERVAL_MS = 3000;

/** The handle returned by {@link startSync}. */
export interface Sync {
  /**
   * Broadcast an operation that this replica just created (`crdt.insert` / `crdt.delete`). The
   * operation is already applied locally. If sending fails the edit is kept, and the next hello
   * round delivers it. Does nothing after {@link Sync.stop}.
   */
  sendOp(op: Operation<unknown>): void;
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
 * @returns A handle to broadcast local operations and to stop
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

  /** Send, never throw: a closed channel must not crash the app; the next hello round retries. */
  const trySend = (build: () => string): void => {
    try {
      transport.send(build());
    } catch {
      // ignored on purpose, see above
    }
  };
  const sendOpMessage = (op: Operation<unknown>): void =>
    trySend(() => JSON.stringify({ t: 'op', op: serializeOp(op) }));
  const sendHello = (): void =>
    trySend(() => JSON.stringify({ t: 'hello', vv: serializeVersionVector(crdt.getVV()) }));

  const handle = (message: unknown): void => {
    if (stopped || typeof message !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(message);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const wire = parsed as { t?: unknown; op?: unknown; vv?: unknown };

      if (wire.t === 'op') {
        if (typeof wire.op !== 'string') return;
        crdt.applyOp(deserializeOp<T>(wire.op)); // throws on a malformed operation: state untouched
      } else if (wire.t === 'hello') {
        // An array would pass for an object, and its indexes would be read as replica IDs.
        if (wire.vv === null || typeof wire.vv !== 'object' || Array.isArray(wire.vv)) return;
        const theirs = deserializeVersionVector(wire.vv as Record<string, number>);
        for (const op of crdt.opsSince(theirs)) sendOpMessage(op);
      }
    } catch {
      // Untrusted input that is not valid JSON, not a valid message or not a valid operation.
      // Ignored: it must not crash the page or change any state.
    }
  };

  // Subscribe BEFORE the first hello: the replies to it must not be missed.
  const unsubscribe = transport.onMessage(handle);
  const timer = setInterval(sendHello, intervalMs);
  sendHello();

  return {
    sendOp(op) {
      if (!stopped) sendOpMessage(op);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
