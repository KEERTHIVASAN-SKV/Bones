/**
 * The "Membership, garbage collection and snapshots" example in the root README, run for real.
 * If this test breaks, the README is lying: fix the README (or the API), not this test.
 */

import { describe, it, expect } from 'vitest';
import {
  CRDT,
  computeStableFrontier,
  createMembership,
  deserializeSnapshot,
  removeReplica,
  serializeSnapshot,
} from '../src/index.js';
import type { Snapshot } from '../src/index.js';

describe('the README example works as written', () => {
  it('membership, eviction, GC and rejoin', () => {
    const members = createMembership(['alice.0', 'bob.0']);
    const alice = new CRDT<string>('alice.0', members);
    const bob = new CRDT<string>('bob.0', members);
    const first = alice.insert(undefined, 'a payload that will be reclaimed');
    bob.applyOp(first);
    const gone = alice.delete(first.id);
    bob.applyOp(gone);

    // eviction: freeze, then publish with the cutoff the survivors reported
    const seq = alice.holdAuthor('bob.0');
    expect(seq).toBe(0);
    expect(alice.updateMembership(removeReplica(members, 'bob.0', seq))).toBe(true);
    expect(alice.getMembershipView().epoch).toBe(1);
    expect(alice.applyOp(bob.insert(undefined, 'too late')).status).toBe('fenced');

    // garbage collection: the acks of the ACTIVE members only
    const acks = new Map([['alice.0', alice.getVV()]]);
    const frontier = computeStableFrontier(acks, new Set(['alice.0']));
    expect(alice.updateStableFrontier(frontier, alice.getMembershipView().epoch)).toBe(true);
    const stats = alice.getGCStats();
    expect(stats.tombstoneCount).toBe(1); // the structure stays
    expect(stats.payloadsReclaimed).toBe(1);
    expect(stats.bytesSaved).toBeGreaterThan(0);

    // rejoin as a NEW incarnation
    const json = serializeSnapshot(alice.snapshot());
    const rejoined = CRDT.fromSnapshot(deserializeSnapshot(json) as Snapshot<string>, 'bob.1');
    expect(rejoined.replicaId).toBe('bob.1');
    expect(rejoined.getAllElements()).toHaveLength(1);
    expect(() => CRDT.fromSnapshot(deserializeSnapshot(json) as Snapshot<string>, 'bob.0')).toThrow(RangeError);
  });
});
