/**
 * CRDT integration of the stable frontier and Stage 1 GC (KER-026, KER-030 to KER-033;
 * requirements.md 11, 12; decision D-A in design.md Algorithm 6).
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '../src/crdt.js';
import { computeStableFrontier } from '../src/vv.js';
import { estimatePayloadSize } from '../src/utils.js';
import type { MembershipView, OpIdKey, Operation, VersionVector } from '../src/types.js';

const view = (active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView => ({
  activeMembers: new Set(active),
  evictedMembers: new Map(evicted),
  epoch,
});
const vv = (entries: Record<string, number>): VersionVector => new Map(Object.entries(entries));

/** Deliver everything `from` has applied to `to` (a full catch-up in one direction). */
function sync(from: CRDT<string>, to: CRDT<string>): void {
  for (const op of from.opsSince(to.getVV())) to.applyOp(op);
}
function syncAll(...replicas: Array<CRDT<string>>): void {
  for (let round = 0; round < 2; round++) {
    for (const a of replicas) for (const b of replicas) if (a !== b) sync(a, b);
  }
}
const texts = (c: CRDT<string>): string[] => c.getSequence().map((e) => e.value as string);

/** The frontier the coordinator would compute from these replicas' version vectors. */
function frontierOf(replicas: Array<CRDT<string>>): VersionVector {
  const acks = new Map(replicas.map((r) => [r.replicaId, r.getVV()]));
  return computeStableFrontier(acks, new Set(replicas.map((r) => r.replicaId)));
}

/** Three replicas, all synced, holding "keep", and "secret-1".."secret-n" which `a` then buries. */
function buried(n: number) {
  const members = view(['a.0', 'b.0', 'c.0'], [], 1);
  const a = new CRDT<string>('a.0', members);
  const b = new CRDT<string>('b.0', members);
  const c = new CRDT<string>('c.0', members);
  const keep = a.insert(undefined, 'keep');
  const ids: OpIdKey[] = [];
  let anchor: OpIdKey = keep.id;
  for (let i = 1; i <= n; i++) {
    const op = a.insert(anchor, `secret-${i}-${'x'.repeat(40)}`);
    ids.push(op.id);
    anchor = op.id;
  }
  syncAll(a, b, c);
  for (const id of ids) a.delete(id);
  syncAll(a, b, c);
  return { a, b, c, keep, ids };
}

