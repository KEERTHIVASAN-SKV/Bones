/**
 * Dependency-buffer tests (design.md Algorithm 3 helpers; requirements.md section 6).
 * The buffer holds operations whose dependencies are not applied yet. It never drops an
 * operation by itself; the only removals are "now ready" (handed back to be applied) and
 * "now fenced" (explicit rejection).
 */

import { describe, it, expect } from 'vitest';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import {
  bufferOp,
  createOperationBuffer,
  DEFAULT_MISSING_LIMIT,
  purgeFencedBuffered,
  refreshMissing,
  takeReadyFromBuffer,
} from '../src/buffer.js';

const ins = (r: string, seq: number, anchor: OpIdKey | undefined): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'insert',
  anchor,
  value: `${r}${seq}`,
  lamport: seq,
  replicaId: r,
});
const del = (r: string, seq: number, target: OpIdKey): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'delete',
  target,
  lamport: seq,
  replicaId: r,
});

const never = () => false;
const always = () => true;
const sorted = (s: Set<number> | undefined): number[] => [...(s ?? [])].sort((a, b) => a - b);

describe('createOperationBuffer', () => {
  it('starts empty', () => {
    const b = createOperationBuffer<string>();
    expect(b.ops.size).toBe(0);
    expect(b.missing.size).toBe(0);
    expect(b.waiting.size).toBe(0);
  });
});

describe('bufferOp', () => {
  it('stores the op by Op ID and indexes the absent anchor it waits for', () => {
    const b = createOperationBuffer<string>();
    const op = ins('r1', 2, createOpId('r1', 1));
    bufferOp(b, op, never);
    expect(b.ops.get(op.id)).toBe(op);
    expect(b.waiting.get(createOpId('r1', 1))).toEqual(new Set([op.id]));
  });

  it('does not index a dependency that is already applied, or HEAD', () => {
    const b = createOperationBuffer<string>();
    bufferOp(b, ins('r1', 3, createOpId('r1', 1)), always); // anchor exists: blocked only by a missing seq
    bufferOp(b, ins('r2', 2, undefined), never); // HEAD anchor
    expect(b.ops.size).toBe(2);
    expect(b.waiting.size).toBe(0);
  });

  it('indexes the target of a delete', () => {
    const b = createOperationBuffer<string>();
    const op = del('r2', 1, createOpId('r1', 5));
    bufferOp(b, op, never);
    expect(b.waiting.get(createOpId('r1', 5))).toEqual(new Set([op.id]));
  });

  it('groups several waiters under one missing element', () => {
    const b = createOperationBuffer<string>();
    const a = ins('r2', 1, createOpId('r1', 1));
    const c = del('r3', 1, createOpId('r1', 1));
    bufferOp(b, a, never);
    bufferOp(b, c, never);
    expect(b.waiting.get(createOpId('r1', 1))).toEqual(new Set([a.id, c.id]));
  });

  it('buffering the same op twice keeps one entry', () => {
    const b = createOperationBuffer<string>();
    const op = ins('r1', 2, createOpId('r1', 1));
    bufferOp(b, op, never);
    bufferOp(b, op, never);
    expect(b.ops.size).toBe(1);
    expect(b.waiting.get(createOpId('r1', 1))!.size).toBe(1);
  });
});

