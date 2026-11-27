/**
 * CRDT.snapshot() and CRDT.fromSnapshot() (KER-029, KER-030, KER-033; requirements.md 13;
 * design.md Algorithm 8). Restoring puts the STATE back; every operation after the snapshot goes
 * through the normal applyOp pipeline (fencing, duplicates, buffering, contiguous VV), with no
 * separate path for rejoin.
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '../src/crdt.js';
import { deserializeSnapshot, serializeSnapshot } from '../src/snapshot.js';
import type { MembershipView, OpIdKey, Operation, Snapshot } from '../src/types.js';
import { serializeVersionVector } from '../src/utils.js';

const view = (active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView => ({
  activeMembers: new Set(active),
  evictedMembers: new Map(evicted),
  epoch,
});
const MEMBERS = view(['a.0', 'b.0', 'c.0'], [], 1);

const texts = (c: CRDT<string>): string[] => c.getSequence().map((e) => e.value as string);
const vvObj = (c: CRDT<string>): Record<string, number> => ({ ...serializeVersionVector(c.getVV()) });
const structure = (c: CRDT<string>): unknown[] => c.getAllElements().map((e) => [e.id, e.anchor, e.lamport, e.deleted, e.payloadReclaimed]);

/** Replica a.0 holds: keep, two buried items (one with a stable delete, so GC can reclaim it), and a live tail. */
function populated(): { a: CRDT<string>; b: CRDT<string>; ids: OpIdKey[] } {
  const a = new CRDT<string>('a.0', MEMBERS);
  const b = new CRDT<string>('b.0', MEMBERS);
  const keep = a.insert(undefined, 'keep');
  const x = a.insert(keep.id, 'secret-x-payload');
  const y = a.insert(x.id, 'secret-y-payload');
  const tail = a.insert(y.id, 'tail');
  for (const op of a.getOps()) b.applyOp(op);
  b.delete(x.id);
  for (const op of b.getOps().filter((o) => o.type === 'delete')) a.applyOp(op);
  a.delete(y.id);
  return { a, b, ids: [keep.id, x.id, y.id, tail.id] };
}

describe('snapshot()', () => {
  it('captures the elements (tombstones too), the VV, the membership with cutoffs, the clock, the ID and the stats', () => {
    const { a } = populated();
    a.updateMembership(view(['a.0', 'b.0'], [['c.0', 2]], 3));
    const snap = a.snapshot();
    expect(snap.elements).toHaveLength(4);
    expect(snap.elements.filter((e) => e.deleted)).toHaveLength(2);
    expect(Object.fromEntries(snap.vv)).toEqual(vvObj(a));
    expect(snap.membership.evictedMembers.get('c.0')).toBe(2);
    expect(snap.membership.epoch).toBe(3);
    expect(snap.lamportClock).toBe(a.getLamportClock());
    expect(snap.replicaId).toBe('a.0');
    expect(snap.gcStats?.tombstoneCount).toBe(2);
  });

  it('is a deep copy: later edits to the replica change neither the snapshot nor its serialization', () => {
    const { a, ids } = populated();
    const snap = a.snapshot();
    const json = serializeSnapshot(snap);
    a.insert(ids[3], 'later');
    a.delete(ids[0]);
    a.updateStableFrontier(new Map([['a.0', 99]]), a.getMembershipView().epoch);
    expect(serializeSnapshot(snap)).toBe(json);
  });

  it('carries the stable frontier the replica holds (so a rejoiner starts with it)', () => {
    const { a } = populated();
    a.updateStableFrontier(new Map([['a.0', 2], ['b.0', 1]]), 1);
    const snap = a.snapshot();
    expect(Object.fromEntries(snap.stableFrontier ?? new Map())).toEqual({ 'a.0': 2, 'b.0': 1 });
  });

  it('is valid by its own rules: it survives serialize and deserialize unchanged', () => {
    const { a } = populated();
    a.updateStableFrontier(new Map([['a.0', 5], ['b.0', 1]]), 1);
    const snap = a.snapshot();
    expect(deserializeSnapshot(serializeSnapshot(snap))).toEqual(snap);
  });
});

