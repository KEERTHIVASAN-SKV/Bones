/**
 * Property: GC SAFETY, including the redacted log (design.md Property 14; requirements.md 12;
 * decision D-A in design.md Algorithm 6). Seeded, 150 runs.
 *
 * Method: replay the SAME generated history on two sets of replicas. Set X runs Stage 1 GC (an
 * honest frontier, computed from every member's version vector, is applied part-way through and
 * again at the end). Set Y never runs GC and is the control. Both then sync fully.
 *   - The visible sequence, the structure (order, anchors, Lamport times, deleted flags), the
 *     version vectors and the log order must be identical in X and Y: GC changes nothing but
 *     payloads of tombstones.
 *   - A replica that replays X's REDACTED log, in any order and with or without help from Y's
 *     full log, ends with the same visible sequence and structure.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CRDT } from '../src/crdt.js';
import type { Operation } from '../src/types.js';
import { estimatePayloadSize } from '../src/utils.js';
import {
  activeView,
  gcAll,
  makeReplicas,
  NAMES,
  runSteps,
  shuffle,
  stepsArb,
  structure,
  syncAll,
  visible,
  vvOf,
} from './support/history.js';

const RUNS = { seed: 12345, numRuns: 150 } as const;
const VIEW = activeView(NAMES);

/**
 * THE safety claim, checked directly (a full-sync comparison cannot see premature reclamation,
 * because an insert and its delete travel together): a payload reclaimed at ANY replica means
 * EVERY member already holds that element AND has it deleted. Then a redacted insert can never
 * reach a replica that would show an element with a missing payload.
 */
function expectReclaimedOnlyWhenEveryoneHasItDeleted(replicas: readonly CRDT<string>[]): void {
  for (const holder of replicas) {
    for (const e of holder.getAllElements()) {
      if (!e.payloadReclaimed) continue;
      for (const member of replicas) expect(member.isElementDeleted(e.id)).toBe(true);
    }
  }
}

/** Run `first` on both sets, GC set X part-way, run `second`, then sync fully. */
function run(first: Parameters<typeof runSteps>[1], second: Parameters<typeof runSteps>[1]) {
  const x = makeReplicas(VIEW);
  const y = makeReplicas(VIEW);
  const createdX: Operation<string>[] = [];
  const createdY: Operation<string>[] = [];
  runSteps(x, first, createdX);
  runSteps(y, first, createdY);
  gcAll(x, 1); // part-way: some replicas are behind, so only what is truly stable is reclaimed
  expectReclaimedOnlyWhenEveryoneHasItDeleted(x);
  runSteps(x, second, createdX, 1000);
  runSteps(y, second, createdY, 1000);
  return { x, y, createdX, createdY };
}