describe('updateStableFrontier reclaims payloads (KER-033)', () => {
  it('reclaims buried payloads from the sequence AND the log once every member has the deletes', () => {
    const { a, b, c, ids } = buried(3);
    const frontier = frontierOf([a, b, c]);
    expect(a.updateStableFrontier(frontier, 1)).toBe(true);

    for (const e of a.getAllElements().filter((el) => ids.includes(el.id))) {
      expect(e.deleted).toBe(true);
      expect(e.payloadReclaimed).toBe(true);
      expect(e.value).toBeUndefined();
    }
    const inserts = a.getOps().filter((o) => o.type === 'insert' && ids.includes(o.id));
    expect(inserts).toHaveLength(3);
    for (const op of inserts) expect(op.value).toBeUndefined(); // D-A: gone from the log too
    expect(texts(a)).toEqual(['keep']); // the visible sequence is unchanged
  });

  it('does not touch live items, nor the delete operations in the log', () => {
    const { a, b, c, keep } = buried(2);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(a.getOps().find((o) => o.id === keep.id)?.value).toBe('keep');
    expect(a.getOps().filter((o) => o.type === 'delete')).toHaveLength(2);
    expect(a.getOps().length).toBe(1 + 2 + 2); // the log keeps its length
  });

  it('a payload is NOT reclaimed while one active member has not applied the delete', () => {
    const members = view(['a.0', 'b.0', 'c.0'], [], 1);
    const a = new CRDT<string>('a.0', members);
    const b = new CRDT<string>('b.0', members);
    const c = new CRDT<string>('c.0', members);
    const x = a.insert(undefined, 'payload');
    syncAll(a, b, c);
    a.delete(x.id);
    sync(a, b); // c never hears about the delete
    const frontier = frontierOf([a, b, c]);
    expect(a.updateStableFrontier(frontier, 1)).toBe(true);
    expect(a.getAllElements()[0].payloadReclaimed).toBe(false);
    expect(a.getAllElements()[0].value).toBe('payload');
    expect(a.getOps()[0].value).toBe('payload');
    expect(a.getGCStats().bytesSaved).toBe(0);
  });

  it('a stable INSERT is not enough: the delete must be stable', () => {
    const members = view(['a.0', 'b.0'], [], 1);
    const a = new CRDT<string>('a.0', members);
    const b = new CRDT<string>('b.0', members);
    const x = a.insert(undefined, 'payload');
    sync(a, b);
    a.delete(x.id); // b has the insert, not the delete
    a.updateStableFrontier(frontierOf([a, b]), 1);
    expect(a.getAllElements()[0].payloadReclaimed).toBe(false);
  });

  it('works on a replica that never received a membership view (open mode, epoch 0)', () => {
    const a = new CRDT<string>('a.0');
    const x = a.insert(undefined, 'solo');
    a.delete(x.id);
    expect(a.updateStableFrontier(vv({ 'a.0': 2 }), 0)).toBe(true);
    expect(a.getAllElements()[0].payloadReclaimed).toBe(true);
  });

  it('changes neither the version vector nor the Lamport clock, and does not fire sequenceChanged', () => {
    const { a, b, c } = buried(2);
    const vvBefore = JSON.stringify([...a.getVV()]);
    const clock = a.getLamportClock();
    let sequenceEvents = 0;
    a.on('sequenceChanged', () => {
      sequenceEvents++;
    });
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(JSON.stringify([...a.getVV()])).toBe(vvBefore);
    expect(a.getLamportClock()).toBe(clock);
    expect(sequenceEvents).toBe(0);
  });
});

describe('the frontier is applied only with the current epoch (requirement 11.8)', () => {
  it('ignores a frontier with a stale or future epoch and returns false', () => {
    const { a, b, c } = buried(2);
    const frontier = frontierOf([a, b, c]);
    expect(a.updateStableFrontier(frontier, 0)).toBe(false); // stale
    expect(a.updateStableFrontier(frontier, 2)).toBe(false); // from a view this replica has not seen
    expect(a.getAllElements().some((e) => e.payloadReclaimed)).toBe(false);
    expect(a.getStableFrontier().size).toBe(0);
    expect(a.updateStableFrontier(frontier, 1)).toBe(true);
  });

  it.each([[NaN], [-1], [1.5], [Infinity], ['1' as unknown as number], [undefined as unknown as number]])(
    'ignores the malformed epoch %j',
    (epoch) => {
      const { a, b, c } = buried(1);
      expect(a.updateStableFrontier(frontierOf([a, b, c]), epoch)).toBe(false);
      expect(a.getStableFrontier().size).toBe(0);
    }
  );
});

describe('the stored frontier never moves backwards', () => {
  it('merges by taking the larger value per replica', () => {
    const a = new CRDT<string>('a.0', view(['a.0'], [], 1));
    a.updateStableFrontier(vv({ x: 5, y: 2 }), 1);
    a.updateStableFrontier(vv({ x: 3, y: 9, z: 1 }), 1); // x would go backwards
    expect(Object.fromEntries(a.getStableFrontier())).toEqual({ x: 5, y: 9, z: 1 });
  });

  it('getStableFrontier returns a copy', () => {
    const a = new CRDT<string>('a.0', view(['a.0'], [], 1));
    a.updateStableFrontier(vv({ x: 5 }), 1);
    a.getStableFrontier().set('x', 999);
    expect(a.getStableFrontier().get('x')).toBe(5);
  });

  it('does not keep a reference to the Map it was given', () => {
    const a = new CRDT<string>('a.0', view(['a.0'], [], 1));
    const given = vv({ x: 5 });
    a.updateStableFrontier(given, 1);
    given.set('x', 999);
    expect(a.getStableFrontier().get('x')).toBe(5);
  });
});

