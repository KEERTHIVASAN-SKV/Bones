/**
 * Runs the pure coordinator core (@bones/coordinator) on a transport: the control page's brain.
 * It decodes what tabs say (protocol.ts), feeds the core, and turns the core's effects back into
 * messages. All decisions are in the core; this file only moves messages and reads the clock.
 *
 * The coordinator is not a replica: it holds no document, sends no operations and does not answer
 * hellos with catch-up. It listens for `hello` (the acknowledgement and the join) and `prepared`
 * (a survivor's reply to an eviction's prepare round). Everything else on the channel is ignored.
 *
 * Never throws on input: a malformed message, a broken clock or a broken listener is ignored.
 */
import { CoordinatorCore } from '@bones/coordinator';
import type { CoordinatorStatus, Effect, EvictionRefusal } from '@bones/coordinator';
import {
  decode,
  encodeFrontier,
  encodePrepare,
  encodeRejected,
  encodeRelease,
  encodeView,
} from './protocol';
import type { Transport } from './transport';

/** A member silent for longer than this is shown as stalled (detection only; nobody is evicted by it). */
export const STALL_AFTER_MS = 10_000;

export interface CoordinatorAdapter {
  /** The operator pressed Exorcise: start the two-phase eviction, or say why it was refused. */
  exorcise(target: string): { ok: true } | { ok: false; reason: EvictionRefusal };
  /** Back out of an eviction that is still in its prepare phase; the survivors release the target. */
  abort(): void;
  /** What the control page shows, as of now. */
  getStatus(): CoordinatorStatus;
  /** Call `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Stop listening. Does NOT close the transport (the caller owns it). */
  stop(): void;
}

/**
 * Start a coordinator on `transport`.
 *
 * @param transport - Where tabs talk; the caller owns it and closes it
 * @param clock - Milliseconds now (injected so the core never reads a clock; use `Date.now` in the page)
 * @param stallAfterMs - Silence longer than this marks a member as stalled in the status
 * @returns The adapter
 */
export function startCoordinator(
  transport: Transport,
  clock: () => number,
  stallAfterMs: number = STALL_AFTER_MS
): CoordinatorAdapter {
  const core = new CoordinatorCore();
  const listeners = new Set<() => void>();
  let stopped = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a broken listener must not break the coordinator
      }
    }
  };

  const post = (message: string): void => {
    try {
      transport.send(message);
    } catch {
      // a closed channel must not crash the page; tabs say hello again in a few seconds
    }
  };

  /** Every effect is a broadcast: all tabs hear all messages, and each one acts only on what concerns it. */
  const perform = (effects: Effect[]): void => {
    for (const effect of effects) {
      if (effect.type === 'view') post(encodeView(effect.view));
      else if (effect.type === 'frontier') post(encodeFrontier(effect.epoch, effect.vv));
      else if (effect.type === 'prepare') post(encodePrepare(effect.target, effect.epoch));
      else if (effect.type === 'release') post(encodeRelease(effect.target));
      else post(encodeRejected(effect.to, effect.epoch));
    }
  };

  const handle = (message: unknown): void => {
    if (stopped) return;
    const msg = decode(message);
    if (msg === null) return;
    try {
      if (msg.t === 'hello') {
        if (msg.from === undefined || msg.epoch === undefined) return; // an anonymous hello cannot be acknowledged
        perform(core.onHello({ from: msg.from, epoch: msg.epoch, vv: msg.vv }, clock()));
      } else if (msg.t === 'prepared') {
        perform(core.onPrepared(msg, clock()));
      } else {
        return; // ops, views, frontiers, prepares: not for the coordinator
      }
    } catch {
      return; // for example a broken clock: the message is dropped, nothing changed
    }
    notify();
  };

  const unsubscribe = transport.onMessage(handle);

  return {
    exorcise(target) {
      const result = core.startEviction(target);
      if (!result.ok) return result;
      perform(result.effects);
      notify();
      return { ok: true };
    },
    abort() {
      const effects = core.abortEviction();
      if (effects.length === 0) return;
      perform(effects);
      notify();
    },
    getStatus() {
      // Reading the status must never throw (it runs inside a render): a non-finite clock counts as 0.
      const now = clock();
      return core.getStatus(Number.isFinite(now) ? now : 0, stallAfterMs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
