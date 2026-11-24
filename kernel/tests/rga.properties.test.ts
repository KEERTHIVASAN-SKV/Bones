/**
 * RGA property tests (KER-009; Property 1 and requirements.md 1.8, 4).
 * Seeded, >= 100 runs each. Generators deliberately build DEEP anchor chains with
 * concurrent siblings at several levels and inserts into the middle of sequences.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import {
  createRGA,
  applyInsert,
  applyDelete,
  compareSiblingKeys,
  getSequence,
  traverse,
} from '../src/rga.js';
import type { RGAState } from '../src/rga.js';

const RUNS = { seed: 12345, numRuns: 200 } as const;
const REPLICAS = ['r1', 'r2', 'r3'] as const;

interface Spec {
  replica: number; // index into REPLICAS
  anchorPick: number; // chooses the anchor among earlier ops
}

const specArb = fc.record({
  replica: fc.integer({ min: 0, max: REPLICAS.length - 1 }),
  anchorPick: fc.integer({ min: 0, max: 10_000 }),
});

/**
 * Turn specs into a valid causal set of insert ops: each op's lamport exceeds its anchor's
 * and its replica's previous lamport, and seqs are 1, 2, 3, ... per replica.
 * Anchor choice is biased toward the most recent op so deep chains are common.
 */
function buildOps(specs: Spec[]): Operation<string>[] {
  const ops: Operation<string>[] = [];
  const clock = new Map<string, number>();
  const seq = new Map<string, number>();
  specs.forEach((spec, i) => {
    const replicaId = REPLICAS[spec.replica];
    let anchorIndex: number; // -1 = HEAD
    if (i === 0) anchorIndex = -1;
    else if (spec.anchorPick % 3 === 0) anchorIndex = i - 1; // chain
    else anchorIndex = (spec.anchorPick % (i + 1)) - 1; // anywhere, including HEAD
    const anchor = anchorIndex >= 0 ? ops[anchorIndex].id : undefined;
    const anchorLamport = anchorIndex >= 0 ? ops[anchorIndex].lamport : 0;
    const lamport = Math.max(clock.get(replicaId) ?? 0, anchorLamport) + 1;
    clock.set(replicaId, lamport);
    const nextSeq = (seq.get(replicaId) ?? 0) + 1;
    seq.set(replicaId, nextSeq);
    ops.push({ id: createOpId(replicaId, nextSeq), type: 'insert', anchor, value: `v${i}`, lamport, replicaId });
  });
  return ops;
}

/** A random order in which every op comes after its anchor (what the orchestrator guarantees). */
function causalOrder(ops: Operation<string>[], choices: number[]): Operation<string>[] {
  const applied = new Set<OpIdKey>();
  const remaining = [...ops];
  const out: Operation<string>[] = [];
  let step = 0;
  while (remaining.length > 0) {
    const ready = remaining.filter((op) => op.anchor === undefined || applied.has(op.anchor));
    const pick = ready[choices[step % choices.length] % ready.length];
    step++;
    remaining.splice(remaining.indexOf(pick), 1);
    applied.add(pick.id);
    out.push(pick);
  }
  return out;
}

function build(order: Operation<string>[]): RGAState<string> {
  const rga = createRGA<string>();
  for (const op of order) applyInsert(rga, op);
  return rga;
}

const ids = (rga: RGAState<string>): OpIdKey[] => traverse(rga).map((e) => e.id);

function descendantCount(rga: RGAState<string>, id: OpIdKey): number {
  let count = 0;
  const stack = [id];
  while (stack.length > 0) {
    for (const child of rga.children.get(stack.pop()!) ?? []) {
      count++;
      stack.push(child);
    }
  }
  return count;
}

const specsArb = fc.array(specArb, { minLength: 1, maxLength: 40 });
const choicesArb = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 60 });

