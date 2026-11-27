/**
 * Snapshots (KER-027, KER-028; requirements.md 13; design.md Algorithm 7): creation with deep
 * copies, deterministic serialization that does not lose Map/Set data, and a validating
 * deserializer (a snapshot arrives from another tab, so it is a trust boundary).
 */

import { describe, it, expect } from 'vitest';
import {
  assertValidSnapshot,
  createSnapshot,
  deserializeSnapshot,
  restoreRGA,
  serializeSnapshot,
} from '../src/snapshot.js';
import type { SnapshotParts } from '../src/snapshot.js';
import { applyDelete, applyInsert, createRGA, markPayloadReclaimed, traverse } from '../src/rga.js';
import type { RGAState } from '../src/rga.js';
import { createOpId, MAX_LAMPORT } from '../src/utils.js';
import type { GCStats, OpIdKey, Operation, Snapshot } from '../src/types.js';

const ins = (r: string, seq: number, anchor: OpIdKey | undefined, lamport: number, value: unknown): Operation<unknown> => ({
  id: createOpId(r, seq),
  type: 'insert',
  anchor,
  value,
  lamport,
  replicaId: r,
});
const del = (r: string, seq: number, target: OpIdKey, lamport: number): Operation<unknown> => ({
  id: createOpId(r, seq),
  type: 'delete',
  target,
  lamport,
  replicaId: r,
});
const A1 = createOpId('a.0', 1);
const A2 = createOpId('a.0', 2);
const A3 = createOpId('a.0', 3);
const B1 = createOpId('b.0', 1);

/** a:1 "alpha" <- a:2 {k:1} (deleted by b:1) and a:3 "gamma" (also under a:1, newer, so it comes first); then a:2's payload reclaimed. */
function sampleRga(): RGAState<unknown> {
  const rga = createRGA<unknown>();
  applyInsert(rga, ins('a.0', 1, undefined, 1, 'alpha'));
  applyInsert(rga, ins('a.0', 2, A1, 2, { k: [1, 2] }));
  applyInsert(rga, ins('a.0', 3, A1, 3, 'gamma'));
  applyDelete(rga, del('b.0', 1, A2, 4));
  return rga;
}

const stats = (extra: Partial<GCStats> = {}): GCStats => ({
  tombstoneCount: 1,
  payloadsReclaimed: 0,
  bytesSaved: 0,
  replicasEvicted: 0,
  stableFrontier: new Map(),
  ...extra,
});

function parts(overrides: Partial<SnapshotParts<unknown>> = {}): SnapshotParts<unknown> {
  return {
    rga: sampleRga(),
    vv: new Map([['a.0', 3], ['b.0', 1]]),
    membership: { activeMembers: new Set(['a.0', 'b.0']), evictedMembers: new Map([['c.0', 2]]), epoch: 4 },
    lamportClock: 4,
    replicaId: 'a.0',
    gcStats: stats(),
    ...overrides,
  };
}

