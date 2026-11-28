/**
 * Whole-stack integration test (KER-066, KER-067): real CRDT replicas and the real coordinator
 * core, joined by a lossy network (messages dropped, duplicated and delayed, seeded), with one
 * replica stalled and then evicted. Nothing in it is mocked.
 *
 * What it checks, for each seed:
 *  1. the surviving replicas converge to the same visible sequence and version vector;
 *  2. GC never changes what is visible (a survivor's redacted log, replayed into a fresh replica
 *     that never ran GC, gives the same visible sequence);
 *  3. GC is safe against ground truth: every reclaimed element has a delete that EVERY active
 *     member has really applied, checked before the eviction (the stalled replica counts as
 *     active) and after it;
 *  4. while the replica was stalled it held reclaiming back; after the eviction every tombstone
 *     is reclaimed and the bytes saved went up;
 *  4b. the operation log keeps no payload of a reclaimed element (design decision D-A);
 *  5. the evicted replica's offline edits are refused, and nothing beyond its cutoff is in a
 *     survivor's log.
 */
import { describe, it, expect } from 'vitest';
import { CRDT } from '@bones/kernel';
import type { OpIdKey, Operation } from '@bones/kernel';
import { CoordinatorCore } from '../src/index.js';
import type { Effect } from '../src/index.js';

type Item = { t: string };
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
const seqOf = (opId: string): number => Number(opId.split(':')[1]);
const visible = (c: CRDT<Item>): string[] => c.getSequence().map((e) => `${e.id}:${e.value?.t}`);
const ids = (c: CRDT<Item>): string[] => c.getSequence().map((e) => e.id);

/** Ground truth: every reclaimed element has a delete that all of `active` have really applied. */
function assertGcSafe(tabs: Map<string, CRDT<Item>>, observer: string, active: string[]): void {
  const a = tabs.get(observer)!;
  const log = a.getOps();
  for (const e of a.getAllElements()) {
    if (!e.deleted || !e.payloadReclaimed) continue;
    const deletes = log.filter((o) => o.type === 'delete' && o.target === e.id);
    const safe = deletes.some((d) => active.every((m) => (tabs.get(m)!.getVV().get(d.replicaId) ?? 0) >= seqOf(d.id)));
    if (!safe) throw new Error(`GC unsafe: ${e.id} was reclaimed but no delete of it was applied by all of ${active.join(', ')}`);
  }
}

