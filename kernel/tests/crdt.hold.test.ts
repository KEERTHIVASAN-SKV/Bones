/**
 * Eviction PREPARE phase (requirements.md 10.3): "each active member stops applying new ops from
 * the target and replies with its contiguous applied seq for the target". Without this a survivor
 * that applies one more of the target's operations after the coordinator has read its version
 * vector keeps an operation that every other survivor fences, and the survivors diverge for good.
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '../src/crdt.js';
import type { MembershipView, Operation } from '../src/types.js';

const view = (active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView => ({
  activeMembers: new Set(active),
  evictedMembers: new Map(evicted),
  epoch,
});
const MEMBERS = view(['a.0', 'b.0', 'c.0'], [], 1);

/** n operations by a fresh replica `id`, each insert anchored on the previous one. */
function chain(id: string, n: number): Operation<string>[] {
  const author = new CRDT<string>(id, MEMBERS);
  const ops: Operation<string>[] = [];
  for (let i = 1; i <= n; i++) ops.push(author.insert(ops[i - 2]?.id, `${id}-${i}`));
  return ops;
}
const texts = (c: CRDT<string>): string[] => c.getSequence().map((e) => e.value as string);

describe('holdAuthor', () => {
  it('returns the contiguous applied seq at that moment (0 for an author never heard from)', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    expect(r.holdAuthor('c.0')).toBe(0);
    const s = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 3);
    s.applyOp(ops[0]);
    s.applyOp(ops[1]);
    expect(s.holdAuthor('c.0')).toBe(2);
  });

  it('counts only the CONTIGUOUS prefix: an operation waiting behind a gap is not applied', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 4);
    r.applyOp(ops[0]);
    r.applyOp(ops[2]); // c:3 waits for c:2
    expect(r.holdAuthor('c.0')).toBe(1);
  });

  it('from then on the author\'s operations are BUFFERED, never applied and never dropped; the VV stays frozen', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 4);
    r.applyOp(ops[0]);
    const frozen = r.holdAuthor('c.0');
    const logBefore = r.getOps().length;

    for (const op of ops.slice(1)) expect(r.applyOp(op).status).toBe('buffered');
    expect(r.getVV().get('c.0')).toBe(frozen);
    expect(r.getOps()).toHaveLength(logBefore);
    expect(texts(r)).toEqual(['c.0-1']);
    expect(r.getPendingCount()).toBe(3);
  });

  it('a held operation delivered twice is a duplicate, not a second buffer entry', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const [c1] = chain('c.0', 1);
    r.holdAuthor('c.0');
    expect(r.applyOp(c1).status).toBe('buffered');
    expect(r.applyOp(c1).status).toBe('duplicate');
    expect(r.getPendingCount()).toBe(1);
  });

  it('other authors are not affected', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    r.holdAuthor('c.0');
    for (const op of chain('b.0', 3)) expect(r.applyOp(op).status).toBe('applied');
    expect(r.getVV().get('b.0')).toBe(3);
  });

  it('is idempotent and reports whether an author is held', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 2);
    r.applyOp(ops[0]);
    expect(r.isAuthorHeld('c.0')).toBe(false);
    expect(r.holdAuthor('c.0')).toBe(1);
    expect(r.holdAuthor('c.0')).toBe(1);
    expect(r.isAuthorHeld('c.0')).toBe(true);
    expect(r.isAuthorHeld('b.0')).toBe(false);
  });

  it('an operation of another author that depends on a held operation waits too, and applies after the release', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const b = new CRDT<string>('b.0', MEMBERS);
    const [c1] = chain('c.0', 1);
    b.applyOp(c1);
    const onTopOfC1 = b.insert(c1.id, 'b-on-c1');

    r.holdAuthor('c.0');
    r.applyOp(c1); // buffered
    expect(r.applyOp(onTopOfC1).status).toBe('buffered'); // its anchor is not applied here
    expect(texts(r)).toEqual([]);
    r.releaseAuthor('c.0');
    expect(texts(r)).toEqual(['c.0-1', 'b-on-c1']); // b's item was inserted right after c's
    expect(r.getVV().get('b.0')).toBe(1);
    expect(r.getPendingCount()).toBe(0);
  });

  it('cannot hold itself (a replica never holds back its own operations)', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    expect(() => r.holdAuthor('a.0')).toThrow(RangeError);
  });

  it.each([[''], ['a:1'], ['has space'], [5 as unknown as string]])('rejects the invalid replica ID %j', (id) => {
    expect(() => new CRDT<string>('a.0', MEMBERS).holdAuthor(id)).toThrow(TypeError);
  });

  it('works in open mode (no membership view) too', () => {
    const r = new CRDT<string>('a.0');
    expect(r.holdAuthor('c.0')).toBe(0);
    expect(r.applyOp(chain('c.0', 1)[0]).status).toBe('buffered');
  });
});

