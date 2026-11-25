/**
 * CRDT property tests (Wednesday plan; Properties 1, 6, 7, 8 and requirements.md 1.8).
 * Seeded, 150 runs each. Histories come from three replicas that edit concurrently and sync
 * only partially, so they contain nested anchors, mid-sequence inserts, concurrent edits and
 * concurrent duplicate deletes (no-ops).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CRDT } from '../src/crdt.js';
import type { OpIdKey, Operation } from '../src/types.js';
import { parseOpId } from '../src/utils.js';

const RUNS = { seed: 12345, numRuns: 150 } as const;
const NAMES = ['r1', 'r2', 'r3'] as const;

/** Small deterministic PRNG so a fast-check integer drives a whole shuffle. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface Step {
  replica: number;
  kind: number; // 0,1 insert; 2 delete; 3 partial sync
  pick: number;
  seed: number;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  replica: fc.integer({ min: 0, max: 2 }),
  kind: fc.integer({ min: 0, max: 3 }),
  pick: fc.integer({ min: 0, max: 100_000 }),
  seed: fc.integer({ min: 1, max: 1_000_000 }),
});
const stepsArb = fc.array(stepArb, { minLength: 1, maxLength: 40 });

/** Run a concurrent history; returns every operation that was ever created. */
function runHistory(steps: Step[]): Operation<string>[] {
  const replicas = NAMES.map((n) => new CRDT<string>(n));
  const all: Operation<string>[] = [];
  steps.forEach((s, i) => {
    const r = replicas[s.replica];
    if (s.kind <= 1) {
      const visible = r.getSequence();
      const k = s.pick % (visible.length + 1);
      all.push(r.insert(k === 0 ? undefined : visible[k - 1].id, `v${i}`));
    } else if (s.kind === 2) {
      // any known element, including tombstones: this produces concurrent duplicate deletes
      const pool = r.getOps().filter((o) => o.type === 'insert').map((o) => o.id);
      if (pool.length > 0) all.push(r.delete(pool[s.pick % pool.length]));
    } else {
      const target = replicas[s.pick % replicas.length];
      const batch = shuffle(all, s.seed).slice(0, s.pick % (all.length + 1));
      for (const op of batch) target.applyOp(op);
    }
  });
  return all;
}

function deliver(c: CRDT<string>, ops: readonly Operation<string>[]): void {
  for (const op of ops) c.applyOp(op);
}

/** Everything observable about a replica: visible order, tombstones, VV, buffer. */
function view(c: CRDT<string>, ops: readonly Operation<string>[]): string {
  const insertIds = ops.filter((o) => o.type === 'insert').map((o) => o.id).sort();
  return JSON.stringify({
    visible: c.getSequence().map((e) => [e.id, e.value]),
    deleted: insertIds.map((id) => [id, c.isElementDeleted(id)]),
    vv: [...c.getVV().entries()].sort(),
    pending: c.getPendingCount(),
  });
}

