/**
 * The coordinator's pure core (KER-077; demo-apps design "Coordinator", decision S6).
 *
 * It decides; it never does. Every method takes what happened (a message, a time) and returns
 * the EFFECTS the caller must perform (broadcast a view, broadcast a frontier, ask survivors to
 * freeze). There is no I/O, no timer, no clock read and no randomness in this file: the caller
 * passes `now`, so the same calls always give the same result. The adapters (the `/control` page
 * in each app, and later a Node service) turn effects into real messages.
 *
 * What it does:
 * - A hello is the ACKNOWLEDGEMENT of a member's version vector (no separate ack message). Only a
 *   hello at the current epoch counts (control-message fencing, requirements.md 10.0); a stale
 *   one is answered with the current view. A hello from an unknown, not-evicted replica joins it.
 * - The stable frontier is the kernel's `computeStableFrontier` over ACTIVE members only, kept
 *   monotonic (the largest value seen) and re-broadcast now and then so a lost message cannot
 *   strand garbage collection.
 * - Eviction is MANUAL and two-phase (requirements.md 10.3): `startEviction` asks the survivors to
 *   freeze the target and report their contiguous applied seq (`prepare` / `prepared`); when every
 *   survivor has replied the cutoff is the MAX of the replies and the new view is published.
 *   The eviction is then PENDING until every active member's acknowledged vector holds the target's
 *   operations up to the cutoff (that hello is the `evict-confirm`); `getStatus` reports it.
 *   Nothing is ever evicted automatically.
 *
 * Trust: everything arriving here may come from any script on the origin. Malformed messages are
 * ignored, never thrown. Replicas are assumed to report their version vectors honestly
 * (requirements.md 11).
 */

import {
  addReplica,
  assertValidVersionVector,
  computeStableFrontier,
  createMembership,
  getMembership,
  isControlMessageRejected,
  isValidReplicaId,
  mergeVersionVectors,
  removeReplica,
} from '@bones/kernel';
import type { MembershipView, VersionVector } from '@bones/kernel';

/** What a member's hello carries (already parsed from the wire; still untrusted). */
export interface HelloMessage {
  from: string;
  epoch: number;
  vv: VersionVector;
}

/** A survivor's reply to `prepare`: its contiguous applied seq for the target, frozen. */
export interface PreparedMessage {
  from: string;
  target: string;
  epoch: number;
  seq: number;
}

/** Something the caller must do. All of them are broadcasts: every tab hears every message. */
export type Effect =
  /** Publish this membership view (a join, or an eviction with its cutoff). */
  | { type: 'view'; view: MembershipView }
  /** Publish the stable frontier computed for `epoch`. Tabs apply it only at their own epoch. */
  | { type: 'frontier'; epoch: number; vv: VersionVector }
  /** Ask `survivors` to freeze `target` (`crdt.holdAuthor`) and reply with `prepared`. */
  | { type: 'prepare'; target: string; epoch: number; survivors: string[] }
  /** The eviction of `target` was aborted: `crdt.releaseAuthor(target)`. */
  | { type: 'release'; target: string; survivors: string[] }
  /** Tell `to` its message was rejected, with the current epoch (control-message fencing). */
  | { type: 'rejected'; to: string; epoch: number };

/** Why `startEviction` refused. */
export type EvictionRefusal = 'invalid-id' | 'not-a-member' | 'eviction-in-progress' | 'no-survivors';

export interface CoreOptions {
  /** Members to start with (ack empty, never heard from). Normally none: members join by hello. */
  initialMembers?: Iterable<string>;
  /** Re-broadcast the frontier on a hello when this many ms have passed since the last time (default 3000). */
  frontierResendMs?: number;
  /** Most active members; a hello that would add more is ignored (default 32). */
  maxMembers?: number;
}

/** One row of the control page. */
export interface MemberStatus {
  id: string;
  /** The version vector it last acknowledged (a copy). */
  ack: VersionVector;
  /** The `now` of its last hello, or undefined if never heard from. */
  lastHeard: number | undefined;
  /** True if never heard from, or silent for longer than `stallAfterMs`. Detection only. */
  stalled: boolean;
}

/** An evicted replica and how far its reconciliation has got. */
export interface EvictedStatus {
  id: string;
  cutoff: number;
  /** Active members whose acknowledged vector does not yet hold the target's operations up to the cutoff. */
  waitingFor: string[];
  /** True when nobody is waiting for. */
  complete: boolean;
}

export interface CoordinatorStatus {
  epoch: number;
  frontier: VersionVector;
  members: MemberStatus[];
  evicted: EvictedStatus[];
  /** The eviction in its prepare phase, if any, and the survivors that have not replied yet. */
  eviction: { target: string; waitingFor: string[] } | null;
}

interface Member {
  ack: VersionVector;
  lastHeard: number | undefined;
}

interface Prepare {
  target: string;
  survivors: string[];
  replies: Map<string, number>;
}

