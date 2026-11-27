/**
 * Property: SNAPSHOT REJOIN (design.md Property 15; requirements.md 13; the plan's eighth property).
 * A replica restored from a snapshot and then fed the operations that came after it, in ANY order
 * and any number of times, ends in the same state as a replica that was connected all along.
 * Seeded, 150 runs. Histories include concurrent edits, duplicate deletes, a real eviction, and GC
 * (so snapshots contain reclaimed tombstones and a stable frontier).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CRDT } from '../src/crdt.js';
import { removeReplica } from '../src/membership.js';
import { deserializeSnapshot, serializeSnapshot } from '../src/snapshot.js';
import type { Operation, Snapshot } from '../src/types.js';
import {
  activeView,
  fingerprint,
  frontierOf,
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

/** Run `before`, optionally GC, snapshot replica 0, then run `after`; return everything needed. */
function scenario(before: Parameters<typeof runSteps>[1], after: Parameters<typeof runSteps>[1], withGC: boolean) {
  const replicas = makeReplicas(activeView(NAMES));
  const created: Operation<string>[] = [];
  runSteps(replicas, before, created);
  syncAll(replicas);
  if (withGC) gcAll(replicas, 1);
  const source = replicas[0];
  const snapshot = source.snapshot() as Snapshot<string>;
  const knownAtSnapshot = new Set(source.getOps().map((o) => o.id));
  const sinceSnapshot: Operation<string>[] = [];
  const mark = created.length;
  runSteps(replicas, after, created, 5000);
  for (const op of created.slice(mark)) if (!knownAtSnapshot.has(op.id)) sinceSnapshot.push(op);
  return { replicas, snapshot, sinceSnapshot, created };
}

/** The rejoining replica's view of everything, for comparison with a replica that never left. */
function observable(c: CRDT<string>): unknown {
  return { visible: visible(c), structure: structure(c), vv: vvOf(c) };
}