describe('a malformed frontier is rejected before anything changes', () => {
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['an object', { a: 1 }],
    ['an array', [['a', 1]]],
    ['a negative entry', vv({ a: -1 })],
    ['a fractional entry', vv({ a: 1.5 })],
    ['a NaN entry', new Map([['a', NaN]])],
    ['an infinite entry', new Map([['a', Infinity]])],
    ['a string entry', new Map([['a', '3']])],
    ['a non-string key', new Map([[7, 3]])],
  ];
  it.each(bad)('throws TypeError for %s', (_name, frontier) => {
    const { a } = buried(1);
    expect(() => a.updateStableFrontier(frontier as VersionVector, 1)).toThrow(TypeError);
    expect(a.getStableFrontier().size).toBe(0);
  });

  it('accepts an empty frontier and zero entries (no effect)', () => {
    const { a } = buried(1);
    expect(a.updateStableFrontier(new Map(), 1)).toBe(true);
    expect(a.updateStableFrontier(vv({ 'a.0': 0 }), 1)).toBe(true);
    expect(a.getAllElements().some((e) => e.payloadReclaimed)).toBe(false);
  });
});

describe('isCausallyStable, getStableFrontier, getGCStats (KER-032)', () => {
  it('isCausallyStable follows the stored frontier', () => {
    const { a, b, c } = buried(2);
    expect(a.isCausallyStable('a.0:1' as OpIdKey)).toBe(false);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(a.isCausallyStable('a.0:1' as OpIdKey)).toBe(true);
    expect(a.isCausallyStable('a.0:5' as OpIdKey)).toBe(true); // 1 keep + 2 inserts + 2 deletes = 5
    expect(a.isCausallyStable('a.0:6' as OpIdKey)).toBe(false);
  });

  it('getGCStats counts tombstones, reclaimed payloads and bytes, and reports evicted replicas and the frontier', () => {
    const { a, b, c, ids } = buried(3);
    const before = a.getGCStats();
    expect(before).toMatchObject({ tombstoneCount: 3, payloadsReclaimed: 0, bytesSaved: 0, replicasEvicted: 0 });

    const expectedBytes = ids.reduce((sum, id) => sum + estimatePayloadSize(a.getAllElements().find((e) => e.id === id)?.value), 0);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    const after = a.getGCStats();
    expect(after.tombstoneCount).toBe(3); // Stage 1 keeps the structure: the count does not go down
    expect(after.payloadsReclaimed).toBe(3);
    expect(after.bytesSaved).toBe(expectedBytes);
    expect(after.bytesSaved).toBeGreaterThan(150);
    expect(Object.fromEntries(after.stableFrontier)).toEqual(Object.fromEntries(frontierOf([a, b, c])));
  });

  it('bytesSaved is cumulative across updates and never counts a payload twice', () => {
    const { a, b, c, ids } = buried(2);
    const x = a.insert(ids[1], 'later-payload');
    syncAll(a, b, c);
    a.delete(x.id);
    syncAll(a, b, c);

    // first update: frontier covers everything except the last delete
    const partial = frontierOf([a, b, c]);
    partial.set('a.0', (partial.get('a.0') as number) - 1);
    a.updateStableFrontier(partial, 1);
    const first = a.getGCStats().bytesSaved;
    expect(first).toBeGreaterThan(0);

    a.updateStableFrontier(partial, 1); // the same frontier again
    expect(a.getGCStats().bytesSaved).toBe(first);

    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(a.getGCStats().bytesSaved).toBe(first + estimatePayloadSize('later-payload'));
  });

  it('getGCStats returns an independent copy', () => {
    const { a } = buried(1);
    const stats = a.getGCStats();
    stats.stableFrontier.set('zzz', 1);
    stats.bytesSaved = 12345;
    expect(a.getGCStats().stableFrontier.has('zzz')).toBe(false);
    expect(a.getGCStats().bytesSaved).toBe(0);
  });

  it('replicasEvicted comes from the membership view', () => {
    const a = new CRDT<string>('a.0', view(['a.0'], [['b.0', 1], ['c.0', 0]], 4));
    expect(a.getGCStats().replicasEvicted).toBe(2);
  });
});

