/**
 * CRDT integration of membership and fencing (KER-030 to KER-033; requirements.md 9, 10).
 * Edit ops are fenced by AUTHOR + CUTOFF only (never by `op.epoch`). A replica that was never
 * given a membership view accepts every author, so a standalone replica works out of the box.
 */

import { describe, it, expect } from 'vitest';
import { CRDT } from '../src/crdt.js';
import { serializeVersionVector } from '../src/utils.js';
import type { MembershipView, Operation } from '../src/types.js';

const view = (active: string[], evicted: Array<[string, number]>, epoch: number): MembershipView => ({
  activeMembers: new Set(active),
  evictedMembers: new Map(evicted),
  epoch,
});

/** n operations written by a fresh replica `id`: each insert is anchored on the previous one. */
function chain(id: string, n: number): Operation<string>[] {
  const author = new CRDT<string>(id);
  const ops: Operation<string>[] = [];
  let anchor: Operation<string> | undefined;
  for (let i = 1; i <= n; i++) {
    anchor = author.insert(anchor?.id, `${id}-${i}`);
    ops.push(anchor);
  }
  return ops;
}

/** Everything observable that fencing must leave alone when it rejects an operation. */
function fingerprint(c: CRDT<string>): string {
  return JSON.stringify({
    elements: c.getAllElements(),
    vv: serializeVersionVector(c.getVV()),
    ops: c.getOps().map((o) => o.id),
    pending: c.getPendingCount(),
    clock: c.getLamportClock(),
  });
}

describe('a replica with no membership view accepts every author (open mode)', () => {
  it('applies operations from authors nobody told it about', () => {
    const r = new CRDT<string>('a.0');
    for (const op of chain('stranger.0', 3)) expect(r.applyOp(op).status).toBe('applied');
    expect(r.getSequence()).toHaveLength(3);
  });

  it('reports itself as the only member, at epoch 0, until a view is installed', () => {
    const r = new CRDT<string>('a.0');
    const v = r.getMembershipView();
    expect([...v.activeMembers]).toEqual(['a.0']);
    expect(v.evictedMembers.size).toBe(0);
    expect(v.epoch).toBe(0);
  });

  it('getMembershipView returns an independent copy', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [['c.0', 2]], 4));
    const copy = r.getMembershipView();
    copy.activeMembers.add('hacker');
    copy.evictedMembers.set('c.0', 99);
    copy.epoch = 50;
    const again = r.getMembershipView();
    expect(again.activeMembers.has('hacker')).toBe(false);
    expect(again.evictedMembers.get('c.0')).toBe(2);
    expect(again.epoch).toBe(4);
  });
});

