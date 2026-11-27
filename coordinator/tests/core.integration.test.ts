/**
 * The pure coordinator core driven together with REAL kernel replicas, through a tiny in-memory
 * "page" that does what the adapters will do: turn effects into calls on the kernel (hold, view,
 * frontier) and tabs' hellos and replies into calls on the core. This is the demo story at the
 * model level (Gate B without a browser):
 *   a stalled tab blocks reclamation -> Exorcise -> the frontier moves and bytes are reclaimed ->
 *   the stalled tab's later edits are fenced.
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '@bones/kernel';
import type { MembershipView, Operation } from '@bones/kernel';
import { CoordinatorCore } from '../src/core.js';
import type { Effect } from '../src/core.js';

const texts = (c: CRDT<string>): string[] => c.getSequence().map((e) => e.value as string);

/** One tab: a replica plus a flag for "stalled" (sends and receives nothing). */
interface Tab {
  id: string;
  crdt: CRDT<string>;
  stalled: boolean;
}

/** Everything a page does: delivers operations between non-stalled tabs, runs hellos, applies effects. */
class World {
  readonly core = new CoordinatorCore({ frontierResendMs: 1 });
  readonly tabs: Tab[] = [];
  private now = 1000;
  readonly rejected: Array<{ to: string; epoch: number }> = [];
  /** Tabs that do not hear `view` messages (a lost message). */
  readonly dropViewFor = new Set<string>();

  constructor(ids: string[]) {
    for (const id of ids) this.tabs.push({ id, crdt: new CRDT<string>(id), stalled: false });
    for (const tab of this.tabs) this.hello(tab); // each tab announces itself: the coordinator adds it
    for (const tab of this.tabs) this.hello(tab); // second round: everyone is at the final epoch
  }

  tab(id: string): Tab {
    return this.tabs.find((t) => t.id === id) as Tab;
  }

  live(): Tab[] {
    return this.tabs.filter((t) => !t.stalled);
  }

  /** One hello from a tab to the coordinator, with its real epoch and version vector. */
  hello(tab: Tab): void {
    if (tab.stalled) return;
    this.now += 1;
    const effects = this.core.onHello({ from: tab.id, epoch: tab.crdt.getMembershipView().epoch, vv: tab.crdt.getVV() }, this.now);
    this.perform(effects);
  }

  /** Every live tab sends its ops to every other live tab (what hello replies do on the real channel). */
  syncTabs(): void {
    for (let round = 0; round < 3; round++) {
      for (const from of this.live()) {
        for (const to of this.live()) {
          if (from === to) continue;
          for (const op of from.crdt.opsSince(to.crdt.getVV())) to.crdt.applyOp(op);
        }
      }
    }
  }

  /** One full round: sync the live tabs, then every live tab says hello. */
  round(): void {
    this.syncTabs();
    for (const tab of this.live()) this.hello(tab);
    for (const tab of this.live()) this.hello(tab);
  }

  /** What the adapter does with each effect. Stalled tabs hear nothing. */
  perform(effects: Effect[]): void {
    for (const effect of effects) {
      for (const tab of this.live()) {
        if (effect.type === 'view') {
          if (!this.dropViewFor.has(tab.id)) tab.crdt.updateMembership(effect.view);
        }
        else if (effect.type === 'frontier') tab.crdt.updateStableFrontier(effect.vv, effect.epoch);
        else if (effect.type === 'prepare' && effect.survivors.includes(tab.id)) {
          const seq = tab.crdt.holdAuthor(effect.target);
          this.now += 1;
          this.perform(this.core.onPrepared({ from: tab.id, target: effect.target, epoch: tab.crdt.getMembershipView().epoch, seq }, this.now));
        } else if (effect.type === 'release' && effect.survivors.includes(tab.id)) tab.crdt.releaseAuthor(effect.target);
        else if (effect.type === 'rejected' && effect.to === tab.id) this.rejected.push({ to: effect.to, epoch: effect.epoch });
      }
    }
  }

  exorcise(target: string): void {
    const result = this.core.startEviction(target);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    this.perform(result.effects);
  }
}

/** The user adds n items of ~60 characters to `tab` (anchored one after the other) and returns their ops. */
function addItems(tab: Tab, n: number, label: string): Operation<string>[] {
  const ops: Operation<string>[] = [];
  for (let i = 1; i <= n; i++) ops.push(tab.crdt.insert(ops[i - 2]?.id, `${label}-${i}-${'p'.repeat(60)}`));
  return ops;
}