describe('Property: snapshot rejoin', () => {
  it('snapshot + later operations, in any order, equals the replica that stayed connected', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 25), fc.integer({ min: 1, max: 1_000_000 }), fc.boolean(), (before, after, seed, withGC) => {
        const { replicas, snapshot, sinceSnapshot } = scenario(before, after, withGC);
        syncAll(replicas);

        const rejoined = CRDT.fromSnapshot(snapshot, 'rejoin.0');
        for (const op of shuffle(sinceSnapshot, seed)) rejoined.applyOp(op);
        // anything the snapshot already covered, and that arrives again, changes nothing
        for (const op of shuffle(replicas[1].getOps(), seed + 1)) rejoined.applyOp(op);

        expect(rejoined.getPendingCount()).toBe(0);
        expect(observable(rejoined)).toEqual(observable(replicas[0]));
      }),
      RUNS
    );
  });

  it('operations delivered several times, and in a different order each time, give the same result', () => {
    fc.assert(
      fc.property(stepsArb(1, 35), stepsArb(0, 20), fc.integer({ min: 1, max: 1_000_000 }), (before, after, seed) => {
        const { snapshot, sinceSnapshot, replicas } = scenario(before, after, true);
        syncAll(replicas);
        const once = CRDT.fromSnapshot(snapshot, 'rejoin.0');
        const many = CRDT.fromSnapshot(snapshot, 'rejoin.0');
        for (const op of shuffle(sinceSnapshot, seed)) once.applyOp(op);
        for (let round = 0; round < 3; round++) for (const op of shuffle(sinceSnapshot, seed + round)) many.applyOp(op);
        expect(observable(many)).toEqual(observable(once));
      }),
      RUNS
    );
  });

  it('the snapshot survives serialize and deserialize: the restored replica is identical either way', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 20), fc.boolean(), (before, after, withGC) => {
        const { snapshot, sinceSnapshot, replicas } = scenario(before, after, withGC);
        syncAll(replicas);
        const direct = CRDT.fromSnapshot(snapshot, 'rejoin.0');
        const viaJson = CRDT.fromSnapshot(deserializeSnapshot(serializeSnapshot(snapshot)) as Snapshot<string>, 'rejoin.0');
        expect(fingerprint(viaJson)).toBe(fingerprint(direct));
        for (const op of sinceSnapshot) {
          direct.applyOp(op);
          viaJson.applyOp(op);
        }
        expect(observable(viaJson)).toEqual(observable(direct));
        expect(serializeSnapshot(viaJson.snapshot() as Snapshot<string>)).toBe(serializeSnapshot(direct.snapshot() as Snapshot<string>));
      }),
      RUNS
    );
  });

  it('a restart of the SAME replica continues its own sequence and converges with the others', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 20), stepsArb(1, 12), (before, after, own) => {
        const { replicas, snapshot, sinceSnapshot } = scenario(before, after, true);
        syncAll(replicas); // the others hold everything that happened since the snapshot
        const restarted = CRDT.fromSnapshot(snapshot); // same ID, same sequence
        for (const op of sinceSnapshot) restarted.applyOp(op);
        // it writes again; its operations are exactly the next ones in its own sequence
        const written: Operation<string>[] = [];
        const everyone = [restarted, replicas[1], replicas[2]];
        runSteps(everyone, own.map((s) => ({ ...s, replica: 0, kind: s.kind % 3 })), written, 9000);
        const mine = written.filter((o) => o.replicaId === NAMES[0]);
        const first = (vvOf(replicas[0])[NAMES[0]] ?? 0) + 1;
        mine.forEach((op, i) => expect(op.id).toBe(`${NAMES[0]}:${first + i}`));

        // after a full exchange the restarted replica and the others agree
        for (const other of [replicas[1], replicas[2]]) for (const op of mine) other.applyOp(op);
        syncAll([replicas[1], replicas[2]]);
        for (const op of replicas[1].opsSince(restarted.getVV())) restarted.applyOp(op);
        expect(visible(restarted)).toEqual(visible(replicas[1]));
        expect(structure(restarted)).toEqual(structure(replicas[1]));
      }),
      RUNS
    );
  });

  it('a snapshot taken AFTER an eviction keeps fencing the evicted author, for operations in any order', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), (before, leakSeed, seed) => {
        const replicas = makeReplicas(activeView(NAMES));
        const [r1, r2, r3] = replicas;
        runSteps(replicas, before, []);
        const victim = NAMES[2];
        const victimOps = r3.getOps().filter((o) => o.replicaId === victim);
        for (const op of shuffle(victimOps, leakSeed).slice(0, leakSeed % (victimOps.length + 1))) r1.applyOp(op);
        const cutoff = Math.max(r1.getVV().get(victim) ?? 0, r2.getVV().get(victim) ?? 0);
        const published = removeReplica(activeView(NAMES), victim, cutoff);
        r1.updateMembership(published);
        r2.updateMembership(published);
        syncAll([r1, r2]);

        const rejoined = CRDT.fromSnapshot(r1.snapshot() as Snapshot<string>, 'rejoin.0');
        expect(rejoined.getMembershipView().evictedMembers.get(victim)).toBe(cutoff);
        const survivors = [r1, r2];
        for (const op of shuffle([...victimOps, ...victimOps], seed)) {
          const seq = Number(op.id.slice(op.id.lastIndexOf(':') + 1));
          const status = rejoined.applyOp(op).status;
          expect(status === 'fenced').toBe(seq > cutoff);
        }
        expect(rejoined.getVV().get(victim) ?? 0).toBe(cutoff);
        expect(survivors[0].getVV().get(victim) ?? 0).toBe(cutoff);
      }),
      RUNS
    );
  });

  it('GC after a restore reclaims exactly what GC on the original would, with the same frontier', () => {
    fc.assert(
      fc.property(stepsArb(1, 40), stepsArb(0, 20), (before, after) => {
        const { replicas, snapshot, sinceSnapshot } = scenario(before, after, false);
        syncAll(replicas);
        const rejoined = CRDT.fromSnapshot(snapshot, 'rejoin.0');
        for (const op of sinceSnapshot) rejoined.applyOp(op);
        const frontier = frontierOf(replicas);
        gcAll(replicas, 1);
        rejoined.updateStableFrontier(frontier, 1);
        const reclaimed = (c: CRDT<string>): string[] => c.getAllElements().filter((e) => e.payloadReclaimed).map((e) => e.id).sort();
        // the rejoiner may only know a LATER state of some tombstones than the snapshot, but after the same ops it reclaims the same set
        expect(reclaimed(rejoined)).toEqual(reclaimed(replicas[0]));
        expect(visible(rejoined)).toEqual(visible(replicas[0]));
      }),
      RUNS
    );
  });
});