function scenario(seed: number, drop: number, dup: number) {
  const r = rng(seed);
  const all = ['a.0', 'b.0', 'c.0'];
  const tabs = new Map(all.map((id) => [id, new CRDT<Item>(id)]));
  const stalled = new Set<string>();
  const core = new CoordinatorCore();
  const inbox: Array<{ at: number; to: string; op: Operation<Item> }> = [];
  let round = 0;

  const live = (): string[] => all.filter((i) => !stalled.has(i));
  const broadcast = (from: string, op: Operation<Item>): void => {
    if (stalled.has(from)) return;
    for (const to of all) {
      if (to === from || r() < drop) continue;
      const copies = r() < dup ? 2 : 1;
      for (let i = 0; i < copies; i++) inbox.push({ at: round + Math.floor(r() * 4), to, op });
    }
  };
  const apply = (es: Effect[]): void => {
    for (const e of es) {
      if (e.type === 'view') for (const id of live()) tabs.get(id)!.updateMembership(e.view);
      else if (e.type === 'frontier') for (const id of live()) tabs.get(id)!.updateStableFrontier(e.vv, e.epoch);
      else if (e.type === 'prepare') {
        for (const s of e.survivors) {
          const seq = tabs.get(s)!.holdAuthor(e.target);
          apply(core.onPrepared({ from: s, target: e.target, epoch: e.epoch, seq }, round * 1000));
        }
      } else if (e.type === 'release') for (const s of e.survivors) tabs.get(s)!.releaseAuthor(e.target);
    }
  };
  const hello = (): void => {
    for (const id of live()) {
      const t = tabs.get(id)!;
      apply(core.onHello({ from: id, epoch: t.getMembershipView().epoch, vv: t.getVV() }, round * 1000));
    }
  };
  const pull = (lossless: boolean): void => {
    for (const to of live()) for (const from of live()) {
      if (to === from) continue;
      for (const op of tabs.get(from)!.opsSince(tabs.get(to)!.getVV())) {
        if (lossless) tabs.get(to)!.applyOp(op);
        else if (r() >= drop) inbox.push({ at: round, to, op });
      }
    }
  };
  const deliver = (): void => {
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i]!.at > round) continue;
      const m = inbox.splice(i, 1)[0]!;
      if (!stalled.has(m.to)) tabs.get(m.to)!.applyOp(m.op);
    }
  };
  const edit = (id: string): void => {
    const t = tabs.get(id)!;
    const seq = t.getSequence();
    const pick = (): OpIdKey => seq[Math.floor(r() * seq.length)]!.id;
    if (seq.length > 0 && r() < 0.4) broadcast(id, t.delete(pick()));
    else broadcast(id, t.insert(seq.length > 0 ? pick() : undefined, { t: 'x'.repeat(20 + Math.floor(r() * 80)) }));
  };

  // 1. everyone edits; replicas join by hello
  for (round = 0; round < 12; round++) {
    for (const id of all) if (r() < 0.8) edit(id);
    hello(); deliver(); if (round % 3 === 0) pull(false);
  }
  // 2. c is stalled (sends and receives nothing) but keeps editing locally
  stalled.add('c.0');
  const offline: Operation<Item>[] = [];
  for (; round < 30; round++) {
    for (const id of all) {
      if (r() >= 0.8) continue;
      if (id === 'c.0') {
        const c = tabs.get('c.0')!; const s = c.getSequence();
        offline.push(c.insert(s.length > 0 ? s[0]!.id : undefined, { t: 'offline' }));
      } else edit(id);
    }
    hello(); deliver(); if (round % 3 === 0) pull(false);
  }
  const bytesBefore = tabs.get('a.0')!.getGCStats().bytesSaved;
  assertGcSafe(tabs, 'a.0', all); assertGcSafe(tabs, 'b.0', all);
  // 3. manual eviction of c (two phases)
  const started = core.startEviction('c.0');
  if (!started.ok) throw new Error(`eviction refused: ${started.reason}`);
  apply(started.effects);
  for (let k = 0; k < 6; k++, round++) { hello(); deliver(); pull(false); }
  // 4. survivors keep editing on the lossy network, then settle on a lossless one
  for (let k = 0; k < 10; k++, round++) {
    for (const id of ['a.0', 'b.0']) if (r() < 0.7) edit(id);
    hello(); deliver(); if (k % 2 === 0) pull(false);
  }
  inbox.length = 0;
  for (let k = 0; k < 8; k++, round++) { pull(true); hello(); }
  assertGcSafe(tabs, 'a.0', ['a.0', 'b.0']); assertGcSafe(tabs, 'b.0', ['a.0', 'b.0']);
  return { tabs, cutoff: core.getView().evictedMembers.get('c.0'), offline, bytesBefore };
}

describe('whole-stack integration: lossy network, stall, eviction (KER-066, KER-067)', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const { tabs, cutoff, offline, bytesBefore } = scenario(seed, 0.25, 0.15);
      const a = tabs.get('a.0')!;
      const b = tabs.get('b.0')!;

      // the scenario really happened
      expect(cutoff).toBeDefined();
      expect(offline.length).toBeGreaterThan(0);
      expect(a.getMembershipView().evictedMembers.has('c.0')).toBe(true);
      expect(a.getGCStats().tombstoneCount).toBeGreaterThan(0);

      // 1. survivors converge
      expect(visible(a)).toEqual(visible(b));
      expect([...a.getVV()].sort()).toEqual([...b.getVV()].sort());

      // 2. GC changed nothing visible: replay the redacted log into a replica that never ran GC
      const oracle = new CRDT<Item>('o.0');
      for (const op of a.getOps()) oracle.applyOp(op);
      expect(oracle.getPendingCount()).toBe(0);
      expect(ids(oracle)).toEqual(ids(a));

      // 4. everything is reclaimed after the eviction, and more bytes were saved than before
      const stats = a.getGCStats();
      expect(stats.payloadsReclaimed).toBe(stats.tombstoneCount);
      expect(stats.bytesSaved).toBeGreaterThan(bytesBefore);

      // 4b. D-A: the operation log keeps no payload of a reclaimed element either
      for (const s of [a, b]) {
        const log = new Map(s.getOps().map((o) => [o.id, o]));
        for (const e of s.getAllElements()) {
          if (e.payloadReclaimed) expect(log.get(e.id)?.value).toBeUndefined();
        }
      }

      // 5. the evicted replica's work beyond its cutoff is refused and absent
      for (const s of [a, b]) {
        for (const op of s.getOps()) if (op.replicaId === 'c.0') expect(seqOf(op.id)).toBeLessThanOrEqual(cutoff as number);
        const before = visible(s).join('|');
        for (const op of offline) expect(s.applyOp(op).status).toBe('fenced');
        expect(visible(s).join('|')).toBe(before);
      }
    });
  }
});