describe('the demo story, with real replicas', () => {
  it('tabs join, stay in sync, and the coordinator agrees on the members', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    expect(w.core.getView().epoch).toBe(3);
    for (const tab of w.tabs) expect(tab.crdt.getMembershipView().epoch).toBe(3);
    addItems(w.tab('a.0'), 3, 'x');
    w.round();
    for (const tab of w.tabs) expect(texts(tab.crdt)).toHaveLength(3);
  });

  it('a stalled tab holds the frontier back, so burying reclaims nothing; Exorcise moves the frontier and reclaims the payloads', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b, c] = [w.tab('a.0'), w.tab('b.0'), w.tab('c.0')];

    const items = addItems(a, 6, 'item');
    w.round(); // everyone has the six items
    c.stalled = true; // STALL: c sends and hears nothing from now on
    for (const op of items) a.crdt.delete(op.id); // bury all
    w.round();

    // 1. the frontier waits for c: nothing is reclaimed anywhere
    expect(texts(a.crdt)).toEqual([]);
    expect(a.crdt.getGCStats()).toMatchObject({ tombstoneCount: 6, payloadsReclaimed: 0, bytesSaved: 0 });
    expect(b.crdt.getGCStats().payloadsReclaimed).toBe(0);

    // 2. EXORCISE c
    w.exorcise('c.0');
    expect(w.core.getStatus(0, 1).eviction).toBeNull(); // both survivors replied: published at once
    w.round();

    expect(w.core.getView().epoch).toBe(4);
    for (const tab of [a, b]) {
      expect(tab.crdt.getMembershipView().epoch).toBe(4);
      expect(tab.crdt.getMembershipView().evictedMembers.has('c.0')).toBe(true);
      const stats = tab.crdt.getGCStats();
      expect(stats.payloadsReclaimed).toBe(6); // the frontier moved: every payload is gone...
      expect(stats.tombstoneCount).toBe(6); // ...but the structure stays
      expect(stats.bytesSaved).toBeGreaterThan(6 * 60);
      expect(stats.replicasEvicted).toBe(1);
    }
    // the log carries no payload any more either (decision D-A)
    expect(JSON.stringify(a.crdt.opsSince(new Map()))).not.toContain('ppppp');

    // 3. the stalled tab resumes and keeps editing: the survivors fence it
    c.stalled = false;
    const late = c.crdt.insert(undefined, 'written while stalled');
    expect(a.crdt.applyOp(late).status).toBe('fenced');
    expect(b.crdt.applyOp(late).status).toBe('fenced');
    expect(texts(a.crdt)).toEqual([]);

    // 4. the coordinator rejects c's hello, and its epoch is stale, so it can learn it was evicted
    w.hello(c);
    expect(w.rejected.some((r) => r.to === 'c.0' && r.epoch === 4)).toBe(true);
  });

  it('a LIVE tab can be exorcised too: the survivors freeze it, agree on the cutoff, and do not diverge', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b, c] = [w.tab('a.0'), w.tab('b.0'), w.tab('c.0')];
    addItems(c, 3, 'c-before');
    w.round();

    // c writes more, and each of those operations reaches only ONE survivor before the exorcism
    const orphans = addItems(c, 3, 'c-during').slice(0, 3); // c.0:4..6 (anchor chain restarts: fine)
    a.crdt.applyOp(orphans[0]); // a holds c:4 ...
    b.crdt.applyOp(orphans[0]);
    b.crdt.applyOp(orphans[1]); // ... b also holds c:5; nobody holds c:6

    w.exorcise('c.0');
    // both survivors froze at their own seq (4 and 5) and replied: cutoff = 5
    expect(w.core.getView().evictedMembers.get('c.0')).toBe(5);

    // c's operation c:6 keeps arriving while c is still being talked about: fenced, never applied
    expect(a.crdt.applyOp(orphans[2]).status).toBe('fenced');
    expect(b.crdt.applyOp(orphans[2]).status).toBe('fenced');
    w.round(); // survivors reconcile: a backfills c:5 from b

    expect(a.crdt.getVV().get('c.0')).toBe(5);
    expect(b.crdt.getVV().get('c.0')).toBe(5);
    expect(texts(a.crdt)).toEqual(texts(b.crdt));
    expect(w.core.getStatus(0, 1).evicted[0]).toMatchObject({ id: 'c.0', cutoff: 5, complete: true });
  });

  it('without the freeze the same scenario would diverge (the reason `prepare` exists)', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b, c] = [w.tab('a.0'), w.tab('b.0'), w.tab('c.0')];
    addItems(c, 2, 'c');
    w.round();

    // an eviction published with the cutoff that was true at the ACK (2), while one survivor
    // applied c:3 in the meantime because nothing froze it
    const c3 = c.crdt.insert(undefined, 'c-three');
    a.crdt.applyOp(c3); // applied: no hold
    const view: MembershipView = { activeMembers: new Set(['a.0', 'b.0']), evictedMembers: new Map([['c.0', 2]]), epoch: 4 };
    a.crdt.updateMembership(view);
    b.crdt.updateMembership(view);
    b.crdt.applyOp(c3); // fenced at b: beyond the cutoff
    expect(texts(a.crdt)).not.toEqual(texts(b.crdt)); // diverged for good
  });

  it('a stalled SURVIVOR blocks the publish; the operator aborts and exorcises the stalled one instead', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b, c] = [w.tab('a.0'), w.tab('b.0'), w.tab('c.0')];
    addItems(a, 2, 'k');
    w.round();
    b.stalled = true;

    w.exorcise('c.0'); // b never replies
    expect(w.core.getStatus(0, 1).eviction).toEqual({ target: 'c.0', waitingFor: ['b.0'] });
    expect(w.core.getView().epoch).toBe(3); // nothing published
    expect(a.crdt.isAuthorHeld('c.0')).toBe(true);

    w.perform(w.core.abortEviction());
    expect(a.crdt.isAuthorHeld('c.0')).toBe(false); // released
    expect(c.crdt.getMembershipView().epoch).toBe(3);

    w.exorcise('b.0'); // the stalled survivor is the real problem
    expect(w.core.getView().evictedMembers.has('b.0')).toBe(true);
    expect(a.crdt.getMembershipView().evictedMembers.has('b.0')).toBe(true);
  });

  it('a lost prepare message is retried on the survivor\'s next hello', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b] = [w.tab('a.0'), w.tab('b.0')];
    addItems(a, 2, 'k');
    w.round();

    const result = w.core.startEviction('c.0');
    expect(result.ok).toBe(true); // the effects are DROPPED: nobody hears the prepare
    expect(a.crdt.isAuthorHeld('c.0')).toBe(false);

    w.hello(a); // a's next hello makes the coordinator ask a again
    w.hello(b);
    expect(w.core.getView().evictedMembers.get('c.0')).toBeDefined(); // both replied: published
    expect(a.crdt.getMembershipView().epoch).toBe(4);
  });

  it('a tab that missed the view catches up on its next hello (a stale epoch gets the view back)', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, c] = [w.tab('a.0'), w.tab('c.0')];
    w.round();
    w.dropViewFor.add('c.0'); // c answers the prepare but the published view never reaches it
    w.exorcise('b.0');
    expect(c.crdt.getMembershipView().epoch).toBe(3);
    expect(a.crdt.getMembershipView().epoch).toBe(4);
    expect(c.crdt.isAuthorHeld('b.0')).toBe(true); // c is still frozen on b, waiting for the view

    w.dropViewFor.clear();
    w.hello(c); // epoch 3 is stale: the coordinator answers with the current view
    expect(c.crdt.getMembershipView().epoch).toBe(4);
    expect(c.crdt.getMembershipView().evictedMembers.has('b.0')).toBe(true);
    expect(c.crdt.isAuthorHeld('b.0')).toBe(false); // installing the eviction view ended the hold
  });
  it('a payload is never reclaimed while ANY active member lacks the delete, through the whole exorcism', () => {
    const w = new World(['a.0', 'b.0', 'c.0']);
    const [a, b, c] = [w.tab('a.0'), w.tab('b.0'), w.tab('c.0')];
    const items = addItems(a, 4, 'z');
    w.round();
    const dels = items.map((op) => a.crdt.delete(op.id));
    // b has the deletes, c does not (c is merely slow, not stalled-forever)
    for (const op of dels) b.crdt.applyOp(op);
    w.hello(a);
    w.hello(b);
    w.hello(c);
    for (const tab of w.tabs) {
      expect(tab.crdt.getAllElements().filter((e) => e.payloadReclaimed)).toHaveLength(0);
    }
    // c catches up: now the frontier covers the deletes and everyone reclaims
    w.round();
    for (const tab of w.tabs) expect(tab.crdt.getGCStats().payloadsReclaimed).toBe(4);
  });
});