describe('releaseAuthor', () => {
  it('applies the held operations that are ready, in order, and returns their IDs', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 4);
    r.holdAuthor('c.0');
    for (const op of [ops[2], ops[0], ops[3], ops[1]]) r.applyOp(op); // out of order, all held
    expect(r.getPendingCount()).toBe(4);

    expect(r.releaseAuthor('c.0')).toEqual(ops.map((o) => o.id));
    expect(r.getVV().get('c.0')).toBe(4);
    expect(r.getPendingCount()).toBe(0);
    expect(texts(r)).toEqual(['c.0-1', 'c.0-2', 'c.0-3', 'c.0-4']);
    expect(r.isAuthorHeld('c.0')).toBe(false);
  });

  it('applies only the contiguous part when a gap remains, and keeps the rest buffered', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 5);
    r.holdAuthor('c.0');
    for (const op of [ops[0], ops[1], ops[3], ops[4]]) r.applyOp(op); // c:3 is missing
    expect(r.releaseAuthor('c.0')).toEqual([ops[0].id, ops[1].id]);
    expect(r.getVV().get('c.0')).toBe(2);
    expect(r.getPendingCount()).toBe(2);
    r.applyOp(ops[2]); // the missing one arrives: everything flows
    expect(r.getVV().get('c.0')).toBe(5);
  });

  it('does not throw and applies nothing when the next held operation still waits for an anchor from another author', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const b = new CRDT<string>('b.0', MEMBERS);
    const anchor = b.insert(undefined, 'b-first'); // r has not seen this
    const c = new CRDT<string>('c.0', MEMBERS);
    c.applyOp(anchor);
    const onAnchor = c.insert(anchor.id, 'c-on-b'); // c.0:1, anchored on b.0:1

    r.holdAuthor('c.0');
    expect(r.applyOp(onAnchor).status).toBe('buffered');
    let released: string[] = [];
    expect(() => {
      released = r.releaseAuthor('c.0');
    }).not.toThrow();
    expect(released).toEqual([]);
    expect(r.getPendingCount()).toBe(1);
    expect(r.getVV().get('c.0')).toBeUndefined();

    r.applyOp(anchor); // the anchor arrives: both apply
    expect(texts(r)).toEqual(['b-first', 'c-on-b']);
    expect(r.getPendingCount()).toBe(0);
    expect(r.getVV().get('c.0')).toBe(1);
  });

  it('fires sequenceChanged once when the released operations change the sequence', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    r.holdAuthor('c.0');
    for (const op of chain('c.0', 3)) r.applyOp(op);
    let events = 0;
    r.on('sequenceChanged', () => {
      events++;
    });
    r.releaseAuthor('c.0');
    expect(events).toBe(1);
  });

  it('after the release the author\'s operations apply normally again', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 2);
    r.holdAuthor('c.0');
    r.releaseAuthor('c.0');
    expect(r.applyOp(ops[0]).status).toBe('applied');
    expect(r.applyOp(ops[1]).status).toBe('applied');
  });

  it('releasing an author that is not held does nothing and does not throw', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 2);
    r.applyOp(ops[0]);
    expect(r.releaseAuthor('c.0')).toEqual([]);
    expect(r.releaseAuthor('nobody.0')).toEqual([]);
    expect(r.getVV().get('c.0')).toBe(1);
  });

  it.each([[''], ['a:1'], [5 as unknown as string]])('rejects the invalid replica ID %j', (id) => {
    expect(() => new CRDT<string>('a.0', MEMBERS).releaseAuthor(id)).toThrow(TypeError);
  });
});

