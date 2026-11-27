/**
 * Version-vector operations that are not already in utils.ts (KER-013, stable frontier).
 *
 * utils.ts provides clone, merge, update, compare and (de)serialize. This module adds only:
 * - advanceContiguous: the contiguous-prefix rule (design.md Algorithm 4)
 * - stableFrontier: the component-wise minimum used for causal stability (design.md Algorithm 5)
 *
 * A version vector maps replicaId -> the highest CONTIGUOUS applied sequence number from that
 * replica. A missing entry means 0. All functions here return new objects and never mutate
 * their inputs.
 */

import type { OpIdKey, VersionVector } from './types.js';
import { isValidReplicaId, isValidSequence, parseOpId } from './utils.js';

/**
 * Advance one replica's entry by exactly one, or leave the vector untouched.
 *
 * Advances only when `seq === VV[replicaId] + 1` (a missing entry counts as 0). Otherwise the
 * SAME vector object is returned:
 * - `seq > VV[replicaId] + 1`: a gap, an earlier op is still missing, so it must not skip ahead.
 * - `seq <= VV[replicaId]`: already counted, so it must never move the entry backwards.
 *
 * The orchestrator calls this for EVERY applied operation, including no-ops (an operation that
 * changed no state is still applied), and never for operations that are only buffered.
 * Do not use `updateVersionVector` (max-based, no contiguity check) for this.
 *
 * @param vv - Current version vector (not mutated)
 * @param replicaId - Author of the operation that was just applied
 * @param seq - Sequence number of that operation
 * @returns A new vector with the entry advanced, or `vv` itself if it must not move
 */
export function advanceContiguous(vv: VersionVector, replicaId: string, seq: number): VersionVector {
  const current = vv.get(replicaId) ?? 0;
  if (seq !== current + 1) return vv;
  const next = new Map(vv);
  next.set(replicaId, seq);
  return next;
}

/**
 * What a remote peer is missing, given what this side has applied.
 *
 * For every replica where `local` is ahead of `remote` (a missing entry counts as 0) it returns
 * the inclusive range of sequence numbers the remote lacks: `{ from: remote + 1, to: local }`.
 * Replicas where the remote is level with or ahead of `local` are omitted. Because a version
 * vector is a contiguous prefix, these ranges are exactly the missing operations.
 *
 * The result is directional: `computeVVDifference(a, b)` is what B lacks, and
 * `computeVVDifference(b, a)` is what A lacks. Keys are listed in code-unit order, so the output
 * is deterministic. Neither input is modified.
 *
 * @param local - The version vector of the side that has the operations
 * @param remote - The version vector of the side that may be missing some
 * @returns replicaId -> inclusive missing range
 */
export function computeVVDifference(
  local: VersionVector,
  remote: VersionVector
): Map<string, { from: number; to: number }> {
  const difference = new Map<string, { from: number; to: number }>();
  const replicaIds = [...local.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const replicaId of replicaIds) {
    const have = local.get(replicaId) as number;
    const lacks = remote.get(replicaId) ?? 0;
    if (have > lacks) difference.set(replicaId, { from: lacks + 1, to: have });
  }
  return difference;
}

/**
 * Stable frontier: the component-wise minimum of the given version vectors, where a replica
 * missing from a vector counts as 0. Entries that come out as 0 are omitted (absent = 0).
 *
 * SAFETY: pass exactly one vector per ACTIVE member, using an empty Map for a member that has
 * not acknowledged yet. Leaving such a member out would overstate the frontier and could
 * authorize reclaiming a payload that member still needs. Evicted members must not be passed
 * (requirements.md 11.6). With no vectors at all, nothing is stable: the result is empty.
 *
 * @param vvs - One acknowledged version vector per active member (not mutated)
 * @returns A new vector: for each replica, the smallest applied sequence over all members
 */
export function stableFrontier(vvs: readonly VersionVector[]): VersionVector {
  const frontier: VersionVector = new Map();
  if (vvs.length === 0) return frontier;

  const replicaIds = new Set<string>();
  for (const vv of vvs) for (const id of vv.keys()) replicaIds.add(id);

  for (const id of replicaIds) {
    let min = Number.POSITIVE_INFINITY;
    for (const vv of vvs) min = Math.min(min, vv.get(id) ?? 0);
    if (min > 0) frontier.set(id, min);
  }
  return frontier;
}

/**
 * The stable frontier from the version vectors that members acknowledged (design.md Algorithm 5;
 * requirements.md 11.1 to 11.6; KER-024).
 *
 * Only ACTIVE members count, and every active member counts: one that has not acknowledged yet
 * contributes an empty vector (it has applied nothing as far as anyone knows), so it holds the
 * frontier back instead of being skipped. The acks of members that are not active (evicted, or
 * strangers) are ignored, so an evicted member stops holding the frontier back immediately and
 * a stranger cannot raise it. With no active members nothing is stable.
 *
 * The result is the minimum at THIS moment. The frontier must never move backwards: the caller
 * (the coordinator, or `CRDT.updateStableFrontier`) keeps the largest value it has seen.
 *
 * @param acks - Latest acknowledged version vector per replica ID (not mutated)
 * @param activeMembers - The members of the current membership view (not mutated)
 * @returns A new vector (entries that come out as 0 are omitted)
 */
export function computeStableFrontier(
  acks: ReadonlyMap<string, VersionVector>,
  activeMembers: ReadonlySet<string>
): VersionVector {
  const vvs: VersionVector[] = [];
  for (const member of activeMembers) vvs.push(acks.get(member) ?? new Map());
  return stableFrontier(vvs);
}

/**
 * Whether an operation is causally stable: every active member has applied it, because its
 * sequence number is at or below the frontier entry for its author (KER-025). The check is by
 * author and sequence number, never by comparing Op ID strings (`"a:10" < "a:9"` as text).
 *
 * A malformed Op ID (no colon, non-canonical or non-positive sequence number, invalid replica
 * ID) is never stable.
 *
 * @param opId - The operation's ID
 * @param frontier - The stable frontier (not mutated)
 * @returns true if `opId` is at or below the frontier
 */
export function isCausallyStable(opId: OpIdKey, frontier: VersionVector): boolean {
  const parsed = parseOpId(opId);
  if (parsed === null || !isValidSequence(parsed.seq) || !isValidReplicaId(parsed.replicaId)) return false;
  return (frontier.get(parsed.replicaId) ?? 0) >= parsed.seq;
}