describe('createSnapshot (KER-027)', () => {
  it('holds everything needed to restart: elements in traversal order with anchors and tombstones, VV, membership with cutoffs, clock, replica ID', () => {
    const snap = createSnapshot(parts());
    expect(snap.elements.map((e) => e.id)).toEqual([A1, A3, A2]); // a:3 is a:1's newest child, so it comes before a:2
    expect(snap.elements.map((e) => e.anchor)).toEqual([undefined, A1, A1]);
    expect(snap.elements.find((e) => e.id === A2)).toMatchObject({ deleted: true, deletedAt: B1, payloadReclaimed: false });
    expect(Object.fromEntries(snap.vv)).toEqual({ 'a.0': 3, 'b.0': 1 });
    expect([...snap.membership.activeMembers].sort()).toEqual(['a.0', 'b.0']);
    expect(snap.membership.evictedMembers.get('c.0')).toBe(2); // the cutoff travels with the snapshot
    expect(snap.membership.epoch).toBe(4);
    expect(snap.lamportClock).toBe(4);
    expect(snap.replicaId).toBe('a.0');
    expect(snap.gcStats).toBeDefined();
  });

  it('keeps reclaimed tombstones as they are (no payload, flagged)', () => {
    const rga = sampleRga();
    markPayloadReclaimed(rga, A2);
    const snap = createSnapshot(parts({ rga }));
    const e = snap.elements.find((x) => x.id === A2);
    expect(e).toMatchObject({ deleted: true, payloadReclaimed: true });
    expect(e?.value).toBeUndefined();
  });

  it('is a DEEP copy: changing the live state afterwards does not change the snapshot, nor the other way round', () => {
    const p = parts();
    const snap = createSnapshot(p);
    const before = serializeSnapshot(snap);

    // mutate the live RGA, the VV, the membership, a payload
    applyInsert(p.rga, ins('a.0', 4, A1, 9, 'late'));
    p.rga.elements.get(A1)!.deleted = true;
    (p.rga.elements.get(A2)!.value as { k: number[] }).k.push(99);
    p.vv.set('a.0', 99);
    p.membership!.activeMembers.add('hacker');
    p.membership!.evictedMembers.set('c.0', 99);
    expect(serializeSnapshot(snap)).toBe(before);

    // mutate the snapshot: the live state is untouched
    (snap.elements[2].value as { k: number[] }).k.push(7);
    snap.vv.set('b.0', 50);
    snap.membership.activeMembers.add('x.0');
    expect(p.rga.elements.get(A2)!.value).toEqual({ k: [1, 2, 99] });
    expect(p.vv.get('b.0')).toBe(1);
    expect(p.membership!.activeMembers.has('x.0')).toBe(false);
  });

  it('has no wall-clock field: the only timestamp is the Lamport clock', () => {
    const snap = createSnapshot(parts());
    expect(Object.keys(snap).sort()).toEqual(['elements', 'gcStats', 'lamportClock', 'membership', 'replicaId', 'vv']);
  });

  it('copies gcStats and the optional stable frontier too', () => {
    const p = parts({ gcStats: stats({ bytesSaved: 12, stableFrontier: new Map([['a.0', 2]]) }), stableFrontier: new Map([['a.0', 3]]) });
    const snap = createSnapshot(p);
    p.gcStats.stableFrontier.set('a.0', 99);
    p.stableFrontier!.set('a.0', 99);
    expect(snap.gcStats?.stableFrontier.get('a.0')).toBe(2);
    expect(snap.stableFrontier?.get('a.0')).toBe(3);
    expect(snap.gcStats?.bytesSaved).toBe(12);
  });

  it('a replica with no membership view (open mode) is written as the empty epoch-0 view', () => {
    const snap = createSnapshot(parts({ membership: undefined }));
    expect(snap.membership.epoch).toBe(0);
    expect(snap.membership.activeMembers.size).toBe(0);
    expect(snap.membership.evictedMembers.size).toBe(0);
  });

  it('rejects a payload that cannot be copied faithfully (a Map hides inside it) instead of silently losing it', () => {
    const rga = createRGA<unknown>();
    applyInsert(rga, ins('a.0', 1, undefined, 1, { m: new Map([['x', 1]]) }));
    expect(() => createSnapshot(parts({ rga, vv: new Map([['a.0', 1]]), lamportClock: 1 }))).toThrow(TypeError);
  });

  it('copies primitive payloads, null and an already reclaimed (undefined) payload without complaint', () => {
    const rga = createRGA<unknown>();
    applyInsert(rga, ins('a.0', 1, undefined, 1, 5));
    applyInsert(rga, ins('a.0', 2, A1, 2, null));
    applyInsert(rga, ins('a.0', 3, A2, 3, true));
    const snap = createSnapshot(parts({ rga, vv: new Map([['a.0', 3]]), lamportClock: 3 }));
    expect(snap.elements.map((e) => e.value)).toEqual([5, null, true]);
  });
});