describe('RGA properties', () => {
  it('converges: any causal delivery order gives the identical sequence', () => {
    fc.assert(
      fc.property(specsArb, choicesArb, choicesArb, (specs, c1, c2) => {
        const ops = buildOps(specs);
        const a = build(causalOrder(ops, c1));
        const b = build(causalOrder(ops, c2));
        expect(ids(a)).toEqual(ids(b));
        expect(ids(a)).toHaveLength(ops.length);
      }),
      RUNS
    );
  });

  it('is idempotent: re-applying every op in a shuffled order changes nothing', () => {
    fc.assert(
      fc.property(specsArb, choicesArb, (specs, choices) => {
        const ops = buildOps(specs);
        const rga = build(causalOrder(ops, choices));
        const before = ids(rga);
        for (const op of ops) expect(applyInsert(rga, op)).toBe(false);
        expect(ids(rga)).toEqual(before);
      }),
      RUNS
    );
  });

  it('keeps every element subtree contiguous at any depth', () => {
    fc.assert(
      fc.property(specsArb, choicesArb, (specs, choices) => {
        const rga = build(causalOrder(buildOps(specs), choices));
        const order = ids(rga);
        order.forEach((id, i) => {
          const span = descendantCount(rga, id);
          const subtree = new Set<OpIdKey>([id]);
          const stack = [id];
          while (stack.length > 0) {
            for (const child of rga.children.get(stack.pop()!) ?? []) {
              subtree.add(child);
              stack.push(child);
            }
          }
          // the `span` elements right after `id` are exactly its descendants
          for (let k = 1; k <= span; k++) expect(subtree.has(order[i + k])).toBe(true);
        });
      }),
      RUNS
    );
  });

  it('keeps every child list sorted newest first and every child newer than its parent in lamport', () => {
    fc.assert(
      fc.property(specsArb, choicesArb, (specs, choices) => {
        const rga = build(causalOrder(buildOps(specs), choices));
        for (const [parent, kids] of rga.children) {
          for (let i = 1; i < kids.length; i++) {
            const newer = rga.elements.get(kids[i - 1])!;
            const older = rga.elements.get(kids[i])!;
            expect(compareSiblingKeys(newer, older)).toBeGreaterThan(0);
          }
          if (parent !== 'HEAD') {
            for (const kid of kids) {
              expect(rga.elements.get(kid)!.lamport).toBeGreaterThan(rga.elements.get(parent)!.lamport);
            }
          }
        }
      }),
      RUNS
    );
  });

  it('a delete never changes the structural order, only visibility', () => {
    fc.assert(
      fc.property(specsArb, choicesArb, fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 10 }), (specs, choices, picks) => {
        const ops = buildOps(specs);
        const rga = build(causalOrder(ops, choices));
        const structure = ids(rga);
        picks.forEach((pick, i) => {
          const target = ops[pick % ops.length].id;
          applyDelete(rga, {
            id: createOpId('d', i + 1),
            type: 'delete',
            target,
            lamport: 10_000 + i,
            replicaId: 'd',
          });
        });
        expect(ids(rga)).toEqual(structure);
        const visible = getSequence(rga).map((e) => e.id);
        expect(visible).toEqual(structure.filter((id) => !rga.elements.get(id)!.deleted));
      }),
      RUNS
    );
  });

  it('a local insert at visible index k lands at visible index k (requirements.md 1.8)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 60 }), (picks) => {
        const rga = createRGA<string>();
        const model: string[] = [];
        const idByValue = new Map<string, OpIdKey>();
        let clock = 0;
        picks.forEach((pick, i) => {
          const k = pick % (model.length + 1); // insert so the new item ends up at index k
          const anchor = k === 0 ? undefined : idByValue.get(model[k - 1]);
          clock += 1;
          const op: Operation<string> = {
            id: createOpId('r1', i + 1),
            type: 'insert',
            anchor,
            value: `v${i}`,
            lamport: clock,
            replicaId: 'r1',
          };
          applyInsert(rga, op);
          idByValue.set(`v${i}`, op.id);
          model.splice(k, 0, `v${i}`);
          expect(getSequence(rga).map((e) => e.value)).toEqual(model);
        });
      }),
      RUNS
    );
  });
});
