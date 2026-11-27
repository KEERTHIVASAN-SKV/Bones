/**
 * Property: FRONTIER SAFETY (design.md Properties 12 and 13; requirements.md 11).
 * Whatever the history, an operation at or below the stable frontier has been applied by EVERY
 * active member, a member that has not acknowledged holds the frontier back, and the frontier
 * never moves backwards. Seeded, 150 runs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { Operation } from '../src/types.js';
import { createOpId, parseOpId } from '../src/utils.js';
import { computeStableFrontier, isCausallyStable } from '../src/vv.js';
import { activeView, frontierOf, makeReplicas, NAMES, runSteps, stepsArb } from './support/history.js';

const RUNS = { seed: 12345, numRuns: 150 } as const;

describe('Property: frontier safety', () => {
  it('every operation at or below the frontier is already applied by every active member', () => {
    fc.assert(
      fc.property(stepsArb(1, 45), (steps) => {
        const replicas = makeReplicas(activeView(NAMES));
        const created: Operation<string>[] = [];
        runSteps(replicas, steps, created);

        const frontier = frontierOf(replicas);
        const applied = replicas.map((r) => new Set(r.getOps().map((o) => o.id)));
        for (const op of created) {
          if (!isCausallyStable(op.id, frontier)) continue;
          for (const ids of applied) expect(ids.has(op.id)).toBe(true);
        }
        // the same fact on the version vectors: frontier <= every member's VV, component-wise
        for (const r of replicas) {
          for (const [id, seq] of frontier) expect(r.getVV().get(id) ?? 0).toBeGreaterThanOrEqual(seq);
        }
      }),
      RUNS
    );
  });

  it('stability is closed under causality: every causal predecessor of a stable operation is stable too', () => {
    fc.assert(
      fc.property(stepsArb(1, 45), (steps) => {
        const replicas = makeReplicas(activeView(NAMES));
        const created: Operation<string>[] = [];
        runSteps(replicas, steps, created);
        const frontier = frontierOf(replicas);

        for (const op of created) {
          if (!isCausallyStable(op.id, frontier)) continue;
          // the element this operation hangs off (an insert's anchor, a delete's target)
          const dependency = op.type === 'insert' ? op.anchor : op.target;
          if (dependency !== undefined) expect(isCausallyStable(dependency, frontier)).toBe(true);
          // every earlier operation of the same author
          const parsed = parseOpId(op.id) as { replicaId: string; seq: number };
          for (let seq = 1; seq < parsed.seq; seq++) {
            expect(isCausallyStable(createOpId(parsed.replicaId, seq), frontier)).toBe(true);
          }
        }
      }),
      RUNS
    );
  });

  it('the frontier is exactly the component-wise minimum (nothing less is claimed, nothing more is safe)', () => {
    fc.assert(
      fc.property(stepsArb(1, 45), (steps) => {
        const replicas = makeReplicas(activeView(NAMES));
        runSteps(replicas, steps, []);
        const frontier = frontierOf(replicas);
        const authors = new Set(replicas.flatMap((r) => [...r.getVV().keys()]));
        for (const id of authors) {
          const min = Math.min(...replicas.map((r) => r.getVV().get(id) ?? 0));
          expect(frontier.get(id) ?? 0).toBe(min);
        }
      }),
      RUNS
    );
  });

  it('a member that has not acknowledged holds the whole frontier back (nothing is stable)', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), (steps) => {
        const replicas = makeReplicas(activeView(NAMES));
        runSteps(replicas, steps, []);
        const acks = new Map(replicas.map((r) => [r.replicaId, r.getVV()]));
        const withGhost = computeStableFrontier(acks, new Set([...NAMES, 'ghost.0']));
        expect(withGhost.size).toBe(0);
      }),
      RUNS
    );
  });

  it('removing a member from the active set can only raise the frontier (eviction frees it, never blocks it)', () => {
    fc.assert(
      fc.property(stepsArb(1, 45), fc.integer({ min: 0, max: 2 }), (steps, leaver) => {
        const replicas = makeReplicas(activeView(NAMES));
        runSteps(replicas, steps, []);
        const all = frontierOf(replicas);
        const survivors = NAMES.filter((_, i) => i !== leaver);
        const without = frontierOf(replicas, survivors);
        for (const [id, seq] of all) expect(without.get(id) ?? 0).toBeGreaterThanOrEqual(seq);
      }),
      RUNS
    );
  });

  it('the frontier never moves backwards as history grows, and a replica keeps the largest it was told', () => {
    fc.assert(
      fc.property(stepsArb(1, 30), stepsArb(1, 30), (first, second) => {
        const replicas = makeReplicas(activeView(NAMES));
        runSteps(replicas, first, []);
        const early = frontierOf(replicas);
        runSteps(replicas, second, [], 1000);
        const late = frontierOf(replicas);
        for (const [id, seq] of early) expect(late.get(id) ?? 0).toBeGreaterThanOrEqual(seq); // VVs only grow

        const probe = replicas[0];
        probe.updateStableFrontier(late, 1);
        probe.updateStableFrontier(early, 1); // an older frontier arrives late
        const held = probe.getStableFrontier();
        for (const [id, seq] of late) expect(held.get(id) ?? 0).toBeGreaterThanOrEqual(seq);
        for (const [id, seq] of early) expect(held.get(id) ?? 0).toBeGreaterThanOrEqual(seq);
      }),
      RUNS
    );
  });
});