describe('serialization (KER-028)', () => {
  it('is deterministic and does NOT lose Map or Set data: the VV and the membership appear in the JSON', () => {
    const json = serializeSnapshot(createSnapshot(parts()));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.vv).toEqual({ 'a.0': 3, 'b.0': 1 });
    expect(parsed.membership).toEqual({ activeMembers: ['a.0', 'b.0'], epoch: 4, evictedMembers: { 'c.0': 2 } });
    expect(json).not.toContain('"vv":{}');
  });

  it('gives the same string however the Maps and Sets were filled', () => {
    const one = createSnapshot(parts());
    const two = createSnapshot(
      parts({
        vv: new Map([['b.0', 1], ['a.0', 3]]),
        membership: { activeMembers: new Set(['b.0', 'a.0']), evictedMembers: new Map([['c.0', 2]]), epoch: 4 },
      })
    );
    expect(serializeSnapshot(two)).toBe(serializeSnapshot(one));
  });

  it('round-trips: deserialize(serialize(s)) equals s, and serialize(deserialize(json)) === json', () => {
    const rga = sampleRga();
    markPayloadReclaimed(rga, A2);
    for (const snap of [
      createSnapshot(parts()),
      createSnapshot(parts({ rga })),
      createSnapshot(parts({ membership: undefined })),
      createSnapshot(parts({ stableFrontier: new Map([['a.0', 2]]), gcStats: stats({ bytesSaved: 7, stableFrontier: new Map([['b.0', 1]]) }) })),
    ]) {
      const json = serializeSnapshot(snap);
      const back = deserializeSnapshot(json);
      expect(back).toEqual(snap);
      expect(serializeSnapshot(back)).toBe(json);
    }
  });

  it('round-trips an empty replica', () => {
    const snap = createSnapshot(parts({ rga: createRGA<unknown>(), vv: new Map(), lamportClock: 0 }));
    expect(deserializeSnapshot(serializeSnapshot(snap))).toEqual(snap);
  });

  it('keeps a replica called "__proto__" as an ordinary ID', () => {
    const snap = createSnapshot(
      parts({
        vv: new Map([['a.0', 3], ['b.0', 1], ['__proto__', 5]]),
        membership: { activeMembers: new Set(['a.0']), evictedMembers: new Map([['__proto__', 2]]), epoch: 3 },
      })
    );
    const back = deserializeSnapshot(serializeSnapshot(snap));
    expect(back.vv.get('__proto__')).toBe(5);
    expect(back.membership.evictedMembers.get('__proto__')).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('survives payloads of every JSON shape', () => {
    const rga = createRGA<unknown>();
    let prev: OpIdKey | undefined;
    const values: unknown[] = ['text', 0, -1.5, true, false, null, [], {}, [1, [2, { a: 3 }]], { nested: { list: ['é', '"quoted"', '\n'] } }];
    values.forEach((v, i) => {
      applyInsert(rga, ins('a.0', i + 1, prev, i + 1, v));
      prev = createOpId('a.0', i + 1);
    });
    const snap = createSnapshot(parts({ rga, vv: new Map([['a.0', values.length]]), lamportClock: values.length }));
    expect(deserializeSnapshot(serializeSnapshot(snap)).elements.map((e) => e.value)).toEqual(values);
  });
});

describe('deserializeSnapshot rejects anything that is not a well-formed snapshot (trust boundary)', () => {
  const good = (): Record<string, unknown> => JSON.parse(serializeSnapshot(createSnapshot(parts()))) as Record<string, unknown>;
  const withChange = (change: (s: Record<string, unknown>) => void): string => {
    const s = good();
    change(s);
    return JSON.stringify(s);
  };
  const element = (s: Record<string, unknown>, i: number): Record<string, unknown> => (s.elements as Array<Record<string, unknown>>)[i];

  const BAD: Array<[string, string]> = [
    ['not JSON', '{'],
    ['empty', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['an empty object', '{}'],
    ['no elements', withChange((s) => delete s.elements)],
    ['elements as an object', withChange((s) => (s.elements = {}))],
    ['no vv', withChange((s) => delete s.vv)],
    ['vv as an array', withChange((s) => (s.vv = []))],
    ['a fractional vv entry', withChange((s) => (s.vv = { 'a.0': 1.5 }))],
    ['a negative vv entry', withChange((s) => (s.vv = { 'a.0': -1 }))],
    ['a bad replica ID in the vv', withChange((s) => (s.vv = { 'a:0': 1 }))],
    ['no membership', withChange((s) => delete s.membership)],
    ['a malformed membership', withChange((s) => (s.membership = { activeMembers: 'a.0', epoch: 1, evictedMembers: {} }))],
    ['a replica both active and evicted', withChange((s) => (s.membership = { activeMembers: ['a.0'], epoch: 1, evictedMembers: { 'a.0': 1 } }))],
    ['no lamportClock', withChange((s) => delete s.lamportClock)],
    ['a fractional lamportClock', withChange((s) => (s.lamportClock = 1.5))],
    ['a negative lamportClock', withChange((s) => (s.lamportClock = -1))],
    ['a lamportClock above the limit', withChange((s) => (s.lamportClock = MAX_LAMPORT + 1))],
    ['a lamportClock below an element\'s Lamport time', withChange((s) => (s.lamportClock = 2))],
    ['no replicaId', withChange((s) => delete s.replicaId)],
    ['an invalid replicaId', withChange((s) => (s.replicaId = 'a:b'))],
    ['a numeric replicaId', withChange((s) => (s.replicaId = 7))],
    ['an element that is not an object', withChange((s) => ((s.elements as unknown[])[0] = 5))],
    ['an element with a bad id', withChange((s) => (element(s, 0).id = 'nocolon'))],
    ['an element with seq 0', withChange((s) => (element(s, 0).id = 'a.0:0'))],
    ['an element beyond the version vector', withChange((s) => (element(s, 0).id = 'a.0:9'))],
    ['an element of an author the vv does not know', withChange((s) => (element(s, 0).id = 'z.0:1'))],
    ['a duplicate element id', withChange((s) => (element(s, 1).id = String(element(s, 0).id)))],
    ['an anchor that is not an id', withChange((s) => (element(s, 1).anchor = 'x'))],
    ['an anchor to an unknown element', withChange((s) => (element(s, 1).anchor = 'a.0:2'.replace('2', '1').replace('a.0', 'zz.0')))],
    ['an anchor to an element that comes LATER', withChange((s) => (element(s, 0).anchor = String(element(s, 2).id)))],
    ['an element anchored on itself', withChange((s) => (element(s, 1).anchor = String(element(s, 1).id)))],
    ['a bad Lamport time', withChange((s) => (element(s, 0).lamport = -1))],
    ['a fractional Lamport time', withChange((s) => (element(s, 0).lamport = 0.5))],
    ['a Lamport time above the limit', withChange((s) => (element(s, 0).lamport = MAX_LAMPORT + 1))],
    ['"deleted" that is not a boolean', withChange((s) => (element(s, 0).deleted = 'no'))],
    ['a tombstone without deletedAt', withChange((s) => delete element(s, 2).deletedAt)],
    ['a live element with deletedAt', withChange((s) => (element(s, 0).deletedAt = 'b.0:1'))],
    ['a deletedAt beyond the version vector', withChange((s) => (element(s, 2).deletedAt = 'b.0:9'))],
    ['a bad deletedAt', withChange((s) => (element(s, 2).deletedAt = 'x'))],
    ['payloadReclaimed on a live element', withChange((s) => (element(s, 0).payloadReclaimed = true))],
    ['a reclaimed element that still has a value', withChange((s) => (element(s, 2).payloadReclaimed = true))],
    ['payloadReclaimed that is not a boolean', withChange((s) => (element(s, 0).payloadReclaimed = 1))],
    ['siblings in the wrong order (oldest first)', withChange((s) => { const e = s.elements as unknown[]; [e[1], e[2]] = [e[2], e[1]]; })],
    ['elements out of depth-first order', withChange((s) => { const e = s.elements as unknown[]; e.push(e.shift()); })],
    ['a bad gcStats', withChange((s) => (s.gcStats = { tombstoneCount: -1, payloadsReclaimed: 0, bytesSaved: 0, replicasEvicted: 0, stableFrontier: {} }))],
    ['a gcStats frontier that is not an object', withChange((s) => (s.gcStats = { tombstoneCount: 0, payloadsReclaimed: 0, bytesSaved: 0, replicasEvicted: 0, stableFrontier: [] }))],
    ['a bad stableFrontier', withChange((s) => (s.stableFrontier = { 'a.0': 'x' }))],
  ];

  it.each(BAD)('rejects %s', (_name, json) => {
    expect(() => deserializeSnapshot(json)).toThrow();
  });

  it('never half-builds a snapshot: it throws before returning anything', () => {
    let result: Snapshot<unknown> | undefined;
    try {
      result = deserializeSnapshot(withChange((s) => (element(s, 1).anchor = 'x')));
    } catch {
      /* expected */
    }
    expect(result).toBeUndefined();
  });

  it('assertValidSnapshot accepts a real snapshot and rejects the same corruptions in memory', () => {
    expect(() => assertValidSnapshot(createSnapshot(parts()))).not.toThrow();
    const broken = createSnapshot(parts());
    (broken.elements as unknown as Array<{ lamport: number }>)[0].lamport = -3;
    expect(() => assertValidSnapshot(broken)).toThrow(TypeError);
    expect(() => assertValidSnapshot(null)).toThrow(TypeError);
    expect(() => assertValidSnapshot({ elements: [] })).toThrow(TypeError);
  });

  it('accepts the unusual-but-valid: a tombstone whose payload is reclaimed, optional fields absent', () => {
    const rga = sampleRga();
    markPayloadReclaimed(rga, A2);
    const snap = createSnapshot(parts({ rga, stableFrontier: new Map([['a.0', 1]]) }));
    const json = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>;
    delete json.gcStats; // a snapshot from another producer may leave out the optional fields
    delete json.stableFrontier;
    const back = deserializeSnapshot(JSON.stringify(json));
    expect(back.gcStats).toBeUndefined();
    expect(back.stableFrontier).toBeUndefined();
    expect(back.elements.find((e) => e.id === A2)).toMatchObject({ deleted: true, payloadReclaimed: true });
  });
});

describe('each validation rule on its own (one corruption at a time, so no neighbouring rule can catch it first)', () => {
  const base = (): Snapshot<unknown> => createSnapshot(parts());
  /** The snapshot as a mutable plain object, with one thing changed. */
  const broken = (change: (s: Record<string, unknown>, elements: Array<Record<string, unknown>>) => void): unknown => {
    const s = base() as unknown as Record<string, unknown>;
    const elements = (s.elements as Array<Record<string, unknown>>).map((e) => ({ ...e }));
    s.elements = elements;
    change(s, elements);
    return s;
  };
  // elements are [A1 (root), A3 (leaf, under A1), A2 (leaf, tombstone, under A1)]
  const CASES: Array<[string, unknown]> = [
    ['a leaf element beyond the version vector', broken((_s, e) => (e[2].id = 'a.0:9'))],
    ['a leaf element of an author the version vector does not know', broken((_s, e) => (e[2].id = 'q.0:1'))],
    ['a duplicate id', broken((_s, e) => (e[2].id = e[1].id))],
    ['"deleted" that is falsy but not a boolean', broken((_s, e) => (e[0].deleted = 0))],
    ['"payloadReclaimed" that is falsy but not a boolean', broken((_s, e) => (e[0].payloadReclaimed = 0))],
    ['a live element marked reclaimed (with its value removed)', broken((_s, e) => { e[0].payloadReclaimed = true; delete e[0].value; })],
    ['two siblings in the wrong order (older first)', broken((_s, e) => { e[2].lamport = 3; e[1].lamport = 2; })],
    ['an anchor to an element that does not exist', broken((_s, e) => (e[2].anchor = 'a.0:2'.replace('a.0', 'nobody.0')))],
    ['an anchor to an element listed later', broken((_s, e) => (e[0].anchor = e[2].id))],
    ['an element anchored on itself', broken((_s, e) => (e[1].anchor = e[1].id))],
    ['an anchor that is not even an id', broken((_s, e) => (e[1].anchor = 5))],
    ['elements in the wrong depth-first order (a leaf before its parent)', broken((s, e) => { s.elements = [e[1], e[0], e[2]]; })],
    ['a version vector that is not a Map', broken((s) => (s.vv = { 'a.0': 3 }))],
    ['a version vector with a negative entry', broken((s) => (s.vv = new Map([['a.0', -1]])))],
    ['a membership that is not a view', broken((s) => (s.membership = { activeMembers: ['a.0'], evictedMembers: {}, epoch: 1 }))],
    ['a stable frontier that is not a Map', broken((s) => (s.stableFrontier = { 'a.0': 1 }))],
    ['a stable frontier with a bad entry', broken((s) => (s.stableFrontier = new Map([['a.0', 1.5]])))],
    ['gcStats with a bad count', broken((s) => (s.gcStats = { ...(s.gcStats as object), bytesSaved: -1 }))],
    ['gcStats with a bad frontier', broken((s) => (s.gcStats = { ...(s.gcStats as object), stableFrontier: { a: 1 } }))],
  ];

  it.each(CASES)('rejects %s', (_name, snapshot) => {
    expect(() => assertValidSnapshot(snapshot)).toThrow(TypeError);
  });

  it('says WHICH rule failed, in words (the first problem found, not a generic crash)', () => {
    const message = (snapshot: unknown): string => {
      try {
        assertValidSnapshot(snapshot);
      } catch (error) {
        return (error as Error).message;
      }
      return 'accepted';
    };
    expect(message(broken((s) => (s.vv = { 'a.0': 3 })))).toMatch(/version vector: expected a Map/);
    expect(message(broken((s) => (s.membership = { activeMembers: ['a.0'], evictedMembers: {}, epoch: 1 })))).toMatch(/membership/);
    expect(message(broken((s) => (s.stableFrontier = { 'a.0': 1 })))).toMatch(/version vector: expected a Map/);
    expect(message(broken((_s, e) => (e[2].id = e[1].id)))).toMatch(/listed twice/);
    expect(message(broken((_s, e) => (e[2].id = 'a.0:9')))).toMatch(/beyond the version vector/);
  });

  it('the untouched snapshot passes the same helper (the cases above change exactly one thing)', () => {
    expect(() => assertValidSnapshot(broken(() => undefined))).not.toThrow();
  });
});

describe('restoreRGA', () => {
  it('rebuilds the same tree: traversal order, children lists (newest first), anchors, flags', () => {
    const snap = createSnapshot(parts());
    const rga = restoreRGA(snap);
    expect(traverse(rga).map((e) => e.id)).toEqual(snap.elements.map((e) => e.id));
    expect(rga.children.get('HEAD')).toEqual([A1]);
    expect(rga.children.get(A1)).toEqual([A3, A2]); // a:3 is newer than a:2
    expect(rga.elements.get(A2)).toMatchObject({ deleted: true, deletedAt: B1, anchor: A1 });
  });

  it('seeds the delete-op bookkeeping from deletedAt for a tombstone that still holds its payload, and only for those', () => {
    const rga = sampleRga();
    const withReclaimed = createRGA<unknown>();
    // second tombstone, already reclaimed
    applyInsert(withReclaimed, ins('a.0', 1, undefined, 1, 'alpha'));
    applyInsert(withReclaimed, ins('a.0', 2, A1, 2, 'beta'));
    applyDelete(withReclaimed, del('b.0', 1, A1, 3));
    applyDelete(withReclaimed, del('b.0', 2, A2, 4));
    markPayloadReclaimed(withReclaimed, A2);

    const restored = restoreRGA(createSnapshot(parts({ rga: withReclaimed, vv: new Map([['a.0', 2], ['b.0', 2]]), lamportClock: 4 })));
    expect(restored.deleteOps.get(A1)).toEqual(new Set([B1])); // holds its payload: GC may reclaim it later
    expect(restored.deleteOps.has(A2)).toBe(false); // already reclaimed: nothing to track
    expect(restoreRGA(createSnapshot(parts({ rga }))).deleteOps.get(A2)).toEqual(new Set([B1]));
  });

  it('shares no element object with the snapshot', () => {
    const snap = createSnapshot(parts());
    const rga = restoreRGA(snap);
    for (const e of snap.elements) expect(rga.elements.get(e.id)).not.toBe(e);
    (rga.elements.get(A1) as { deleted: boolean }).deleted = true;
    expect(snap.elements[0].deleted).toBe(false);
  });
});

describe('a snapshot is a faithful picture of the RGA', () => {
  it('lists exactly the elements of traverse(), tombstones included, in that order', () => {
    const rga = sampleRga();
    const snap = createSnapshot(parts({ rga }));
    expect(snap.elements.map((e) => e.id)).toEqual(traverse(rga).map((e) => e.id));
    expect(snap.elements).toHaveLength(3);
  });
});