describe('gcEvent', () => {
  it('fires once per update that reclaimed something, and not otherwise', () => {
    const { a, b, c } = buried(2);
    let events = 0;
    const listener = (): void => {
      events++;
    };
    a.on('gcEvent', listener);
    a.updateStableFrontier(new Map(), 1); // nothing stable
    a.updateStableFrontier(frontierOf([a, b, c]), 0); // wrong epoch
    expect(events).toBe(0);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(events).toBe(1);
    a.updateStableFrontier(frontierOf([a, b, c]), 1); // nothing new
    expect(events).toBe(1);
    a.off('gcEvent', listener);
  });

  it('the listener already sees the reclaimed state', () => {
    const { a, b, c } = buried(1);
    let seen: { reclaimed: number; bytes: number } | undefined;
    a.on('gcEvent', () => {
      const stats = a.getGCStats();
      seen = { reclaimed: stats.payloadsReclaimed, bytes: stats.bytesSaved };
    });
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(seen?.reclaimed).toBe(1);
    expect(seen?.bytes).toBeGreaterThan(0);
  });
});

describe('after GC the replica still works and still catches peers up (D-A)', () => {
  it('a reclaimed element still anchors an operation that arrives later (a concurrent insert after a buried item)', () => {
    const { a, b, c, ids } = buried(1);
    const late = b.insert(ids[0], 'written-after-the-delete-was-seen'); // b anchors on the tombstone
    a.updateStableFrontier(frontierOf([a, b, c]), 1); // reclaims ids[0] (b's late insert is not applied at a yet)
    expect(a.getAllElements().find((e) => e.id === ids[0])?.payloadReclaimed).toBe(true);
    expect(a.applyOp(late).status).toBe('applied');
    expect(texts(a)).toEqual(['keep', 'written-after-the-delete-was-seen']);
  });

  it('a fresh replica that replays opsSince(emptyVV) of the redacted log converges to the same visible sequence', () => {
    const { a, b, c } = buried(3);
    const tail = a.insert(a.getSequence()[0].id, 'after-gc');
    syncAll(a, b, c);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);

    const fresh = new CRDT<string>('fresh.0', view(['a.0', 'b.0', 'c.0', 'fresh.0'], [], 1));
    for (const op of a.opsSince(new Map())) expect(fresh.applyOp(op).status).toBe('applied');
    expect(texts(fresh)).toEqual(texts(a));
    expect(texts(fresh)).toEqual(['keep', 'after-gc']);
    expect(fresh.getVV()).toEqual(a.getVV());
    expect(fresh.getAllElements().map((e) => [e.id, e.deleted])).toEqual(a.getAllElements().map((e) => [e.id, e.deleted]));
    expect(fresh.getOps().some((o) => o.id === tail.id)).toBe(true);
  });

  it('opsSince hands out no payload for a reclaimed element', () => {
    const { a, b, c, ids } = buried(2);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    const sent = a.opsSince(new Map()).filter((o) => ids.includes(o.id));
    expect(sent).toHaveLength(2);
    for (const op of sent) {
      expect(op.value).toBeUndefined();
      expect(JSON.stringify(op)).not.toContain('secret');
    }
  });

  it('an operation object the caller already holds keeps its payload (the log copy is replaced, not edited)', () => {
    const members = view(['a.0', 'b.0'], [], 1);
    const a = new CRDT<string>('a.0', members);
    const b = new CRDT<string>('b.0', members);
    const insertOp = a.insert(undefined, 'held-by-the-app');
    sync(a, b);
    a.delete(insertOp.id);
    sync(a, b);
    a.updateStableFrontier(frontierOf([a, b]), 1);
    expect(insertOp.value).toBe('held-by-the-app');
    expect(a.getOps()[0].value).toBeUndefined();
  });

  it('re-delivering reclaimed operations changes nothing (they are duplicates)', () => {
    const { a, b, c } = buried(2);
    const everything: Operation<string>[] = a.getOps();
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    const before = JSON.stringify(a.getAllElements());
    for (const op of everything) expect(a.applyOp(op).status).toBe('duplicate'); // the full, unredacted copies
    expect(JSON.stringify(a.getAllElements())).toBe(before);
    expect(a.getOps().find((o) => o.type === 'insert' && o.value !== undefined && o.value !== 'keep')).toBeUndefined();
  });

  it('a replica that GC\'d and one that never did agree on everything visible', () => {
    const { a, b, c } = buried(4);
    a.updateStableFrontier(frontierOf([a, b, c]), 1);
    expect(texts(a)).toEqual(texts(b));
    expect(a.getAllElements().map((e) => [e.id, e.anchor, e.lamport, e.deleted])).toEqual(
      b.getAllElements().map((e) => [e.id, e.anchor, e.lamport, e.deleted])
    );
  });
});