describe('fencing by AUTHOR and CUTOFF in applyOp (KER-031)', () => {
  const members = view(['a.0', 'b.0'], [['c.0', 2]], 3);

  it('accepts operations from active members', () => {
    const r = new CRDT<string>('a.0', members);
    for (const op of chain('b.0', 3)) expect(r.applyOp(op).status).toBe('applied');
  });

  it('rejects an unknown author with status "fenced" and changes NOTHING (no VV, log, clock or buffer effect)', () => {
    const r = new CRDT<string>('a.0', members);
    r.applyOp(chain('b.0', 1)[0]);
    const before = fingerprint(r);
    const stranger = chain('z.0', 2);
    stranger[0] = { ...stranger[0], lamport: 5000 }; // a big Lamport time must not be absorbed either
    const result = r.applyOp(stranger[0]);
    expect(result).toEqual({ status: 'fenced', changed: false, unblocked: [], fenced: [] });
    expect(r.applyOp(stranger[1]).status).toBe('fenced');
    expect(fingerprint(r)).toBe(before);
  });

  it('accepts an evicted author up to and including its cutoff, rejects the next one', () => {
    const r = new CRDT<string>('a.0', members); // c.0 evicted with cutoff 2
    const ops = chain('c.0', 4);
    expect(r.applyOp(ops[0]).status).toBe('applied');
    expect(r.applyOp(ops[1]).status).toBe('applied'); // seq 2 == cutoff
    expect(r.applyOp(ops[2]).status).toBe('fenced'); // seq 3 > cutoff
    expect(r.applyOp(ops[3]).status).toBe('fenced');
    expect(r.getVV().get('c.0')).toBe(2);
  });

  it('cutoff 0 rejects every operation of that author', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [['c.0', 0]], 1));
    expect(r.applyOp(chain('c.0', 1)[0]).status).toBe('fenced');
    expect(r.getSequence()).toHaveLength(0);
  });

  it('an op beyond the cutoff is rejected even when its predecessors are missing (it is not buffered)', () => {
    const r = new CRDT<string>('a.0', members);
    const ops = chain('c.0', 5);
    expect(r.applyOp(ops[4]).status).toBe('fenced'); // seq 5, nothing before it applied
    expect(r.getPendingCount()).toBe(0);
  });

  it('an op within the cutoff whose predecessor is missing is BUFFERED, and applies when the predecessor arrives', () => {
    const r = new CRDT<string>('a.0', members);
    const ops = chain('c.0', 2);
    expect(r.applyOp(ops[1]).status).toBe('buffered');
    expect(r.getPendingCount()).toBe(1);
    const result = r.applyOp(ops[0]);
    expect(result.status).toBe('applied');
    expect(result.unblocked).toEqual([ops[1].id]);
    expect(r.getVV().get('c.0')).toBe(2);
  });

  it('never looks at op.epoch: an active author is accepted with any epoch, an evicted author is not rescued by one', () => {
    const r = new CRDT<string>('a.0', members); // current epoch 3
    const [b1, b2, b3] = chain('b.0', 3);
    expect(r.applyOp({ ...b1, epoch: 0 }).status).toBe('applied'); // stale epoch
    expect(r.applyOp({ ...b2, epoch: 999 }).status).toBe('applied'); // future epoch
    expect(r.applyOp({ ...b3, epoch: undefined }).status).toBe('applied'); // no epoch
    const beyond = chain('c.0', 3)[2];
    expect(r.applyOp({ ...beyond, epoch: 3 }).status).toBe('fenced'); // the current epoch does not help
    expect(r.applyOp({ ...beyond, epoch: 999 }).status).toBe('fenced');
  });

  it('a duplicate from an active author is still reported as a duplicate', () => {
    const r = new CRDT<string>('a.0', members);
    const [b1] = chain('b.0', 1);
    r.applyOp(b1);
    expect(r.applyOp(b1).status).toBe('duplicate');
  });
});

describe('the constructor takes an optional initial membership', () => {
  it('copies it: changing the original afterwards does not change the replica', () => {
    const v = view(['a.0'], [], 1);
    const r = new CRDT<string>('a.0', v);
    v.activeMembers.add('b.0');
    expect(r.getMembershipView().activeMembers.has('b.0')).toBe(false);
  });

  it('rejects a malformed view with a TypeError', () => {
    expect(() => new CRDT<string>('a.0', { activeMembers: ['a.0'], evictedMembers: new Map(), epoch: 0 } as unknown as MembershipView)).toThrow(TypeError);
    expect(() => new CRDT<string>('a.0', view(['a.0'], [['a.0', 1]], 0))).toThrow(TypeError); // active and evicted
  });
});