describe('installing the eviction view ends the hold (requirements.md 10.3, publish and reconcile)', () => {
  it('applies the held operations within the cutoff, in order, and purges the ones beyond it', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 6);
    r.applyOp(ops[0]);
    r.holdAuthor('c.0'); // frozen at 1
    for (const op of ops.slice(1)) r.applyOp(op); // c:2..c:6 held
    expect(r.getPendingCount()).toBe(5);

    // another survivor had applied up to c:4, so the cutoff is 4
    expect(r.updateMembership(view(['a.0', 'b.0'], [['c.0', 4]], 2))).toBe(true);
    expect(r.isAuthorHeld('c.0')).toBe(false);
    expect(r.getVV().get('c.0')).toBe(4); // c:2..c:4 applied, c:5 and c:6 purged
    expect(r.getPendingCount()).toBe(0);
    expect(texts(r)).toEqual(['c.0-1', 'c.0-2', 'c.0-3', 'c.0-4']);
  });

  it('with cutoff = what was applied at hold time, everything held is purged and the VV is unchanged', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 5);
    r.applyOp(ops[0]);
    r.applyOp(ops[1]);
    const cutoff = r.holdAuthor('c.0');
    for (const op of ops.slice(2)) r.applyOp(op);
    r.updateMembership(view(['a.0', 'b.0'], [['c.0', cutoff]], 2));
    expect(r.getVV().get('c.0')).toBe(2);
    expect(r.getPendingCount()).toBe(0);
  });

  it('a held operation that still has a gap before it stays buffered inside the cutoff, and applies when backfilled', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 4);
    r.holdAuthor('c.0');
    r.applyOp(ops[3]); // only c:4 is held; c:1..c:3 are missing here
    r.updateMembership(view(['a.0', 'b.0'], [['c.0', 4]], 2));
    expect(r.getPendingCount()).toBe(1);
    for (const op of ops.slice(0, 3)) r.applyOp(op); // backfill from the other survivor
    expect(r.getVV().get('c.0')).toBe(4);
    expect(r.getPendingCount()).toBe(0);
  });

  it('a view that does NOT evict the held author keeps the hold, and an ignored view keeps it too', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'b.0', 'c.0'], [], 1));
    r.holdAuthor('c.0');
    expect(r.updateMembership(view(['a.0', 'b.0', 'c.0', 'd.0'], [], 2))).toBe(true);
    expect(r.isAuthorHeld('c.0')).toBe(true);
    expect(r.updateMembership(view(['a.0', 'b.0'], [['c.0', 0]], 2))).toBe(false); // same epoch: ignored
    expect(r.isAuthorHeld('c.0')).toBe(true);
  });

  it('the hold is released BEFORE membershipChanged fires, so the listener sees the final state', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 3);
    r.holdAuthor('c.0');
    for (const op of ops) r.applyOp(op);
    let seen: { held: boolean; vv: number; pending: number } | undefined;
    r.on('membershipChanged', () => {
      seen = { held: r.isAuthorHeld('c.0'), vv: r.getVV().get('c.0') ?? 0, pending: r.getPendingCount() };
    });
    r.updateMembership(view(['a.0', 'b.0'], [['c.0', 2]], 2));
    expect(seen).toEqual({ held: false, vv: 2, pending: 0 });
  });

  it('after the eviction the author is fenced beyond the cutoff as usual', () => {
    const r = new CRDT<string>('a.0', MEMBERS);
    const ops = chain('c.0', 4);
    r.holdAuthor('c.0');
    r.updateMembership(view(['a.0', 'b.0'], [['c.0', 2]], 2));
    expect(r.applyOp(ops[3]).status).toBe('fenced');
    expect(r.applyOp(ops[0]).status).toBe('applied');
    expect(r.applyOp(ops[1]).status).toBe('applied');
    expect(r.applyOp(ops[2]).status).toBe('fenced');
  });
});

describe('why the hold exists: without it, an operation applied after the ack splits the survivors', () => {
  it('two survivors, a live target: with a hold they agree, without one they diverge for good', () => {
    const ops = chain('c.0', 3);

    // WITHOUT a hold. Both survivors have c:1, c:2 when they acknowledge. Then c:3 reaches ONE of them.
    const noHold1 = new CRDT<string>('a.0', MEMBERS);
    const noHold2 = new CRDT<string>('b.0', MEMBERS);
    for (const s of [noHold1, noHold2]) for (const op of ops.slice(0, 2)) s.applyOp(op);
    const ackedCutoff = Math.max(noHold1.getVV().get('c.0') ?? 0, noHold2.getVV().get('c.0') ?? 0); // 2
    noHold1.applyOp(ops[2]); // arrives between the ack and the view
    const evicted = view(['a.0', 'b.0'], [['c.0', ackedCutoff]], 2);
    noHold1.updateMembership(evicted);
    noHold2.updateMembership(evicted);
    noHold2.applyOp(ops[2]); // fenced here: beyond the cutoff
    expect(texts(noHold1)).not.toEqual(texts(noHold2)); // diverged, and nothing can repair it

    // WITH a hold: both freeze at the prepare, c:3 is held on arrival, and the view purges it
    const hold1 = new CRDT<string>('a.0', MEMBERS);
    const hold2 = new CRDT<string>('b.0', MEMBERS);
    for (const s of [hold1, hold2]) for (const op of ops.slice(0, 2)) s.applyOp(op);
    const replies = [hold1.holdAuthor('c.0'), hold2.holdAuthor('c.0')];
    hold1.applyOp(ops[2]); // buffered, not applied
    const published = view(['a.0', 'b.0'], [['c.0', Math.max(...replies)]], 2);
    hold1.updateMembership(published);
    hold2.updateMembership(published);
    hold2.applyOp(ops[2]);
    expect(texts(hold1)).toEqual(texts(hold2));
    expect(hold1.getVV().get('c.0')).toBe(2);
    expect(hold2.getVV().get('c.0')).toBe(2);
  });
});
