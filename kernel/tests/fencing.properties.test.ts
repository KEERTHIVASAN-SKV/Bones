/**
 * Property: FENCING (design.md Property 11; requirements.md 10). Seeded, 150 runs.
 *
 * Scenario: three replicas edit and sync partially; r3.0 is exorcised. The coordinator takes the
 * cutoff as the MAX of the survivors' contiguous applied seq for r3.0, publishes a view with
 * epoch + 1, and the survivors reconcile (backfill r3.0's operations up to the cutoff from each
 * other). Then everything r3.0 ever wrote (including what it writes while stalled) is delivered
 * to the survivors in a random order with duplicates.
 *   - an operation with seq <= cutoff is never refused for fencing (it is applied or a duplicate)
 *   - an operation with seq > cutoff is always refused ("fenced") and changes NOTHING
 *   - the survivors converge, and their version vector for r3.0 is exactly the cutoff
 *   - the fenced operations are never buffered, so nothing stays pending
 *   - the frontier over the survivors moves, and every tombstone can then be reclaimed
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CRDT } from '../src/crdt.js';
import type { Operation } from '../src/types.js';
import { parseOpId } from '../src/utils.js';
import { applyMembershipView, removeReplica } from '../src/membership.js';
import {
  activeView,
  fingerprint,
  frontierOf,
  makeReplicas,
  NAMES,
  runSteps,
  shuffle,
  stepsArb,
  structure,
  syncAll,
  visible,
} from './support/history.js';

const RUNS = { seed: 12345, numRuns: 150 } as const;
const VICTIM = NAMES[2];
const SURVIVORS = [NAMES[0], NAMES[1]];

const seqOf = (op: Operation<string>): number => (parseOpId(op.id) as { seq: number }).seq;

/**
 * Build the scenario. `leaked` = operations of r3.0 that reached the survivors BEFORE the
 * eviction (some of them buffered behind a gap). Returns everything the tests need.
 */
function evict(first: Parameters<typeof runSteps>[1], leakSeed: number, stalled: Parameters<typeof runSteps>[1]) {
  const replicas = makeReplicas(activeView(NAMES));
  const [r1, r2, r3] = replicas;
  const created: Operation<string>[] = [];
  runSteps(replicas, first, created);

  // some of r3's operations reach the survivors before the eviction, in random order (gaps buffer)
  const victimOps = r3.getOps().filter((o) => o.replicaId === VICTIM);
  const leaked = shuffle(victimOps, leakSeed).slice(0, leakSeed % (victimOps.length + 1));
  for (const op of leaked) {
    r1.applyOp(op);
    if (leakSeed % 2 === 0) r2.applyOp(op);
  }

  // prepare: each survivor replies with its CONTIGUOUS applied seq for the victim; cutoff = max
  const cutoff = Math.max(r1.getVV().get(VICTIM) ?? 0, r2.getVV().get(VICTIM) ?? 0);
  const view1 = r1.getMembershipView();
  const published = removeReplica(activeView(NAMES, view1.epoch), VICTIM, cutoff);

  expect(applyMembershipView(activeView(NAMES, view1.epoch), published).applied).toBe(true);
  expect(r1.updateMembership(published)).toBe(true);
  expect(r2.updateMembership(published)).toBe(true);
  syncAll([r1, r2]); // reconcile: backfill the victim's operations up to the cutoff from each other

  // the stalled victim keeps writing
  runSteps([r1, r2, r3], stalled.map((s) => ({ ...s, replica: 2, kind: s.kind % 3 })), created, 2000);
  const victimAll = r3.getOps().filter((o) => o.replicaId === VICTIM);
  return { r1, r2, r3, cutoff, published, victimAll, created };
}