describe('Property: GC safety', () => {
  it('GC never changes the visible sequence, the structure, the version vectors or the log order (mid-run and after a full sync)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x, y } = run(first, second);
        // mid-run: the SAME history, one set with GC and one without
        for (let i = 0; i < NAMES.length; i++) {
          expect(visible(x[i])).toEqual(visible(y[i]));
          expect(structure(x[i])).toEqual(structure(y[i]));
          expect(vvOf(x[i])).toEqual(vvOf(y[i]));
          expect(x[i].getOps().map((o) => o.id)).toEqual(y[i].getOps().map((o) => o.id));
        }
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        for (let i = 0; i < NAMES.length; i++) {
          expect(visible(x[i])).toEqual(visible(y[i]));
          expect(structure(x[i])).toEqual(structure(y[i]));
          expect(vvOf(x[i])).toEqual(vvOf(y[i]));
          expect(x[i].getPendingCount()).toBe(0);
        }
        // and the replicas converge with each other
        for (let i = 1; i < NAMES.length; i++) expect(visible(x[i])).toEqual(visible(x[0]));
      }),
      RUNS
    );
  });

  it('a payload is only ever reclaimed when EVERY member already has the element, deleted (part-way, mid-history and at the end)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), stepsArb(0, 12), (first, second, third) => {
        const { x, createdX } = run(first, second);
        gcAll(x, 1); // mid-history again, with replicas still out of step
        expectReclaimedOnlyWhenEveryoneHasItDeleted(x);
        runSteps(x, third, createdX, 7000);
        gcAll(x, 1);
        expectReclaimedOnlyWhenEveryoneHasItDeleted(x);
        syncAll(x);
        gcAll(x, 1);
        expectReclaimedOnlyWhenEveryoneHasItDeleted(x);
      }),
      RUNS
    );
  });

  it('only deleted elements lose their payload, and live payloads are never touched', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        for (let i = 0; i < NAMES.length; i++) {
          const control = new Map(y[i].getAllElements().map((e) => [e.id, e]));
          for (const e of x[i].getAllElements()) {
            if (e.payloadReclaimed) {
              expect(e.deleted).toBe(true);
              expect(e.value).toBeUndefined();
            }
            if (!e.deleted) expect(e.value).toBe(control.get(e.id)?.value); // live payloads survive
          }
        }
      }),
      RUNS
    );
  });

  it('after a full sync and an honest frontier, EVERY tombstone has lost its payload (reclamation is complete), but none was removed', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        for (let i = 0; i < NAMES.length; i++) {
          const stats = x[i].getGCStats();
          expect(stats.payloadsReclaimed).toBe(stats.tombstoneCount);
          expect(stats.tombstoneCount).toBe(y[i].getAllElements().filter((e) => e.deleted).length);
          expect(x[i].getAllElements()).toHaveLength(y[i].getAllElements().length); // Stage 1 keeps the structure
        }
      }),
      RUNS
    );
  });

  it('the log keeps its length and order, and holds NO payload for a reclaimed element', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        for (let i = 0; i < NAMES.length; i++) {
          const reclaimed = new Set(x[i].getAllElements().filter((e) => e.payloadReclaimed).map((e) => e.id));
          const log = x[i].getOps();
          expect(log).toHaveLength(y[i].getOps().length);
          for (const op of log) {
            if (op.type === 'insert' && reclaimed.has(op.id)) expect(op.value).toBeUndefined();
            if (op.type === 'insert' && !reclaimed.has(op.id)) expect(op.value).toBeDefined();
          }
          // nothing that leaves this replica through opsSince carries a reclaimed payload
          for (const op of x[i].opsSince(new Map())) {
            if (op.type === 'insert' && reclaimed.has(op.id)) expect('value' in op).toBe(false);
          }
        }
      }),
      RUNS
    );
  });

  it('a fresh replica that replays the REDACTED log, in any order, converges to the same visible sequence and structure', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), fc.integer({ min: 1, max: 1_000_000 }), (first, second, seed) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);

        const fresh = new CRDT<string>('fresh.0', VIEW);
        for (const op of shuffle(x[0].opsSince(new Map()), seed)) fresh.applyOp(op);
        expect(fresh.getPendingCount()).toBe(0);
        expect(visible(fresh)).toEqual(visible(y[0]));
        expect(structure(fresh)).toEqual(structure(y[0]));
        expect(vvOf(fresh)).toEqual(vvOf(y[0]));
      }),
      RUNS
    );
  });

  it('a replica fed a random MIX of redacted and full copies of the same operations also converges', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), fc.integer({ min: 1, max: 1_000_000 }), (first, second, seed) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);

        const mixed = new CRDT<string>('mixed.0', VIEW);
        const pool = [...x[0].opsSince(new Map()), ...y[1].opsSince(new Map()), ...x[2].opsSince(new Map())];
        for (const op of shuffle(pool, seed)) mixed.applyOp(op);
        expect(mixed.getPendingCount()).toBe(0);
        expect(visible(mixed)).toEqual(visible(y[0]));
        expect(structure(mixed)).toEqual(structure(y[0]));
      }),
      RUNS
    );
  });

  it('bytesSaved is never more than the payload bytes of the elements that were reclaimed (nothing is counted twice)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x, y } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        gcAll(x, 1); // a second pass with the same frontier must add nothing
        for (let i = 0; i < NAMES.length; i++) {
          const control = new Map(y[i].getAllElements().map((e) => [e.id, e.value]));
          const ceiling = x[i]
            .getAllElements()
            .filter((e) => e.payloadReclaimed)
            .reduce((sum, e) => sum + estimatePayloadSize(control.get(e.id)), 0);
          expect(x[i].getGCStats().bytesSaved).toBeLessThanOrEqual(ceiling);
          expect(x[i].getGCStats().bytesSaved).toBeGreaterThanOrEqual(0);
        }
      }),
      RUNS
    );
  });

  it('GC is idempotent: the same frontier twice leaves every replica exactly as after the first time', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), (first, second) => {
        const { x } = run(first, second);
        syncAll(x);
        gcAll(x, 1);
        const once = x.map((r) => JSON.stringify([r.getAllElements(), r.getOps(), r.getGCStats().bytesSaved]));
        gcAll(x, 1);
        const twice = x.map((r) => JSON.stringify([r.getAllElements(), r.getOps(), r.getGCStats().bytesSaved]));
        expect(twice).toEqual(once);
      }),
      RUNS
    );
  });

  it('local edits after GC still work and still converge (a reclaimed tombstone anchors new inserts)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), stepsArb(1, 15), (first, second, third) => {
        const { x, y, createdX, createdY } = run(first, second);
        syncAll(x);
        syncAll(y);
        gcAll(x, 1);
        runSteps(x, third, createdX, 5000); // kind 1 anchors on ANY element, tombstones included
        runSteps(y, third, createdY, 5000);
        syncAll(x);
        syncAll(y);
        for (let i = 0; i < NAMES.length; i++) {
          expect(visible(x[i])).toEqual(visible(y[i]));
          expect(structure(x[i])).toEqual(structure(y[i]));
          expect(x[i].getPendingCount()).toBe(0);
        }
      }),
      RUNS
    );
  });
});