const DEFAULT_RESEND_MS = 3000;
const DEFAULT_MAX_MEMBERS = 32;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertTime(now: unknown): asserts now is number {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new RangeError(`coordinator: "now" must be a finite number, got ${String(now)}`);
  }
}

export class CoordinatorCore {
  private view: MembershipView;
  /** ACTIVE members only. */
  private readonly members = new Map<string, Member>();
  /** The largest stable frontier computed so far; it never moves backwards. */
  private frontier: VersionVector = new Map();
  private lastFrontierSentAt: number | undefined;
  private prepare: Prepare | null = null;
  private readonly frontierResendMs: number;
  private readonly maxMembers: number;

  /**
   * @param options - See {@link CoreOptions}
   * @throws TypeError if an initial member ID is invalid
   * @throws RangeError if an option is not a positive number
   */
  constructor(options: CoreOptions = {}) {
    this.frontierResendMs = options.frontierResendMs ?? DEFAULT_RESEND_MS;
    this.maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS;
    if (!(this.frontierResendMs > 0) || !Number.isFinite(this.frontierResendMs)) {
      throw new RangeError('coordinator: frontierResendMs must be a positive number');
    }
    if (!Number.isSafeInteger(this.maxMembers) || this.maxMembers < 1) {
      throw new RangeError('coordinator: maxMembers must be a positive integer');
    }
    this.view = createMembership(options.initialMembers ?? []);
    for (const id of this.view.activeMembers) this.members.set(id, { ack: new Map(), lastHeard: undefined });
  }

  // ---------------------------------------------------------------- queries

  /** @returns A copy of the membership view in force. */
  getView(): MembershipView {
    return getMembership(this.view);
  }

  /** @returns A copy of the stable frontier (monotonic). */
  getFrontier(): VersionVector {
    return new Map(this.frontier);
  }