describe('takeReadyFromBuffer', () => {
  const checks = (ready: (op: Operation<string>) => boolean, fenced: (op: Operation<string>) => boolean = never) => ({
    isReady: ready,
    isFenced: fenced,
  });

  it('returns and removes the author\'s next-seq op when it is ready', () => {
    const b = createOperationBuffer<string>();
    const next = ins('r1', 2, undefined);
    const other = ins('r1', 5, undefined);
    bufferOp(b, next, never);
    bufferOp(b, other, never);
    const fenced: OpIdKey[] = [];
    const taken = takeReadyFromBuffer(b, ins('r1', 1, undefined), checks(always), fenced);
    expect(taken).toEqual([next]); // after r1:1, only r1:2 is a candidate; r1:5 is not, even though isReady says yes
    expect(b.ops.has(next.id)).toBe(false);
    expect(b.ops.has(other.id)).toBe(true);
    expect(fenced).toEqual([]);
  });

  it('returns ops that were waiting for the element an applied insert created', () => {
    const b = createOperationBuffer<string>();
    const anchorOp = ins('r1', 1, undefined);
    const child = ins('r2', 1, anchorOp.id);
    const deleter = del('r3', 1, anchorOp.id);
    bufferOp(b, child, never);
    bufferOp(b, deleter, never);
    const taken = takeReadyFromBuffer(b, anchorOp, checks(always), []);
    expect(new Set(taken.map((o) => o.id))).toEqual(new Set([child.id, deleter.id]));
    expect(b.ops.size).toBe(0);
    expect(b.waiting.size).toBe(0);
  });

  it('an applied DELETE unblocks only its author\'s next seq, never anchor waiters', () => {
    const b = createOperationBuffer<string>();
    const waiter = ins('r2', 1, createOpId('r9', 9));
    bufferOp(b, waiter, never);
    const taken = takeReadyFromBuffer(b, del('r1', 1, createOpId('r1', 1)), checks(always), []);
    expect(taken).toEqual([]);
    expect(b.ops.has(waiter.id)).toBe(true);
  });

  it('leaves a candidate buffered when it is still blocked by its OTHER dependency, and finds it later', () => {
    const b = createOperationBuffer<string>();
    // r2:2 waits for r2:1 (seq) AND for the anchor r1:1
    const blocked = ins('r2', 2, createOpId('r1', 1));
    bufferOp(b, blocked, never);
    let seqOk = false;
    const ready = (op: Operation<string>) => op.id !== blocked.id || seqOk;

    // the anchor arrives first: candidate found through `waiting`, but its seq is still missing
    expect(takeReadyFromBuffer(b, ins('r1', 1, undefined), checks(ready), [])).toEqual([]);
    expect(b.ops.has(blocked.id)).toBe(true);
    // the anchor is applied now, so nothing waits for it any more, even though the op stays buffered
    expect(b.waiting.has(createOpId('r1', 1))).toBe(false);

    // then its predecessor r2:1 is applied: found through the next-seq lookup
    seqOk = true;
    const taken = takeReadyFromBuffer(b, ins('r2', 1, undefined), checks(ready), []);
    expect(taken).toEqual([blocked]);
    expect(b.ops.size).toBe(0);
  });

  it('removes a candidate that became fenced while it waited, reports it, and does not apply it', () => {
    const b = createOperationBuffer<string>();
    const evicted = ins('gone', 2, undefined);
    bufferOp(b, evicted, never);
    const fenced: OpIdKey[] = [];
    const taken = takeReadyFromBuffer(b, ins('gone', 1, undefined), checks(always, (op) => op.replicaId === 'gone'), fenced);
    expect(taken).toEqual([]);
    expect(fenced).toEqual([evicted.id]);
    expect(b.ops.size).toBe(0);
  });

  it('ignores stale waiting entries whose op is already gone', () => {
    const b = createOperationBuffer<string>();
    const anchorOp = ins('r1', 1, undefined);
    b.waiting.set(anchorOp.id, new Set([createOpId('ghost', 1)]));
    expect(takeReadyFromBuffer(b, anchorOp, checks(always), [])).toEqual([]);
  });

  it('removing a fenced op also removes it from the waiting index', () => {
    const b = createOperationBuffer<string>();
    const anchorId = createOpId('r1', 1);
    const evicted = ins('gone', 1, anchorId);
    bufferOp(b, evicted, never);
    purgeFencedBuffered(b, (op) => op.replicaId === 'gone');
    expect(b.waiting.size).toBe(0);
  });

  it('examines only directly affected ops: draining a reverse-delivered 5,000-op chain does O(n) readiness checks', () => {
    const n = 5000;
    const ops = Array.from({ length: n }, (_, i) => ins('r1', i + 1, i === 0 ? undefined : createOpId('r1', i)));
    const applied = new Set<OpIdKey>();
    let vv = 0;
    let readyChecks = 0;
    const isReady = (op: Operation<string>): boolean => {
      readyChecks++;
      const seq = Number(op.id.slice(op.id.lastIndexOf(':') + 1));
      return seq === vv + 1 && (op.anchor === undefined || applied.has(op.anchor));
    };
    const b = createOperationBuffer<string>();
    for (let i = n - 1; i >= 1; i--) bufferOp(b, ops[i], (id) => applied.has(id)); // everything but the first, in reverse

    // apply the first op, then drain with an iterative queue exactly as Algorithm 3 does
    const queue: Operation<string>[] = [ops[0]];
    for (let head = 0; head < queue.length; head++) {
      const op = queue[head];
      applied.add(op.id);
      vv++;
      for (const r of takeReadyFromBuffer(b, op, { isReady, isFenced: never }, [])) queue.push(r);
    }
    expect(queue).toHaveLength(n);
    expect(vv).toBe(n);
    expect(b.ops.size).toBe(0);
    expect(b.waiting.size).toBe(0);
    expect(readyChecks).toBeLessThanOrEqual(3 * n); // a full rescan per applied op would be ~n^2/2 = 12.5 million
  });
});

