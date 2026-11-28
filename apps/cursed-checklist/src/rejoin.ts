/**
 * Rejoin over the wire (DA-9, requirements D6): an exorcised tab asks the tabs that are still
 * members for a snapshot. sync.ts owns the transport and calls this module for the two messages
 * `snapshot-request` and `snapshot`; everything it needs from the outside is passed in, so it can
 * be tested with fake timers and no network.
 *
 * The two sides:
 *
 * - ANSWERING (every tab): a tab that is an ACTIVE member in its own view, is not paused, and whose
 *   view shows the requester as evicted, answers with `serializeSnapshot(crdt.snapshot())` after a
 *   random 0 to 300 ms delay. If it sees another tab's answer to the same requester first, it
 *   drops its own (the first reply wins). An evicted or paused tab never answers. Only evicted
 *   requesters are answered, so a stray request cannot make every tab serialize its state.
 * - REQUESTING (the exorcised tab): `request()` sends `snapshot-request` and waits. The first
 *   reply addressed to this tab that PASSES `deserializeSnapshot` (the kernel validates it in full:
 *   it came from another script) and shows this tab's old ID as evicted is kept as `ready`. An
 *   invalid reply is ignored and the wait goes on. After {@link REJOIN_TIMEOUT_MS} without a
 *   usable reply the status is `timed-out`, and `request()` may be called again.
 *
 * What the requester does with a `ready` snapshot (store it, reload, restore under a new ID) is in
 * rejoinSession.ts and App.tsx: the kernel is not swapped under a running page.
 */
import { deserializeSnapshot, serializeSnapshot } from '@bones/kernel';
import type { CRDT } from '@bones/kernel';
import { encodeSnapshot, encodeSnapshotRequest } from './protocol';

/** Longest random wait (ms) before a surviving tab answers a request. */
export const MAX_ANSWER_DELAY_MS = 300;

/** How long (ms) a requesting tab waits for a usable answer before it says nobody answered. */
export const REJOIN_TIMEOUT_MS = 5000;

/** Where a rejoin request stands, for the exorcised tab's banner. */
export type RejoinStatus =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'timed-out' }
  /** `snapshot` is a validated `serializeSnapshot` string, ready to be stored and restored on reload. */
  | { state: 'ready'; snapshot: string };

/** What {@link createRejoin} needs from the tab it belongs to. */
export interface RejoinDeps<T> {
  /** This tab's replica (read for its ID, membership view and snapshot). */
  crdt: CRDT<T>;
  /** Send one wire message. Must not throw (sync.ts passes a send that swallows errors). */
  send(message: string): void;
  /** True while this tab is stalled: a paused tab neither asks nor answers. */
  isPaused(): boolean;
  /** Tell the UI that the status changed. */
  notify(): void;
  /** A number in [0, 1) used for the answer delay; `Math.random` in the app, fixed in tests. */
  random(): number;
}

/** The handle returned by {@link createRejoin}. */
export interface Rejoin {
  /**
   * Ask the surviving tabs for a snapshot. Only an exorcised, running tab may ask.
   *
   * @returns false (and sends nothing) if this tab is not evicted, is paused, or was stopped
   */
  request(): boolean;
  /** A tab asked to rejoin: maybe answer it after a short random delay. */
  onRequest(from: string): void;
  /** A snapshot was sent to `to`: if it is for this tab, keep it when valid; either way, drop a pending answer to the same tab. */
  onSnapshot(to: string, snap: string): void;
  /** Where this tab's own request stands. */
  status(): RejoinStatus;
  /** Cancel every timer. Safe to call twice. */
  stop(): void;
}

/**
 * @param deps - The tab's replica and its way to send, pause state, UI notification and randomness
 * @returns The answering and requesting logic for one tab
 */
export function createRejoin<T>(deps: RejoinDeps<T>): Rejoin {
  const { crdt, send, isPaused, notify, random } = deps;
  let stopped = false;
  let current: RejoinStatus = { state: 'idle' };
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingAnswers = new Map<string, ReturnType<typeof setTimeout>>();

  /** True if this tab may answer `requester` right now. */
  const canAnswer = (requester: string): boolean => {
    if (stopped || isPaused() || requester === crdt.replicaId) return false;
    const view = crdt.getMembershipView();
    return view.activeMembers.has(crdt.replicaId) && view.evictedMembers.has(requester);
  };

  const clearWait = (): void => {
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    waitTimer = undefined;
  };

  return {
    request() {
      if (stopped || isPaused() || !crdt.getMembershipView().evictedMembers.has(crdt.replicaId)) return false;
      clearWait();
      current = { state: 'waiting' };
      send(encodeSnapshotRequest(crdt.replicaId));
      waitTimer = setTimeout(() => {
        waitTimer = undefined;
        if (stopped || current.state !== 'waiting') return;
        current = { state: 'timed-out' };
        notify();
      }, REJOIN_TIMEOUT_MS);
      notify();
      return true;
    },

    onRequest(from) {
      if (!canAnswer(from) || pendingAnswers.has(from)) return;
      const delay = Math.floor(random() * (MAX_ANSWER_DELAY_MS + 1));
      pendingAnswers.set(
        from,
        setTimeout(() => {
          pendingAnswers.delete(from);
          if (!canAnswer(from)) return; // things changed during the wait: paused, evicted, or the requester is gone from the view
          try {
            send(encodeSnapshot(from, serializeSnapshot(crdt.snapshot())));
          } catch {
            // a payload the snapshot cannot copy faithfully: no answer, the requester times out
          }
        }, delay)
      );
    },

    onSnapshot(to, snap) {
      // Someone else answered this requester: this tab's own answer would only be a duplicate.
      const mine = pendingAnswers.get(to);
      if (mine !== undefined) {
        clearTimeout(mine);
        pendingAnswers.delete(to);
      }
      if (stopped || to !== crdt.replicaId || current.state !== 'waiting') return;
      try {
        const snapshot = deserializeSnapshot(snap); // validates everything; throws on anything wrong
        if (!snapshot.membership.evictedMembers.has(crdt.replicaId)) return; // from before the eviction, or unrelated
      } catch {
        return; // not a usable snapshot: keep waiting for another
      }
      clearWait();
      current = { state: 'ready', snapshot: snap };
      notify();
    },

    status: () => current,

    stop() {
      if (stopped) return;
      stopped = true;
      clearWait();
      for (const timer of pendingAnswers.values()) clearTimeout(timer);
      pendingAnswers.clear();
    },
  };
}