  /**
   * What the control page shows.
   *
   * @param now - The current time (ms), supplied by the caller
   * @param stallAfterMs - A member silent for longer than this is shown as stalled (detection only)
   * @returns A fresh snapshot of the coordinator's state
   */
  getStatus(now: number, stallAfterMs: number): CoordinatorStatus {
    assertTime(now);
    const members: MemberStatus[] = [...this.members]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([id, m]) => ({
        id,
        ack: new Map(m.ack),
        lastHeard: m.lastHeard,
        stalled: m.lastHeard === undefined || now - m.lastHeard > stallAfterMs,
      }));
    const evicted: EvictedStatus[] = [...this.view.evictedMembers]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([id, cutoff]) => {
        const waitingFor = [...this.members.keys()]
          .filter((member) => (this.members.get(member)?.ack.get(id) ?? 0) < cutoff)
          .sort(compareStrings);
        return { id, cutoff, waitingFor, complete: waitingFor.length === 0 };
      });
    const eviction =
      this.prepare === null
        ? null
        : {
            target: this.prepare.target,
            waitingFor: this.prepare.survivors.filter((id) => !this.prepare?.replies.has(id)),
          };
    return { epoch: this.view.epoch, frontier: new Map(this.frontier), members, evicted, eviction };
  }

  // ---------------------------------------------------------------- hello (ack, join)

  /**
   * A member said hello: this is its acknowledgement, and for an unknown replica it is the join.
   * Malformed input is ignored (no effects, no change).
   *
   * @param msg - The parsed hello (validated here)
   * @param now - The current time in ms (supplied by the caller)
   * @returns The effects to perform
   * @throws RangeError if `now` is not a finite number
   */
  onHello(msg: HelloMessage, now: number): Effect[] {
    assertTime(now);
    if (!this.isWellFormedHello(msg)) return [];
    const from = msg.from;
    const effects: Effect[] = [];

    if (this.view.evictedMembers.has(from)) {
      return [{ type: 'rejected', to: from, epoch: this.view.epoch }];
    }

    if (!this.members.has(from)) {
      // No joins while an eviction is being prepared: a newcomer was not asked to freeze the
      // target and could apply operations beyond the cutoff. It simply retries on its next hello.
      if (this.prepare !== null || this.members.size >= this.maxMembers) return [];
      this.view = addReplica(this.view, from);
      // Its first vector is an honest report of what it holds, so it counts as its first ack.
      this.members.set(from, { ack: mergeVersionVectors(new Map(), msg.vv), lastHeard: now });
      effects.push({ type: 'view', view: getMembership(this.view) });
      this.pushFrontier(effects, now, true);
      return effects;
    }

    const member = this.members.get(from) as Member;
    member.lastHeard = now;
    if (isControlMessageRejected(this.view, from, msg.epoch)) {
      // Stale epoch: its acknowledgement does not count. It gets the current view and catches up.
      return [{ type: 'view', view: getMembership(this.view) }];
    }

    member.ack = mergeVersionVectors(member.ack, msg.vv); // an honest vector only grows
    if (this.prepare !== null && this.prepare.survivors.includes(from) && !this.prepare.replies.has(from)) {
      effects.push({ type: 'prepare', target: this.prepare.target, epoch: this.view.epoch, survivors: [...this.prepare.survivors] });
    }
    this.pushFrontier(effects, now, false);
    return effects;
  }

  private isWellFormedHello(msg: HelloMessage): boolean {
    if (msg === null || typeof msg !== 'object') return false;
    if (typeof msg.from !== 'string' || !isValidReplicaId(msg.from)) return false;
    if (!isEpoch(msg.epoch)) return false;
    try {
      assertValidVersionVector(msg.vv);
    } catch {
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- eviction

  /**
   * The operator pressed Exorcise. Starts the prepare phase: the survivors are asked to freeze
   * the target and reply with their contiguous applied seq for it.
   *
   * @param target - The member to evict
   * @returns The effects to perform, or why it was refused (nothing changed)
   */
  startEviction(target: string): { ok: true; effects: Effect[] } | { ok: false; reason: EvictionRefusal } {
    if (typeof target !== 'string' || !isValidReplicaId(target)) return { ok: false, reason: 'invalid-id' };
    if (!this.members.has(target)) return { ok: false, reason: 'not-a-member' };
    if (this.prepare !== null) return { ok: false, reason: 'eviction-in-progress' };
    const survivors = [...this.members.keys()].filter((id) => id !== target).sort(compareStrings);
    if (survivors.length === 0) return { ok: false, reason: 'no-survivors' };
    this.prepare = { target, survivors, replies: new Map() };
    return { ok: true, effects: [{ type: 'prepare', target, epoch: this.view.epoch, survivors: [...survivors] }] };
  }

  /**
   * A survivor froze the target and reports its contiguous applied seq. When every survivor has
   * replied, the cutoff is the MAX of the replies and the eviction view is published.
   * The FIRST reply of a survivor wins (a repeated or forged one cannot inflate the cutoff).
   * Malformed or unexpected replies are ignored.
   *
   * @param msg - The parsed reply (validated here)
   * @param now - The current time in ms
   * @returns The effects to perform (the new view and frontier once the last reply is in)
   * @throws RangeError if `now` is not a finite number
   */
  onPrepared(msg: PreparedMessage, now: number): Effect[] {
    assertTime(now);
    const prepare = this.prepare;
    if (prepare === null || msg === null || typeof msg !== 'object') return [];
    if (typeof msg.from !== 'string' || typeof msg.target !== 'string') return [];
    if (msg.target !== prepare.target || !prepare.survivors.includes(msg.from)) return [];
    if (!isEpoch(msg.epoch) || !isEpoch(msg.seq)) return [];
    if (isControlMessageRejected(this.view, msg.from, msg.epoch)) {
      return [{ type: 'rejected', to: msg.from, epoch: this.view.epoch }];
    }
    if (prepare.replies.has(msg.from)) return [];
    prepare.replies.set(msg.from, msg.seq);
    if (prepare.replies.size < prepare.survivors.length) return [];

    const cutoff = Math.max(...prepare.replies.values());
    this.view = removeReplica(this.view, prepare.target, cutoff);
    this.members.delete(prepare.target);
    this.prepare = null;
    const effects: Effect[] = [{ type: 'view', view: getMembership(this.view) }];
    this.pushFrontier(effects, now, true);
    return effects;
  }

  /**
   * The operator backs out of an eviction that is still in its prepare phase (for example a
   * survivor never replies). The survivors are told to release the target. Nothing changed in
   * the membership. Does nothing if no eviction is being prepared.
   *
   * @returns The effects to perform
   */
  abortEviction(): Effect[] {
    if (this.prepare === null) return [];
    const { target, survivors } = this.prepare;
    this.prepare = null;
    return [{ type: 'release', target, survivors: [...survivors] }];
  }

  // ---------------------------------------------------------------- frontier

  /**
   * Recompute the frontier (largest value seen) and append a `frontier` effect if it grew, if
   * `force` is set (a new view: every tab needs the frontier at the new epoch), or if it has not
   * been broadcast for `frontierResendMs` (a lost message must not strand garbage collection).
   */
  private pushFrontier(effects: Effect[], now: number, force: boolean): void {
    const acks = new Map([...this.members].map(([id, m]) => [id, m.ack]));
    const computed = computeStableFrontier(acks, new Set(this.members.keys()));
    const merged = mergeVersionVectors(this.frontier, computed);
    let grew = merged.size !== this.frontier.size;
    for (const [id, seq] of merged) if (seq > (this.frontier.get(id) ?? 0)) grew = true;
    this.frontier = merged;

    if (this.frontier.size === 0) return;
    const due = this.lastFrontierSentAt === undefined || now - this.lastFrontierSentAt >= this.frontierResendMs;
    if (force || grew || due) {
      this.lastFrontierSentAt = now;
      effects.push({ type: 'frontier', epoch: this.view.epoch, vv: new Map(this.frontier) });
    }
  }
}