describe('fromSnapshot: a restart of the same replica', () => {
  it('restores the whole state: sequence, tombstones and their flags, VV, membership, Lamport clock, frontier, GC stats', () => {
    const { a } = populated();
    a.updateMembership(view(['a.0', 'b.0'], [['c.0', 1]], 3));
    a.updateStableFrontier(new Map([['a.0', 3], ['b.0', 1]]), 3);
    const restored = CRDT.fromSnapshot(a.snapshot());

    expect(restored.replicaId).toBe('a.0');
    expect(texts(restored)).toEqual(texts(a));
    expect(structure(restored)).toEqual(structure(a));
    expect(vvObj(restored)).toEqual(vvObj(a));
    expect(restored.getMembershipView()).toEqual(a.getMembershipView());
    expect(restored.getLamportClock()).toBe(a.getLamportClock());
    expect(Object.fromEntries(restored.getStableFrontier())).toEqual(Object.fromEntries(a.getStableFrontier()));
    expect(restored.getGCStats()).toEqual(a.getGCStats());
  });

  it('starts with an empty log and no pending operations (the log is not part of a snapshot)', () => {
    const { a } = populated();
    const restored = CRDT.fromSnapshot(a.snapshot());
    expect(restored.getOps()).toEqual([]);
    expect(restored.getPendingCount()).toBe(0);
    expect(restored.opsSince(new Map())).toEqual([]);
  });

  it('continues its own sequence: the next local operation is VV + 1, and newer than everything restored', () => {
    const { a, ids } = populated();
    const own = a.getVV().get('a.0') as number;
    const restored = CRDT.fromSnapshot(a.snapshot());
    const op = restored.insert(ids[3], 'after restart');
    expect(op.id).toBe(`a.0:${own + 1}`);
    expect(op.lamport).toBeGreaterThan(a.getLamportClock());
    expect(texts(restored).slice(-2)).toEqual(['tail', 'after restart']);
  });

  it('shares nothing with the snapshot: changing one does not change the other', () => {
    const { a } = populated();
    const snap = a.snapshot();
    const restored = CRDT.fromSnapshot(snap);
    const json = serializeSnapshot(snap);
    restored.insert(undefined, 'new');
    expect(serializeSnapshot(snap)).toBe(json);
    (snap.elements[0] as { deleted: boolean }).deleted = true;
    expect(restored.getSequence().some((e) => e.value === 'keep')).toBe(true);
  });
});

describe('fromSnapshot: a new incarnation (a returning evicted replica)', () => {
  it('starts its own sequence at 1 under the new ID, and writes normally', () => {
    const { a } = populated();
    const rejoined = CRDT.fromSnapshot(a.snapshot(), 'c.1');
    expect(rejoined.replicaId).toBe('c.1');
    expect(rejoined.getVV().get('c.1')).toBeUndefined();
    const op = rejoined.insert(undefined, 'back from the dead');
    expect(op.id).toBe('c.1:1');
    expect(texts(rejoined)).toContain('back from the dead');
    expect(texts(rejoined)).toContain('keep'); // and it has everything the snapshot had
  });

  it('refuses the evicted ID, by default and by name: an evicted ID never returns', () => {
    const { a } = populated();
    a.updateMembership(view(['a.0', 'b.0'], [['c.0', 0]], 3));
    const snapOfEvicted = a.snapshot();
    expect(() => CRDT.fromSnapshot(snapOfEvicted, 'c.0')).toThrow(RangeError);
    // a snapshot WRITTEN by a replica that is itself evicted cannot be restarted under its own ID
    const c = new CRDT<string>('c.0', MEMBERS);
    c.insert(undefined, 'mine');
    c.updateMembership(view(['a.0', 'b.0'], [['c.0', 1]], 2));
    expect(() => CRDT.fromSnapshot(c.snapshot())).toThrow(RangeError);
    expect(() => CRDT.fromSnapshot(c.snapshot(), 'c.1')).not.toThrow();
  });

  it('refuses the ID of another replica that already wrote (two replicas must never share an ID)', () => {
    const { a } = populated();
    expect(() => CRDT.fromSnapshot(a.snapshot(), 'b.0')).toThrow(RangeError); // b.0 has operations in the VV
    expect(() => CRDT.fromSnapshot(a.snapshot(), 'a.0')).not.toThrow(); // but a.0 itself may restart
  });

  it.each([[''], ['a:1'], ['has space'], [5 as unknown as string]])('rejects the invalid replica ID %j', (id) => {
    const { a } = populated();
    expect(() => CRDT.fromSnapshot(a.snapshot(), id)).toThrow(TypeError);
  });

  it('after the coordinator adds the new ID, survivors accept its operations; before that they fence them', () => {
    const { a } = populated();
    const rejoined = CRDT.fromSnapshot(a.snapshot(), 'c.1');
    const op = rejoined.insert(undefined, 'hello again');
    expect(a.applyOp(op).status).toBe('fenced'); // c.1 is not a member yet
    // the coordinator evicts the old incarnation AND adds the new one (a view that merely dropped c.0 would be ignored)
    expect(a.updateMembership(view(['a.0', 'b.0', 'c.1'], [['c.0', 0]], 2))).toBe(true);
    expect(a.applyOp(op).status).toBe('applied');
  });

  it('knows it was evicted from the snapshot\'s membership: the old ID is in evictedMembers, with its cutoff', () => {
    const c = new CRDT<string>('c.0', MEMBERS);
    c.insert(undefined, 'x');
    const a = new CRDT<string>('a.0', MEMBERS);
    for (const op of c.getOps()) a.applyOp(op);
    a.updateMembership(view(['a.0', 'b.0'], [['c.0', 1]], 2));
    const rejoined = CRDT.fromSnapshot(a.snapshot(), 'c.1');
    expect(rejoined.getMembershipView().evictedMembers.get('c.0')).toBe(1);
    expect(rejoined.getMembershipView().activeMembers.has('c.0')).toBe(false);
  });
});