describe('CRDT properties', () => {
  it('converges: any shuffle, with duplicates, of the same operations gives identical replicas (Property 1, 7, 8)', () => {
    fc.assert(
      fc.property(stepsArb, fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 3, maxLength: 3 }), (steps, seeds) => {
        const ops = runHistory(steps);
        const views = seeds.map((seed) => {
          const fresh = new CRDT<string>('fresh');
          const withDuplicates = [...ops, ...ops.filter((_, i) => (seed + i) % 3 === 0)];
          deliver(fresh, shuffle(withDuplicates, seed));
          return view(fresh, ops);
        });
        expect(views[1]).toBe(views[0]);
        expect(views[2]).toBe(views[0]);
        expect(JSON.parse(views[0]).pending).toBe(0); // nothing is ever stuck once everything arrived
      }),
      RUNS
    );
  });

  it('every replica that received everything agrees with the fresh ones, including the original authors', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 1, max: 1_000_000 }), (steps, seed) => {
        const replicas = NAMES.map((n) => new CRDT<string>(n));
        const all: Operation<string>[] = [];
        steps.forEach((s, i) => {
          const r = replicas[s.replica];
          if (s.kind <= 1) {
            const visible = r.getSequence();
            const k = s.pick % (visible.length + 1);
            all.push(r.insert(k === 0 ? undefined : visible[k - 1].id, `v${i}`));
          } else if (s.kind === 2) {
            const pool = r.getOps().filter((o) => o.type === 'insert').map((o) => o.id);
            if (pool.length > 0) all.push(r.delete(pool[s.pick % pool.length]));
          } else {
            const batch = shuffle(all, s.seed).slice(0, s.pick % (all.length + 1));
            for (const op of batch) replicas[s.pick % replicas.length].applyOp(op);
          }
        });
        // now give each original replica everything, each in its own random order
        replicas.forEach((r, i) => deliver(r, shuffle(all, seed + i)));
        const reference = new CRDT<string>('ref');
        deliver(reference, all);
        // the reference applied in creation order: a different order from every replica above
        for (const r of replicas) expect(view(r, all)).toBe(view(reference, all));
      }),
      RUNS
    );
  });

  it('is idempotent: delivering every operation again changes nothing and emits no event', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 1, max: 1_000_000 }), (steps, seed) => {
        const ops = runHistory(steps);
        const c = new CRDT<string>('fresh');
        deliver(c, shuffle(ops, seed));
        const before = view(c, ops);
        const logBefore = c.getOps().length;
        let events = 0;
        c.on('sequenceChanged', () => events++);
        for (const op of shuffle(ops, seed + 1)) expect(c.applyOp(op).status).toBe('duplicate');
        expect(view(c, ops)).toBe(before);
        expect(c.getOps().length).toBe(logBefore);
        expect(events).toBe(0);
      }),
      RUNS
    );
  });

  it('the log holds each operation exactly once, in a valid causal order (replays to the same state)', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 1, max: 1_000_000 }), (steps, seed) => {
        const ops = runHistory(steps);
        const c = new CRDT<string>('fresh');
        deliver(c, shuffle([...ops, ...ops], seed));
        const log = c.getOps();
        expect(log).toHaveLength(ops.length);
        expect(new Set(log.map((o) => o.id)).size).toBe(ops.length);
        // feeding the log (in log order) to another replica never needs the buffer
        const replayed = new CRDT<string>('replayed');
        for (const op of log) expect(replayed.applyOp(op).status).toBe('applied');
        expect(view(replayed, ops)).toBe(view(c, ops));
      }),
      RUNS
    );
  });

  it('VV contiguity: never skips, never regresses, equals the applied prefix; buffered ops never advance it (Property 6)', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 1, max: 1_000_000 }), (steps, seed) => {
        const ops = runHistory(steps);
        const c = new CRDT<string>('fresh');
        const delivered = new Set<OpIdKey>();
        let previous = new Map<string, number>();
        for (const op of shuffle([...ops, ...ops.filter((_, i) => (seed + i) % 4 === 0)], seed)) {
          const res = c.applyOp(op);
          delivered.add(op.id);
          const vv = c.getVV();
          for (const name of NAMES) {
            const now = vv.get(name) ?? 0;
            const was = previous.get(name) ?? 0;
            expect(now).toBeGreaterThanOrEqual(was); // never regresses
            // never ahead of what was actually delivered: seqs 1..now were all delivered
            for (let s = 1; s <= now; s++) expect(delivered.has(`${name}:${s}` as OpIdKey)).toBe(true);
          }
          if (res.status === 'buffered' || res.status === 'duplicate') {
            expect([...vv.entries()].sort()).toEqual([...previous.entries()].sort()); // VV unchanged
          }
          // the applied ops from each author are exactly seq 1..VV[author]
          const applied = c.getOps();
          for (const name of NAMES) {
            const seqs = applied.filter((o) => o.replicaId === name).map((o) => parseOpId(o.id)!.seq).sort((a, b) => a - b);
            expect(seqs).toEqual(Array.from({ length: vv.get(name) ?? 0 }, (_, i) => i + 1));
          }
          previous = vv;
        }
        // at the end every operation was applied
        for (const name of NAMES) {
          expect(c.getVV().get(name) ?? 0).toBe(ops.filter((o) => o.replicaId === name).length);
        }
      }),
      { ...RUNS, numRuns: 80 }
    );
  });

  it('delete-before-insert: delivering every delete before its target converges to the same result', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 1, max: 1_000_000 }), (steps, seed) => {
        const ops = runHistory(steps);
        const reference = new CRDT<string>('ref');
        deliver(reference, ops);
        const deletesFirst = [
          ...shuffle(ops.filter((o) => o.type === 'delete'), seed),
          ...shuffle(ops.filter((o) => o.type === 'insert'), seed + 1),
        ];
        const c = new CRDT<string>('fresh');
        deliver(c, deletesFirst);
        expect(view(c, ops)).toBe(view(reference, ops));
        expect(c.getPendingCount()).toBe(0);
      }),
      RUNS
    );
  });

  it('a local insert at visible index k lands at index k after convergence, on both replicas (requirements.md 1.8)', () => {
    fc.assert(
      fc.property(stepsArb, fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 1 }), (steps, pick, which) => {
        const replicas = [new CRDT<string>('r1'), new CRDT<string>('r2')];
        const all: Operation<string>[] = [];
        steps.forEach((s, i) => {
          const r = replicas[s.replica % 2];
          if (s.kind <= 1) {
            const visible = r.getSequence();
            const k = s.pick % (visible.length + 1);
            all.push(r.insert(k === 0 ? undefined : visible[k - 1].id, `v${i}`));
          } else if (s.kind === 2) {
            const visible = r.getSequence();
            if (visible.length > 0) all.push(r.delete(visible[s.pick % visible.length].id));
          } else {
            for (const op of shuffle(all, s.seed)) replicas[1 - (s.replica % 2)].applyOp(op);
          }
        });
        // converge fully, then insert at a chosen visible index on one replica
        for (const op of shuffle(all, 7)) replicas[0].applyOp(op);
        for (const op of shuffle(all, 8)) replicas[1].applyOp(op);
        const author = replicas[which];
        const other = replicas[1 - which];
        const visible = author.getSequence();
        const k = pick % (visible.length + 1);
        const before = visible.map((e) => e.id);
        const op = author.insert(k === 0 ? undefined : visible[k - 1].id, 'NEW');

        const expected = [...before.slice(0, k), op.id, ...before.slice(k)];
        expect(author.getSequence().map((e) => e.id)).toEqual(expected);
        other.applyOp(op);
        expect(other.getSequence().map((e) => e.id)).toEqual(expected);
      }),
      RUNS
    );
  });
});