describe('purgeFencedBuffered', () => {
  it('removes every buffered op that is now fenced and returns their IDs; others stay', () => {
    const b = createOperationBuffer<string>();
    const keep = ins('r1', 3, undefined);
    const drop1 = ins('gone', 2, undefined);
    const drop2 = del('gone', 4, createOpId('r1', 1));
    for (const op of [keep, drop1, drop2]) bufferOp(b, op, never);
    const removed = purgeFencedBuffered(b, (op) => op.replicaId === 'gone');
    expect(new Set(removed)).toEqual(new Set([drop1.id, drop2.id]));
    expect([...b.ops.keys()]).toEqual([keep.id]);
    expect(b.waiting.size).toBe(0);
  });

  it('returns an empty list when nothing is fenced', () => {
    const b = createOperationBuffer<string>();
    bufferOp(b, ins('r1', 2, undefined), never);
    expect(purgeFencedBuffered(b, never)).toEqual([]);
    expect(b.ops.size).toBe(1);
  });
});

describe('refreshMissing (the `missing` field is a cache, refreshed on demand)', () => {
  it('lists, per replica, the unbuffered seqs between the VV and the highest buffered seq', () => {
    const b = createOperationBuffer<string>();
    for (const seq of [4, 7]) bufferOp(b, ins('r1', seq, undefined), never);
    bufferOp(b, ins('r2', 2, undefined), never);
    refreshMissing(b, new Map([['r1', 1]]));
    expect(sorted(b.missing.get('r1'))).toEqual([2, 3, 5, 6]);
    expect(sorted(b.missing.get('r2'))).toEqual([1]);
    expect(b.missing.size).toBe(2);
  });

  it('is rebuilt from scratch each time: stale entries disappear as the VV advances', () => {
    const b = createOperationBuffer<string>();
    bufferOp(b, ins('r1', 5, undefined), never);
    refreshMissing(b, new Map());
    expect(sorted(b.missing.get('r1'))).toEqual([1, 2, 3, 4]);
    refreshMissing(b, new Map([['r1', 3]]));
    expect(sorted(b.missing.get('r1'))).toEqual([4]);
    refreshMissing(b, new Map([['r1', 4]])); // seq 5 is now the next one: nothing is missing
    expect(b.missing.has('r1')).toBe(false);
  });

  it('ignores buffered ops whose seq is already covered by the VV', () => {
    const b = createOperationBuffer<string>();
    bufferOp(b, ins('r1', 2, undefined), never);
    refreshMissing(b, new Map([['r1', 5]]));
    expect(b.missing.size).toBe(0);
  });

  it('is empty for an empty buffer', () => {
    const b = createOperationBuffer<string>();
    b.missing.set('stale', new Set([1]));
    refreshMissing(b, new Map());
    expect(b.missing.size).toBe(0);
  });

  it('caps the list so a hostile huge seq cannot allocate billions of entries (lowest missing first)', () => {
    const b = createOperationBuffer<string>();
    bufferOp(b, ins('r1', 2_000_000_000, undefined), never);
    refreshMissing(b, new Map());
    const list = sorted(b.missing.get('r1'));
    expect(list).toHaveLength(DEFAULT_MISSING_LIMIT);
    expect(list[0]).toBe(1);
    expect(list[list.length - 1]).toBe(DEFAULT_MISSING_LIMIT);

    refreshMissing(b, new Map(), 3);
    expect(sorted(b.missing.get('r1'))).toEqual([1, 2, 3]);
  });
});
