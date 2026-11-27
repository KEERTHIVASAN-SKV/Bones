/**
 * Shared helpers for the Gate A property tests (frontier safety, GC safety, fencing).
 * Histories come from three replicas that edit concurrently and sync only partially, so they
 * contain nested anchors, inserts after tombstones, concurrent edits and duplicate deletes.
 * Everything is a pure function of the generated steps, so the SAME steps can be replayed on a
 * second set of replicas (a control that never runs GC) and the two sets compared.
 */

import * as fc from 'fast-check';
import { CRDT } from '../../src/crdt.js';
import type { MembershipView, OpIdKey, Operation, VersionVector } from '../../src/types.js';
import { serializeVersionVector } from '../../src/utils.js';
import { computeStableFrontier } from '../../src/vv.js';

export const NAMES = ['r1.0', 'r2.0', 'r3.0'] as const;

/** Small deterministic PRNG so one fast-check integer drives a whole shuffle. */
export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One generated step. `kind`: 0 insert after a visible element, 1 insert after ANY element
 *  (a tombstone too), 2 delete any known element, 3 partial delivery, 4 catch-up through opsSince. */
export interface Step {
  replica: number;
  kind: number;
  pick: number;
  seed: number;
}

export const stepArb: fc.Arbitrary<Step> = fc.record({
  replica: fc.integer({ min: 0, max: 2 }),
  kind: fc.integer({ min: 0, max: 4 }),
  pick: fc.integer({ min: 0, max: 100_000 }),
  seed: fc.integer({ min: 1, max: 1_000_000 }),
});

export const stepsArb = (minLength: number, maxLength: number): fc.Arbitrary<Step[]> =>
  fc.array(stepArb, { minLength, maxLength });

/** A view in which all `names` are active. */
export function activeView(names: readonly string[], epoch = 1): MembershipView {
  return { activeMembers: new Set(names), evictedMembers: new Map(), epoch };
}

/** Three fresh replicas, optionally with a membership view (otherwise open mode). */
export function makeReplicas(view?: MembershipView): CRDT<string>[] {
  return NAMES.map((name) => new CRDT<string>(name, view));
}

/**
 * Run steps on `replicas`, pushing every created operation to `created`. `offset` keeps payloads
 * unique across several calls. Deterministic: the same steps on equal replicas give the same
 * operations (ids, Lamport times, values).
 */
export function runSteps(
  replicas: CRDT<string>[],
  steps: readonly Step[],
  created: Operation<string>[],
  offset = 0
): void {
  steps.forEach((s, i) => {
    const r = replicas[s.replica % replicas.length];
    const payload = `v${offset + i}-${'x'.repeat(s.pick % 25)}`;
    if (s.kind === 0) {
      const visible = r.getSequence();
      const k = s.pick % (visible.length + 1);
      created.push(r.insert(k === 0 ? undefined : visible[k - 1].id, payload));
    } else if (s.kind === 1) {
      const all = r.getAllElements();
      const k = s.pick % (all.length + 1);
      created.push(r.insert(k === 0 ? undefined : all[k - 1].id, payload));
    } else if (s.kind === 2) {
      const all = r.getAllElements();
      if (all.length > 0) created.push(r.delete(all[s.pick % all.length].id));
    } else if (s.kind === 3) {
      const batch = shuffle(created, s.seed).slice(0, s.pick % (created.length + 1));
      for (const op of batch) replicas[s.pick % replicas.length].applyOp(op);
    } else {
      const src = replicas[s.pick % replicas.length];
      const dst = replicas[(s.pick + 1 + (s.seed % (replicas.length - 1))) % replicas.length];
      for (const op of src.opsSince(dst.getVV())) dst.applyOp(op);
    }
  });
}

/** Catch-up between every pair, repeated until nothing changes (a peer holding buffered ops can only send what it applied, so one round may not be enough). */
export function syncAll(replicas: readonly CRDT<string>[], maxRounds = 8): void {
  for (let round = 0; round < maxRounds; round++) {
    let moved = false;
    for (const src of replicas) {
      for (const dst of replicas) {
        if (src === dst) continue;
        for (const op of src.opsSince(dst.getVV())) {
          if (dst.applyOp(op).status === 'applied') moved = true;
        }
      }
    }
    if (!moved) return;
  }
}

/** The visible sequence as [id, value] pairs. */
export function visible(c: CRDT<string>): Array<[OpIdKey, string | undefined]> {
  return c.getSequence().map((e) => [e.id, e.value]);
}

/** Everything structural: order, anchors, Lamport times and deleted flags (never payloads). */
export function structure(c: CRDT<string>): Array<[OpIdKey, OpIdKey | undefined, number, boolean]> {
  return c.getAllElements().map((e) => [e.id, e.anchor, e.lamport, e.deleted]);
}

/** The version vector as a plain sorted object, for comparisons. */
export function vvOf(c: CRDT<string>): Record<string, number> {
  return { ...serializeVersionVector(c.getVV()) };
}

/**
 * The frontier a coordinator would compute from the replicas' current version vectors, counting
 * only `active` as members (default: all of them).
 */
export function frontierOf(replicas: readonly CRDT<string>[], active?: readonly string[]): VersionVector {
  const acks = new Map(replicas.map((r) => [r.replicaId, r.getVV()]));
  return computeStableFrontier(acks, new Set(active ?? replicas.map((r) => r.replicaId)));
}

/** Tell every replica the frontier computed from all of them now (an honest coordinator round). */
export function gcAll(replicas: readonly CRDT<string>[], epoch: number): void {
  const frontier = frontierOf(replicas);
  for (const r of replicas) {
    if (!r.updateStableFrontier(frontier, epoch)) throw new Error('gcAll: frontier was refused (epoch mismatch)');
  }
}

/** Everything a rejected operation must leave alone, as one string. */
export function fingerprint(c: CRDT<string>): string {
  return JSON.stringify({
    elements: c.getAllElements(),
    vv: serializeVersionVector(c.getVV()),
    ops: c.getOps().map((o) => o.id),
    pending: c.getPendingCount(),
    clock: c.getLamportClock(),
    frontier: serializeVersionVector(c.getStableFrontier()),
  });
}