describe('updateMembership (KER-033)', () => {
  it('the first view is installed whatever its epoch (even 0), and fencing starts from then on', () => {
    const r = new CRDT<string>('a.0');
    expect(r.updateMembership(view(['a.0', 'b.0'], [], 0))).toBe(true);
    expect(r.applyOp(chain('z.0', 1)[0]).status).toBe('fenced');
    expect(r.applyOp(chain('b.0', 1)[0]).status).toBe('applied');
  });

  it('installs a view with a greater epoch, ignores an equal or lower one, and says which', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'b.0'], [], 2));
    expect(r.updateMembership(view(['a.0', 'b.0', 'd.0'], [], 3))).toBe(true);
    expect(r.getMembershipView().epoch).toBe(3);
    expect(r.updateMembership(view(['a.0'], [], 3))).toBe(false); // equal
    expect(r.updateMembership(view(['a.0'], [], 1))).toBe(false); // lower
    expect(r.getMembershipView()).toEqual(view(['a.0', 'b.0', 'd.0'], [], 3));
  });

  it('the epoch seen never decreases over a series of views in any order', () => {
    const r = new CRDT<string>('a.0');
    for (const epoch of [4, 2, 7, 7, 1, 9, 3]) r.updateMembership(view(['a.0'], [], epoch));
    expect(r.getMembershipView().epoch).toBe(9);
  });

  it('ignores a higher-epoch view that contradicts what it already knows (un-evicts, or changes a cutoff)', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [['c.0', 2]], 3));
    expect(r.updateMembership(view(['a.0', 'c.0'], [], 4))).toBe(false);
    expect(r.updateMembership(view(['a.0'], [['c.0', 9]], 4))).toBe(false);
    expect(r.getMembershipView()).toEqual(view(['a.0'], [['c.0', 2]], 3));
    expect(r.applyOp(chain('c.0', 3)[2]).status).toBe('fenced'); // still fenced at the old cutoff
  });

  it('throws TypeError for a malformed view and leaves the replica as it was', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [], 1));
    expect(() => r.updateMembership(null as unknown as MembershipView)).toThrow(TypeError);
    expect(() => r.updateMembership(view(['a.0'], [['a.0', 1]], 5))).toThrow(TypeError);
    expect(r.getMembershipView().epoch).toBe(1);
  });

  it('the FIRST view is validated too: a malformed one is rejected and the replica stays in open mode', () => {
    const r = new CRDT<string>('a.0'); // open mode: no view yet
    const bad: unknown[] = [
      null,
      { activeMembers: new Set(['a.0']), evictedMembers: new Map(), epoch: -1 },
      { activeMembers: new Set(['a.0']), evictedMembers: new Map(), epoch: 1.5 },
      { activeMembers: new Set(['a:x']), evictedMembers: new Map(), epoch: 1 },
      { activeMembers: new Set(['a.0']), evictedMembers: new Map([['a.0', 1]]), epoch: 1 },
      { activeMembers: ['a.0'], evictedMembers: new Map(), epoch: 1 },
    ];
    for (const v of bad) expect(() => r.updateMembership(v as MembershipView)).toThrow(TypeError);
    expect(r.getMembershipView().epoch).toBe(0);
    expect(r.applyOp(chain('stranger.0', 1)[0]).status).toBe('applied'); // still open mode: nothing was installed
  });

  it('after an eviction view, the evicted author is accepted up to the cutoff and no further', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'c.0'], [], 1));
    const ops = chain('c.0', 5);
    r.applyOp(ops[0]);
    r.updateMembership(view(['a.0'], [['c.0', 3]], 2));
    expect(r.applyOp(ops[1]).status).toBe('applied');
    expect(r.applyOp(ops[2]).status).toBe('applied');
    expect(r.applyOp(ops[3]).status).toBe('fenced');
    expect(r.applyOp(ops[4]).status).toBe('fenced');
    expect(r.getVV().get('c.0')).toBe(3);
  });

  it('removes buffered operations that the new view fences, and keeps the ones inside the cutoff', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'c.0'], [], 1));
    const ops = chain('c.0', 6);
    // c:1 is missing, so 2, 3, 5 and 6 wait in the buffer
    for (const i of [1, 2, 4, 5]) expect(r.applyOp(ops[i]).status).toBe('buffered');
    expect(r.getPendingCount()).toBe(4);

    r.updateMembership(view(['a.0'], [['c.0', 3]], 2)); // 5 and 6 are now beyond the cutoff
    expect(r.getPendingCount()).toBe(2); // only c:2 and c:3 remain

    const result = r.applyOp(ops[0]); // c:1 arrives
    expect(result.status).toBe('applied');
    expect(result.unblocked).toEqual([ops[1].id, ops[2].id]);
    expect(r.getVV().get('c.0')).toBe(3);
    expect(r.getPendingCount()).toBe(0);
  });

  it('a buffered op beyond the new cutoff is purged at once, and later ops beyond it are fenced on arrival', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'c.0'], [], 1));
    const ops = chain('c.0', 3);
    r.applyOp(ops[2]); // c:3 waits for c:1 and c:2
    r.updateMembership(view(['a.0'], [['c.0', 1]], 2)); // cutoff 1 allows only c:1
    expect(r.getPendingCount()).toBe(0); // c:3 was purged at once
    expect(r.applyOp(ops[0]).status).toBe('applied');
    expect(r.applyOp(ops[1]).status).toBe('fenced');
    expect(r.getVV().get('c.0')).toBe(1);
  });

  it('never un-applies an operation that was already applied before it was fenced', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'c.0'], [], 1));
    for (const op of chain('c.0', 4)) r.applyOp(op);
    r.updateMembership(view(['a.0'], [['c.0', 2]], 2)); // a (bad) cutoff below what is applied
    expect(r.getSequence()).toHaveLength(4);
    expect(r.getVV().get('c.0')).toBe(4);
  });

  it('emits membershipChanged once per installed view, and not for an ignored one', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [], 1));
    let count = 0;
    const listener = (): void => {
      count++;
    };
    r.on('membershipChanged', listener);
    r.updateMembership(view(['a.0', 'b.0'], [], 2));
    r.updateMembership(view(['a.0'], [], 2)); // ignored: same epoch
    r.updateMembership(view(['a.0', 'b.0'], [], 1)); // ignored: older
    expect(count).toBe(1);
    r.off('membershipChanged', listener);
    r.updateMembership(view(['a.0', 'b.0', 'c.0'], [], 3));
    expect(count).toBe(1);
  });

  it('the listener already sees the new view and the purged buffer', () => {
    const r = new CRDT<string>('a.0', view(['a.0', 'c.0'], [], 1));
    r.applyOp(chain('c.0', 3)[2]); // buffered
    let seen: { epoch: number; pending: number } | undefined;
    r.on('membershipChanged', () => {
      seen = { epoch: r.getMembershipView().epoch, pending: r.getPendingCount() };
    });
    r.updateMembership(view(['a.0'], [['c.0', 1]], 2));
    expect(seen).toEqual({ epoch: 2, pending: 0 });
  });
});

