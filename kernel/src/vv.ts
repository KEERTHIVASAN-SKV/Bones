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

import type { VersionVector } from './types.js';

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
