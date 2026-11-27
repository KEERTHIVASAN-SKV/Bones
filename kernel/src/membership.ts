/**
 * Membership, epochs and fencing (KER-018 to KER-022; requirements.md sections 9 and 10;
 * design.md "MembershipView").
 *
 * A membership view says who may write: the ACTIVE members, the EVICTED members with their
 * cutoff (the highest sequence number of theirs that survivors still accept), and an epoch that
 * counts membership changes. All functions here are pure: they never change their inputs and
 * return new views. There is no clock; the epoch is the only "time".
 *
 * Two fencing mechanisms, deliberately separate (requirements.md 10.0):
 * - EDIT operations are fenced by AUTHOR and CUTOFF ({@link isFenced}). The `epoch` field of an
 *   operation is never read.
 * - CONTROL messages (acks, views, frontiers) are fenced by EPOCH and membership
 *   ({@link isControlMessageRejected}).
 *
 * An evicted ID never comes back. A returning replica rejoins from a snapshot as a NEW
 * incarnation with a new ID, so a membership view never has to un-evict anyone.
 */

import type { MembershipView } from './types.js';
import { isValidReplicaId, stableStringify } from './utils.js';

/** Plain-object form of a view, for JSON (Sets and Maps do not survive `JSON.stringify`). */
export interface MembershipJSON {
  /** Active replica IDs, sorted by code unit. */
  activeMembers: string[];
  /** The epoch. */
  epoch: number;
  /** Evicted replica ID to cutoff (null-prototype object, so an ID like `__proto__` stays a key). */
  evictedMembers: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** A replica ID is a string that passes the kernel's ID check (`isValidReplicaId` accepts `5`, so check the type first). */
function isReplicaIdString(value: unknown): value is string {
  return typeof value === 'string' && isValidReplicaId(value);
}

/** An epoch is a non-negative safe integer. */
function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A cutoff is a non-negative safe integer. 0 is valid: it fences every operation of that replica. */
function isCutoff(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function compareStrings(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function copyView(view: MembershipView): MembershipView {
  return {
    activeMembers: new Set(view.activeMembers),
    evictedMembers: new Map(view.evictedMembers),
    epoch: view.epoch,
  };
}

/**
 * Check that a value is a well-formed membership view. Use it on any view that did not come
 * through {@link deserializeMembership} (an object received in-process, a snapshot field).
 *
 * Validated: `activeMembers` is a Set of valid replica IDs; `evictedMembers` is a Map from valid
 * replica IDs to cutoffs (non-negative safe integers); `epoch` is a non-negative safe integer;
 * no replica is both active and evicted.
 *
 * @param value - Candidate view
 * @throws TypeError describing the first problem found
 */
export function assertValidMembershipView(value: unknown): asserts value is MembershipView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('membership: expected an object');
  }
  const v = value as { activeMembers?: unknown; evictedMembers?: unknown; epoch?: unknown };
  if (!(v.activeMembers instanceof Set)) throw new TypeError('membership: "activeMembers" must be a Set');
  if (!(v.evictedMembers instanceof Map)) throw new TypeError('membership: "evictedMembers" must be a Map');
  if (!isEpoch(v.epoch)) throw new TypeError('membership: "epoch" must be a non-negative integer');
  for (const id of v.activeMembers) {
    if (!isReplicaIdString(id)) throw new TypeError(`membership: invalid active replica ID ${String(id)}`);
  }
  for (const [id, cutoff] of v.evictedMembers) {
    if (!isReplicaIdString(id)) throw new TypeError(`membership: invalid evicted replica ID ${String(id)}`);
    if (!isCutoff(cutoff)) {
      throw new TypeError(`membership: cutoff for "${id}" must be a non-negative integer, got ${String(cutoff)}`);
    }
    if (v.activeMembers.has(id)) throw new TypeError(`membership: "${id}" is both active and evicted`);
  }
}

// ---------------------------------------------------------------------------
// Create, query, change (KER-018, KER-019)
// ---------------------------------------------------------------------------

/**
 * A new membership at epoch 0 with nobody evicted.
 *
 * @param activeMembers - The initial active replica IDs (copied; repeats are ignored)
 * @returns A new view
 * @throws TypeError if an ID is not a valid replica ID
 */
export function createMembership(activeMembers: Iterable<string>): MembershipView {
  const view: MembershipView = { activeMembers: new Set(), evictedMembers: new Map(), epoch: 0 };
  for (const id of activeMembers) {
    if (!isReplicaIdString(id)) throw new TypeError(`createMembership: invalid replica ID ${String(id)}`);
    view.activeMembers.add(id);
  }
  return view;
}

/**
 * An independent copy of a view (changing the copy never changes the original).
 *
 * @param view - The view
 * @returns A copy
 */
export function getMembership(view: MembershipView): MembershipView {
  return copyView(view);
}

/**
 * The current epoch.
 *
 * @param view - The view
 * @returns The epoch (0 at creation, +1 per membership change)
 */
export function getEpoch(view: MembershipView): number {
  return view.epoch;
}

/**
 * Add an active member and increment the epoch by exactly 1. Adding someone who is already
 * active changes nothing (same epoch), so a repeated "join" message cannot inflate the epoch.
 *
 * @param view - The current view (not changed)
 * @param replicaId - The joining replica's ID
 * @returns A new view
 * @throws TypeError if the ID is invalid
 * @throws RangeError if the replica was evicted (an evicted ID never returns; use a new ID)
 */
export function addReplica(view: MembershipView, replicaId: string): MembershipView {
  if (!isReplicaIdString(replicaId)) throw new TypeError(`addReplica: invalid replica ID ${String(replicaId)}`);
  if (view.evictedMembers.has(replicaId)) {
    throw new RangeError(`addReplica: "${replicaId}" was evicted and cannot return; rejoin with a new replica ID`);
  }
  if (view.activeMembers.has(replicaId)) return copyView(view);
  const next = copyView(view);
  next.activeMembers.add(replicaId);
  next.epoch = view.epoch + 1;
  return next;
}

/**
 * Evict a member: move it to `evictedMembers` with its cutoff and increment the epoch by exactly 1.
 * The cutoff comes from the coordinator (the highest sequence of this replica that the survivors
 * hold), never from a clock. Evicting someone who is already evicted changes nothing: the epoch
 * and the FIRST cutoff stay.
 *
 * @param view - The current view (not changed)
 * @param replicaId - The replica to evict
 * @param cutoff - Highest sequence number of this replica's operations that is still accepted (0 = none)
 * @returns A new view
 * @throws TypeError if the ID is invalid or the cutoff is not a non-negative safe integer
 * @throws RangeError if the replica is neither active nor already evicted
 */
export function removeReplica(view: MembershipView, replicaId: string, cutoff: number): MembershipView {
  if (!isReplicaIdString(replicaId)) throw new TypeError(`removeReplica: invalid replica ID ${String(replicaId)}`);
  if (!isCutoff(cutoff)) {
    throw new TypeError(`removeReplica: cutoff must be a non-negative integer, got ${String(cutoff)}`);
  }
  if (view.evictedMembers.has(replicaId)) return copyView(view);
  if (!view.activeMembers.has(replicaId)) {
    throw new RangeError(`removeReplica: "${replicaId}" is not a member`);
  }
  const next = copyView(view);
  next.activeMembers.delete(replicaId);
  next.evictedMembers.set(replicaId, cutoff);
  next.epoch = view.epoch + 1;
  return next;
}

/**
 * Install a view published by the coordinator, or keep the current one.
 *
 * The incoming view replaces the current one only if its epoch is GREATER (an equal or lower
 * epoch is old news) and it does not contradict what this replica already knows: an evicted
 * replica must stay evicted with the same cutoff, and an active member may only disappear by
 * being evicted. The epoch may skip numbers: views carry the whole state, so a lost message must
 * not block a replica forever. A contradicting view is ignored rather than trusted.
 *
 * @param current - The view in force (not changed)
 * @param incoming - The published view (validated; not changed)
 * @returns `applied` is true if the incoming view was installed; `view` is a copy of the view now in force
 * @throws TypeError if `incoming` is not a well-formed view
 */
export function applyMembershipView(
  current: MembershipView,
  incoming: MembershipView
): { view: MembershipView; applied: boolean } {
  assertValidMembershipView(incoming);
  if (incoming.epoch <= current.epoch) return { view: copyView(current), applied: false };

  for (const [id, cutoff] of current.evictedMembers) {
    if (incoming.evictedMembers.get(id) !== cutoff) return { view: copyView(current), applied: false };
  }
  for (const id of current.activeMembers) {
    if (!incoming.activeMembers.has(id) && !incoming.evictedMembers.has(id)) {
      return { view: copyView(current), applied: false };
    }
  }
  return { view: copyView(incoming), applied: true };
}

// ---------------------------------------------------------------------------
// Fencing and cutoffs (KER-020, KER-022)
// ---------------------------------------------------------------------------

/**
 * Whether a replica is an active member.
 *
 * @param view - The view
 * @param replicaId - The replica ID
 * @returns true if active; false if evicted or unknown
 */
export function isReplicaActive(view: MembershipView, replicaId: string): boolean {
  return view.activeMembers.has(replicaId);
}

/**
 * The cutoff of an evicted replica.
 *
 * @param view - The view
 * @param replicaId - The replica ID
 * @returns The cutoff, or undefined if the replica is active or unknown
 */
export function getCutoff(view: MembershipView, replicaId: string): number | undefined {
  return view.evictedMembers.get(replicaId);
}

/**
 * Whether `seq` is above the cutoff of an evicted replica. False for an active or unknown
 * replica (they have no cutoff); use {@link isFenced} for the full accept/reject decision.
 *
 * @param view - The view
 * @param replicaId - The replica ID
 * @param seq - A sequence number of that replica
 * @returns true only for an evicted replica and a seq above its cutoff
 */
export function isBeyondCutoff(view: MembershipView, replicaId: string, seq: number): boolean {
  const cutoff = view.evictedMembers.get(replicaId);
  return cutoff !== undefined && seq > cutoff;
}

/**
 * EDIT-operation fencing (requirements.md 10.0, mechanism 1). Accept if the author is active, or
 * the author is evicted AND `seq <= cutoff`. Reject an unknown author. This takes no epoch:
 * the `epoch` field of an operation is informational and is never consulted.
 *
 * @param view - The membership view in force
 * @param replicaId - The operation's author (from the Op ID)
 * @param seq - The operation's sequence number (from the Op ID)
 * @returns true if the operation must be rejected
 */
export function isFenced(view: MembershipView, replicaId: string, seq: number): boolean {
  if (view.activeMembers.has(replicaId)) return false;
  const cutoff = view.evictedMembers.get(replicaId);
  return cutoff === undefined || seq > cutoff;
}

/**
 * CONTROL-message fencing (requirements.md 10.0, mechanism 2): acks, views and frontier updates.
 * Reject if the sender is not an active member, or its epoch is lower than the current epoch. A
 * sender with a NEWER epoch is accepted (it knows a later view than this replica). A malformed
 * epoch (NaN, negative, fractional, not a number) is rejected: a failed `<` comparison would
 * otherwise let it through. The reply to a rejected message carries the current epoch.
 *
 * @param view - The membership view in force
 * @param senderId - Who sent the message
 * @param senderEpoch - The epoch the message carries
 * @returns true if the message must be rejected
 */
export function isControlMessageRejected(view: MembershipView, senderId: string, senderEpoch: number): boolean {
  if (!view.activeMembers.has(senderId)) return true;
  if (!isEpoch(senderEpoch)) return true;
  return senderEpoch < view.epoch;
}

// ---------------------------------------------------------------------------
// Serialization (KER-021)
// ---------------------------------------------------------------------------

/**
 * The plain-object form of a view: sorted active members, sorted evicted map, epoch. Use it when
 * a view is embedded in a larger message or snapshot.
 *
 * @param view - The view
 * @returns A JSON-compatible object
 */
export function membershipToJSON(view: MembershipView): MembershipJSON {
  const evictedMembers = Object.create(null) as Record<string, number>;
  for (const id of [...view.evictedMembers.keys()].sort(compareStrings)) {
    evictedMembers[id] = view.evictedMembers.get(id) as number;
  }
  return {
    activeMembers: [...view.activeMembers].sort(compareStrings),
    epoch: view.epoch,
    evictedMembers,
  };
}

/**
 * Rebuild a view from its plain-object form. This is a trust boundary: everything is validated,
 * nothing is silently dropped or repaired.
 *
 * @param value - Parsed JSON (should be a {@link MembershipJSON})
 * @returns A new view
 * @throws TypeError if anything is malformed (wrong types, invalid or repeated IDs, bad cutoff or epoch, a replica both active and evicted)
 */
export function membershipFromJSON(value: unknown): MembershipView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('membership: expected an object');
  }
  const v = value as { activeMembers?: unknown; evictedMembers?: unknown; epoch?: unknown };
  if (!Array.isArray(v.activeMembers)) throw new TypeError('membership: "activeMembers" must be an array');
  if (v.evictedMembers === null || typeof v.evictedMembers !== 'object' || Array.isArray(v.evictedMembers)) {
    throw new TypeError('membership: "evictedMembers" must be an object');
  }

  // Shape and repeated active IDs are checked here (a Set would hide a repeat). The epoch, the
  // cutoffs and the "not both active and evicted" rule are checked once, by the final assertion.
  const activeMembers = new Set<string>();
  for (const id of v.activeMembers) {
    if (!isReplicaIdString(id)) throw new TypeError(`membership: invalid active replica ID ${String(id)}`);
    if (activeMembers.has(id)) throw new TypeError(`membership: repeated active replica ID "${id}"`);
    activeMembers.add(id);
  }
  const evictedMembers = new Map<string, number>();
  for (const [id, cutoff] of Object.entries(v.evictedMembers as Record<string, unknown>)) {
    evictedMembers.set(id, cutoff as number);
  }
  const view = { activeMembers, evictedMembers, epoch: v.epoch };
  assertValidMembershipView(view);
  return view;
}

/**
 * Deterministic JSON for a view (keys and members sorted; see {@link membershipToJSON}).
 * Equal views always give the identical string.
 *
 * @param view - The view
 * @returns Canonical JSON
 */
export function serializeMembership(view: MembershipView): string {
  return stableStringify(membershipToJSON(view));
}

/**
 * Parse and validate a view serialized by {@link serializeMembership}.
 *
 * @param json - The JSON string
 * @returns A new view
 * @throws SyntaxError if the JSON is malformed
 * @throws TypeError if the structure is invalid (see {@link membershipFromJSON})
 */
export function deserializeMembership(json: string): MembershipView {
  return membershipFromJSON(JSON.parse(json) as unknown);
}