describe('fromSnapshot: validation', () => {
  it('rejects a snapshot that is not valid, with a TypeError', () => {
    const { a } = populated();
    const good = a.snapshot();
    const broken = { ...good, lamportClock: -1 } as Snapshot<string>;
    expect(() => CRDT.fromSnapshot(broken)).toThrow(TypeError);
    expect(() => CRDT.fromSnapshot(null as unknown as Snapshot<string>)).toThrow(TypeError);
    expect(() => CRDT.fromSnapshot({ elements: [] } as unknown as Snapshot<string>)).toThrow(TypeError);
    const reordered = { ...good, elements: [...good.elements].reverse() } as Snapshot<string>;
    expect(() => CRDT.fromSnapshot(reordered)).toThrow(TypeError);
  });

  it('a deserialized snapshot restores just like the original', () => {
    const { a } = populated();
    const viaJson = CRDT.fromSnapshot(deserializeSnapshot(serializeSnapshot(a.snapshot())) as Snapshot<string>);
    expect(texts(viaJson)).toEqual(texts(a));
    expect(structure(viaJson)).toEqual(structure(a));
    expect(vvObj(viaJson)).toEqual(vvObj(a));
  });
});

describe('after a restore, EVERY later operation goes through applyOp (requirements.md 13.4)', () => {
  it('operations at or below the snapshot VV are duplicates, even when redelivered out of order', () => {
    const { a } = populated();
    const restored = CRDT.fromSnapshot(a.snapshot(), 'z.0');
    const before = structure(restored);
    for (const op of [...a.getOps()].reverse()) expect(restored.applyOp(op).status).toBe('duplicate');
    expect(structure(restored)).toEqual(before);
    expect(restored.getOps()).toEqual([]);
  });

  it('operations after the snapshot apply, in any order: early ones are buffered, never dropped', () => {
    const { a, ids } = populated();
    const snap = a.snapshot();
    const later: Operation<string>[] = [];
    let anchor: OpIdKey = ids[3];
    for (let i = 1; i <= 4; i++) {
      const op = a.insert(anchor, `later-${i}`);
      later.push(op);
      anchor = op.id;
    }
    const restored = CRDT.fromSnapshot(snap, 'z.0');
    expect(restored.applyOp(later[2]).status).toBe('buffered');
    expect(restored.applyOp(later[3]).status).toBe('buffered');
    expect(restored.getPendingCount()).toBe(2);
    expect(restored.applyOp(later[0]).status).toBe('applied');
    const last = restored.applyOp(later[1]);
    expect(last.unblocked).toEqual([later[2].id, later[3].id]);
    expect(texts(restored)).toEqual(texts(a));
    expect(vvObj(restored)).toEqual(vvObj(a));
  });

  it('operations from an evicted author beyond its cutoff are fenced, those within it are not', () => {
    const c = new CRDT<string>('c.0', MEMBERS);
    const c1 = c.insert(undefined, 'c-one');
    const c2 = c.insert(c1.id, 'c-two');
    const c3 = c.insert(c2.id, 'c-three');
    const a = new CRDT<string>('a.0', MEMBERS);
    a.applyOp(c1);
    a.updateMembership(view(['a.0', 'b.0'], [['c.0', 2]], 2)); // cutoff 2
    const restored = CRDT.fromSnapshot(a.snapshot(), 'z.0');
    expect(restored.applyOp(c2).status).toBe('applied'); // within the cutoff, restored from the snapshot's membership
    expect(restored.applyOp(c3).status).toBe('fenced');
    expect(vvObj(restored)['c.0']).toBe(2);
  });

  it('a no-op operation still advances the VV, so it cannot stall the ones after it', () => {
    const { a, ids } = populated(); // x was already deleted by b.0:1
    const snap = a.snapshot(); // a.0 is at seq 5
    const second = a.delete(ids[1]); // a.0:6, a second delete of the already-deleted x: a no-op
    const next = a.insert(ids[3], 'after the no-op'); // a.0:7
    const restored = CRDT.fromSnapshot(snap, 'z.0');
    expect(restored.applyOp(second).changed).toBe(false);
    expect(restored.getVV().get('a.0')).toBe(6);
    expect(restored.applyOp(next).status).toBe('applied');
    expect(restored.getVV().get('a.0')).toBe(7);
  });
});

