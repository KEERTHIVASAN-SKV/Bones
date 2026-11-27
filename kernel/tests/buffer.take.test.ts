/**
 * takeBufferedOp: remove ONE specific operation from the buffer and keep the `waiting` index
 * consistent. Used when a held author is released (the next operation in line is taken out and
 * applied through the normal pipeline).
 */

import { describe, it, expect } from 'vitest';
import { bufferOp, createOperationBuffer, takeBufferedOp } from '../src/buffer.js';
import { createOpId } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';

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
const never = (): boolean => false;

describe('takeBufferedOp', () => {
  it('removes and returns the operation', () => {
    const b = createOperationBuffer<string>();
    const op = ins('r1', 2, undefined);
    bufferOp(b, op, never);
    expect(takeBufferedOp(b, op.id)).toBe(op);
    expect(b.ops.has(op.id)).toBe(false);
  });

  it('returns undefined for an operation that is not buffered, and changes nothing', () => {
    const b = createOperationBuffer<string>();
    const other = ins('r1', 2, undefined);
    bufferOp(b, other, never);
    expect(takeBufferedOp(b, createOpId('r9', 1))).toBeUndefined();
    expect(b.ops.size).toBe(1);
  });

  it('removes the op from the waiting index of the element it was waiting for (an insert\'s anchor)', () => {
    const b = createOperationBuffer<string>();
    const anchor = createOpId('r2', 1);
    const op = ins('r1', 1, anchor);
    bufferOp(b, op, never);
    expect(b.waiting.get(anchor)?.has(op.id)).toBe(true);
    takeBufferedOp(b, op.id);
    expect(b.waiting.has(anchor)).toBe(false); // an empty entry is dropped, not left behind
  });

  it('removes a delete from the waiting index of its target', () => {
    const b = createOperationBuffer<string>();
    const target = createOpId('r2', 1);
    const op = del('r1', 1, target);
    bufferOp(b, op, never);
    takeBufferedOp(b, op.id);
    expect(b.waiting.has(target)).toBe(false);
  });

  it('keeps the other waiters of the same element in the index', () => {
    const b = createOperationBuffer<string>();
    const anchor = createOpId('r2', 1);
    const first = ins('r1', 1, anchor);
    const second = ins('r3', 1, anchor);
    bufferOp(b, first, never);
    bufferOp(b, second, never);
    takeBufferedOp(b, first.id);
    expect([...(b.waiting.get(anchor) ?? [])]).toEqual([second.id]);
    expect(b.ops.has(second.id)).toBe(true);
  });

  it('an op with no dependency (insert at the head) has no waiting entry to clean up', () => {
    const b = createOperationBuffer<string>();
    const op = ins('r1', 3, undefined);
    bufferOp(b, op, never);
    expect(() => takeBufferedOp(b, op.id)).not.toThrow();
    expect(b.waiting.size).toBe(0);
  });

  it('does not touch the cached `missing` list (it is rebuilt on demand)', () => {
    const b = createOperationBuffer<string>();
    const op = ins('r1', 3, undefined);
    bufferOp(b, op, never);
    b.missing.set('r1', new Set([1, 2]));
    takeBufferedOp(b, op.id);
    expect([...(b.missing.get('r1') ?? [])]).toEqual([1, 2]);
  });
});