describe('Property: fencing by author + cutoff', () => {
  it('operations of the evicted author up to the cutoff are accepted, beyond it always fenced, and fenced ones change nothing', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), fc.integer({ min: 0, max: 1_000_000 }), stepsArb(0, 15), fc.integer({ min: 1, max: 1_000_000 }), (first, leakSeed, stalled, shuffleSeed) => {
        const { r1, r2, cutoff, victimAll } = evict(first, leakSeed, stalled);
        const survivors = [r1, r2];
        // everything the victim ever wrote, duplicated and shuffled
        const delivery = shuffle([...victimAll, ...victimAll], shuffleSeed);

        for (const survivor of survivors) {
          for (const op of delivery) {
            const before = fingerprint(survivor);
            const status = survivor.applyOp(op).status;
            if (seqOf(op) > cutoff) {
              expect(status).toBe('fenced');
              expect(fingerprint(survivor)).toBe(before); // a fenced operation changes NOTHING
            } else {
              expect(status).not.toBe('fenced'); // within the cutoff: applied earlier, so a duplicate now
              expect(status).toBe('duplicate');
            }
          }
        }
      }),
      RUNS
    );
  });

  it('the survivors converge and hold exactly the victim\'s operations up to the cutoff, with nothing left pending', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), fc.integer({ min: 0, max: 1_000_000 }), stepsArb(0, 15), fc.integer({ min: 1, max: 1_000_000 }), (first, leakSeed, stalled, shuffleSeed) => {
        const { r1, r2, cutoff, victimAll } = evict(first, leakSeed, stalled);
        for (const op of shuffle(victimAll, shuffleSeed)) {
          r1.applyOp(op);
          r2.applyOp(op);
        }
        syncAll([r1, r2]);
        expect(visible(r1)).toEqual(visible(r2));
        expect(structure(r1)).toEqual(structure(r2));
        for (const survivor of [r1, r2]) {
          expect(survivor.getVV().get(VICTIM) ?? 0).toBe(cutoff);
          expect(survivor.getPendingCount()).toBe(0);
          const applied = survivor.getOps().filter((o) => o.replicaId === VICTIM).map(seqOf);
          expect(applied).toEqual(Array.from({ length: cutoff }, (_, i) => i + 1)); // exactly 1..cutoff, in order
        }
      }),
      RUNS
    );
  });

  it('operations from an UNKNOWN author are always fenced, whatever their seq or epoch, and change nothing', () => {
    fc.assert(
      fc.property(
        stepsArb(1, 30),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (first, leakSeed, count, epoch, shuffleSeed) => {
          const { r1, r2 } = evict(first, leakSeed, []);
          const stranger = new CRDT<string>('stranger.0', activeView([...NAMES, 'stranger.0']));
          const written: Operation<string>[] = [];
          for (let i = 0; i < count; i++) written.push(stranger.insert(written[i - 1]?.id, `s${i}`));
          for (const survivor of [r1, r2]) {
            const before = fingerprint(survivor);
            for (const op of shuffle([...written, ...written], shuffleSeed)) {
              expect(survivor.applyOp({ ...op, epoch }).status).toBe('fenced');
            }
            expect(fingerprint(survivor)).toBe(before);
            expect(survivor.getVV().has('stranger.0')).toBe(false);
          }
        }
      ),
      RUNS
    );
  });

  it('an operation is judged by its author and seq only: its epoch field changes nothing', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 50 }), (first, leakSeed, epoch) => {
        const { r1, cutoff, victimAll } = evict(first, leakSeed, []);
        for (const op of victimAll) {
          const status = r1.applyOp({ ...op, epoch }).status;
          expect(status === 'fenced').toBe(seqOf(op) > cutoff);
        }
      }),
      RUNS
    );
  });

  it('a view installed while operations wait in the buffer purges exactly those beyond the cutoff, and keeps those inside it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 14 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (n, subsetSeed, extra, shuffleSeed) => {
          const view = activeView(NAMES);
          const victim = new CRDT<string>(VICTIM, view);
          const ops: Operation<string>[] = [];
          for (let i = 1; i <= n; i++) ops.push(victim.insert(ops[i - 2]?.id, `s${i}`));
          const seqs = (list: readonly Operation<string>[]): number[] => list.map(seqOf);

          const survivor = new CRDT<string>(NAMES[0], view);
          const delivered = shuffle(ops, subsetSeed).slice(0, subsetSeed % (n + 1));
          for (const op of delivered) survivor.applyOp(op);
          const applied = survivor.getVV().get(VICTIM) ?? 0;
          const waiting = seqs(delivered).filter((s) => s > applied);
          expect(survivor.getPendingCount()).toBe(waiting.length); // exactly the ones behind a gap

          // a cutoff at or above what this survivor holds (another survivor may be ahead of it)
          const cutoff = Math.min(n, applied + extra);
          expect(survivor.updateMembership(removeReplica(view, VICTIM, cutoff))).toBe(true);
          expect(survivor.getPendingCount()).toBe(waiting.filter((s) => s <= cutoff).length);

          // backfill up to the cutoff unblocks what was kept; the rest of the victim's log is fenced
          for (const op of shuffle(ops, shuffleSeed)) {
            const status = survivor.applyOp(op).status;
            expect(status === 'fenced').toBe(seqOf(op) > cutoff);
          }
          expect(survivor.getPendingCount()).toBe(0);
          expect(survivor.getVV().get(VICTIM) ?? 0).toBe(cutoff);
        }
      ),
      RUNS
    );
  });
  it('after the eviction the frontier over the survivors moves, and every tombstone can then be reclaimed (liveness)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), fc.integer({ min: 0, max: 1_000_000 }), (first, leakSeed) => {
        const { r1, r2, r3, published } = evict(first, leakSeed, []);
        const before = r1.getMembershipView().epoch;
        expect(before).toBe(published.epoch);

        // epoch-1 frontier computed while r3 still counted: refused now that the epoch has moved on
        const stale = frontierOf([r1, r2, r3]);
        expect(r1.updateStableFrontier(stale, published.epoch - 1)).toBe(false);

        // the survivors' frontier, for the new epoch
        const frontier = frontierOf([r1, r2], SURVIVORS);
        for (const survivor of [r1, r2]) expect(survivor.updateStableFrontier(frontier, published.epoch)).toBe(true);
        for (const survivor of [r1, r2]) {
          const stats = survivor.getGCStats();
          expect(stats.payloadsReclaimed).toBe(stats.tombstoneCount);
          expect(stats.replicasEvicted).toBe(1);
        }
      }),
      RUNS
    );
  });
});