describe('local operations and membership', () => {
  it('local operations carry the current epoch (diagnostic only)', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [], 7));
    expect(r.insert(undefined, 'x').epoch).toBe(7);
    r.updateMembership(view(['a.0'], [], 9));
    expect(r.insert(undefined, 'y').epoch).toBe(9);
  });

  it('a local delete carries the current epoch too (diagnostic only)', () => {
    const r = new CRDT<string>('a.0', view(['a.0'], [], 6));
    const x = r.insert(undefined, 'x');
    expect(r.delete(x.id).epoch).toBe(6);
    r.updateMembership(view(['a.0'], [], 8));
    const y = r.insert(undefined, 'y');
    expect(r.delete(y.id).epoch).toBe(8);
  });

  it('a replica that is not in the view yet can still write (it is joining), and its own operations are not fenced', () => {
    const r = new CRDT<string>('new.0', view(['a.0'], [], 4));
    const op = r.insert(undefined, 'hello');
    expect(op.id).toBe('new.0:1');
    expect(r.getSequence().map((e) => e.value)).toEqual(['hello']);
  });

  it('a replica that learns it was evicted cannot create operations beyond its cutoff, and consumes no sequence number', () => {
    const r = new CRDT<string>('c.0');
    const first = r.insert(undefined, 'one');
    r.insert(first.id, 'two');
    r.updateMembership(view(['a.0'], [['c.0', 2]], 5)); // evicted with cutoff 2 = everything it has written
    const before = fingerprint(r);
    expect(() => r.insert(first.id, 'three')).toThrow(RangeError);
    expect(() => r.delete(first.id)).toThrow(RangeError);
    expect(fingerprint(r)).toBe(before);
    expect(r.getVV().get('c.0')).toBe(2);
  });

  it('an evicted replica may still create operations while its next seq is within its cutoff', () => {
    const r = new CRDT<string>('c.0');
    r.insert(undefined, 'one'); // c.0:1
    r.updateMembership(view(['a.0'], [['c.0', 3]], 5)); // cutoff 3: seq 2 and 3 are still accepted by survivors
    expect(r.insert(undefined, 'two').id).toBe('c.0:2');
    expect(r.insert(undefined, 'three').id).toBe('c.0:3');
    expect(() => r.insert(undefined, 'four')).toThrow(RangeError); // seq 4 > cutoff 3
  });
});