describe('fromSnapshot: GC state', () => {
  it('keeps what GC already reclaimed, and the cumulative byte count', () => {
    const { a } = populated();
    a.updateStableFrontier(new Map([['a.0', 5], ['b.0', 1]]), 1); // covers both deletes: b.0:1 (x) and a.0:5 (y)
    const stats = a.getGCStats();
    expect(stats.payloadsReclaimed).toBe(2);
    const restored = CRDT.fromSnapshot(a.snapshot(), 'z.0');
    expect(restored.getGCStats().payloadsReclaimed).toBe(stats.payloadsReclaimed);
    expect(restored.getGCStats().bytesSaved).toBe(stats.bytesSaved);
    expect(restored.getAllElements().filter((e) => e.payloadReclaimed).map((e) => e.id)).toEqual(
      a.getAllElements().filter((e) => e.payloadReclaimed).map((e) => e.id)
    );
  });

  it('a tombstone that still holds a payload is reclaimed later, by a frontier that covers its delete', () => {
    const { a, ids } = populated();
    // nothing reclaimed yet: x was deleted by b.0:1 and y by a.0:5, neither stable
    expect(a.getGCStats().payloadsReclaimed).toBe(0);
    const restored = CRDT.fromSnapshot(a.snapshot(), 'z.0');
    restored.updateMembership(view(['a.0', 'b.0', 'c.0', 'z.0'], [], 2)); // z joins
    expect(restored.updateStableFrontier(new Map([['b.0', 1]]), 2)).toBe(true);
    const x = restored.getAllElements().find((e) => e.id === ids[1]);
    expect(x).toMatchObject({ deleted: true, payloadReclaimed: true });
    expect(x?.value).toBeUndefined();
    const y = restored.getAllElements().find((e) => e.id === ids[2]);
    expect(y?.payloadReclaimed).toBe(false); // y's delete (a.0:5) is not covered
    expect(y?.value).toBe('secret-y-payload');
  });

  it('a reclaimed tombstone in the snapshot has no payload, and still anchors new inserts', () => {
    const { a, ids } = populated();
    a.updateStableFrontier(new Map([['b.0', 1]]), 1);
    const snap = a.snapshot();
    expect(JSON.stringify(snap.elements)).not.toContain('secret-x-payload');
    const restored = CRDT.fromSnapshot(snap, 'z.0');
    const op = restored.insert(ids[1], 'anchored on a reclaimed tombstone');
    expect(op.anchor).toBe(ids[1]);
    expect(texts(restored)).toContain('anchored on a reclaimed tombstone');
  });
});

describe('fromSnapshot: open mode', () => {
  it('a replica that never had a membership view restores into open mode, accepting every author', () => {
    const solo = new CRDT<string>('s.0');
    solo.insert(undefined, 'one');
    const snap = solo.snapshot();
    expect(snap.membership.epoch).toBe(0);
    expect(snap.membership.activeMembers.size).toBe(0);
    const restored = CRDT.fromSnapshot(snap, 's.1');
    const stranger = new CRDT<string>('stranger.0');
    expect(restored.applyOp(stranger.insert(undefined, 'hi')).status).toBe('applied');
    expect(restored.getMembershipView().epoch).toBe(0);
  });
});
