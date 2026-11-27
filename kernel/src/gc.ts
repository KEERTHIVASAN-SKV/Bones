/**
 * Stage 1 garbage collection: payload reclamation (KER-023, KER-026; requirements.md section 12;
 * design.md Algorithm 6).
 *
 * Only the PAYLOAD of a deleted element is dropped. The structural node (id, anchor, lamport,
 * deleted flag, children) stays, so a retained anchor still orders its subtree and still accepts
 * concurrent inserts. The tombstone COUNT therefore never goes down; the savings are payload
 * bytes. Stage 2 (removing structure) is not implemented.
 *
 * When it is safe: a payload may go once ANY delete of its element is causally stable, that is,
 * at or below the stable frontier. A stable delete has been applied by every active member, and
 * a delete comes after its insert, so every active member has the element, has it deleted, and
 * will never read its payload again. (This assumes members report their version vectors
 * honestly; requirements.md 11.)
 *
 * This module changes the RGA only. Dropping the payload from the operation log as well
 * (`redactReclaimedPayloads` in oplog.ts) is done by the caller, so the memory is really freed.
 */

import type { GCStats, OpIdKey, VersionVector } from './types.js';
import { markPayloadReclaimed } from './rga.js';
import type { RGAState } from './rga.js';
import { estimatePayloadSize } from './utils.js';
import { isCausallyStable } from './vv.js';

/** What one GC pass did. */
export interface GCResult {
  /** Elements whose payload was reclaimed in this pass, each once. */
  reclaimed: OpIdKey[];
  /** Estimated size of the payloads reclaimed in this pass (see `estimatePayloadSize`). */
  bytesReclaimed: number;
}

/**
 * Reclaim the payload of every deleted element that has a causally stable delete.
 *
 * Idempotent: an element already reclaimed is skipped, so a second pass with the same frontier
 * reclaims nothing and counts no bytes. Bytes are counted once per element, when it is
 * reclaimed. An element that has no payload left (its insert arrived redacted) is still marked
 * reclaimed, for 0 bytes. Also forgets the delete-operation bookkeeping of reclaimed elements
 * (it is never read again), including an entry a late delete re-created.
 *
 * @param rga - RGA state (mutated: values cleared, flags set)
 * @param frontier - The stable frontier (not mutated)
 * @returns The reclaimed element IDs and the estimated bytes freed
 */
export function performStage1GC<T>(rga: RGAState<T>, frontier: VersionVector): GCResult {
  const reclaimed: OpIdKey[] = [];
  let bytesReclaimed = 0;

  for (const element of rga.elements.values()) {
    if (!element.deleted) continue;
    if (element.payloadReclaimed) {
      rga.deleteOps.delete(element.id);
      continue;
    }

    const deletes = rga.deleteOps.get(element.id);
    if (deletes === undefined) continue;
    let stable = false;
    for (const deleteId of deletes) {
      if (isCausallyStable(deleteId, frontier)) {
        stable = true;
        break;
      }
    }
    if (!stable) continue;

    bytesReclaimed += estimatePayloadSize(element.value); // measure BEFORE clearing
    markPayloadReclaimed(rga, element.id);
    rga.deleteOps.delete(element.id);
    reclaimed.push(element.id);
  }

  return { reclaimed, bytesReclaimed };
}

/**
 * Statistics for the Graveyard panel (KER-026).
 *
 * `bytesSaved` and `replicasEvicted` are tracked by the caller (they are cumulative or come from
 * membership); the tombstone and reclaimed counts are read from the RGA now.
 *
 * @param rga - RGA state (not mutated)
 * @param bytesSaved - Cumulative estimated payload bytes freed so far
 * @param replicasEvicted - Number of evicted replicas
 * @param frontier - The stable frontier to report (copied)
 * @returns A new GCStats
 */
export function buildGCStats<T>(
  rga: RGAState<T>,
  bytesSaved: number,
  replicasEvicted: number,
  frontier: VersionVector
): GCStats {
  let tombstoneCount = 0;
  let payloadsReclaimed = 0;
  for (const element of rga.elements.values()) {
    if (!element.deleted) continue;
    tombstoneCount++;
    if (element.payloadReclaimed) payloadsReclaimed++;
  }
  return { tombstoneCount, payloadsReclaimed, bytesSaved, replicasEvicted, stableFrontier: new Map(frontier) };
}