describe('the demo story: a stalled replica blocks cleanup, eviction unblocks it', () => {
  it('frontier stuck behind the stalled member, then eviction moves it and the payloads are reclaimed', () => {
    const members = view(['a.0', 'b.0', 'c.0'], [], 1);
    const a = new CRDT<string>('a.0', members);
    const b = new CRDT<string>('b.0', members);
    const c = new CRDT<string>('c.0', members);

    const ids: OpIdKey[] = [];
    let anchor: OpIdKey | undefined;
    for (let i = 1; i <= 5; i++) {
      const op = a.insert(anchor, `stroke-${i}-${'p'.repeat(60)}`);
      ids.push(op.id);
      anchor = op.id;
    }
    syncAll(a, b, c);
    for (const id of ids) a.delete(id);
    sync(a, b); // c is stalled: it never hears about the deletes

    // 1. the frontier waits for c, so nothing is reclaimed
    const stuck = frontierOf([a, b, c]);
    expect(stuck.get('a.0')).toBe(5); // c has only the five inserts
    expect(a.updateStableFrontier(stuck, 1)).toBe(true);
    expect(a.getGCStats()).toMatchObject({ payloadsReclaimed: 0, bytesSaved: 0, tombstoneCount: 5 });

    // 2. exorcise c: cutoff = what the survivors hold of c (nothing: c wrote no operations), epoch 2
    const survivors = view(['a.0', 'b.0'], [['c.0', 0]], 2);
    expect(a.updateMembership(survivors)).toBe(true);
    expect(b.updateMembership(survivors)).toBe(true);
    expect(a.getMembershipView().epoch).toBe(2);

    // 3. the old epoch's frontier is refused; the one for epoch 2 (survivors only) moves and reclaims
    const moved = computeStableFrontier(
      new Map([['a.0', a.getVV()], ['b.0', b.getVV()], ['c.0', c.getVV()]]),
      survivors.activeMembers
    );
    expect(a.updateStableFrontier(moved, 1)).toBe(false);
    expect(a.updateStableFrontier(moved, 2)).toBe(true);
    const stats = a.getGCStats();
    expect(stats.payloadsReclaimed).toBe(5);
    expect(stats.tombstoneCount).toBe(5); // the structure stays
    expect(stats.replicasEvicted).toBe(1);
    expect(stats.bytesSaved).toBeGreaterThan(5 * 60);
    expect(texts(a)).toEqual([]);

    // 4. the stalled replica's later edits are fenced at the survivors
    const lateEdit = c.insert(undefined, 'written while stalled');
    expect(a.applyOp(lateEdit).status).toBe('fenced');
    expect(b.applyOp(lateEdit).status).toBe('fenced');
    expect(texts(a)).toEqual([]);
  });
});
