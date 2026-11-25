/**
 * The CRDT orchestrator (design.md Algorithm 3; KER-030 to KER-032, in progress).
 *
 * One replica: an RGA, a version vector, an operation log, a dependency buffer and a Lamport
 * clock. Local operations and remote operations go through the SAME pipeline (`applyOp`), so a
 * replica never has a second, subtly different way of applying an operation.
 *
 * Implemented so far: local insert/delete, the applyOp pipeline (validate, fence [stub],
 * suppress duplicates, buffer, apply, drain), the queries below, and events.
 * Not implemented yet (separate tasks): membership and real fencing, stable frontier and GC,
 * snapshots and rejoin.
 *
 * Kernel purity: no clocks, randomness or I/O; the only "time" is the Lamport clock.
 */

import type { Element, OpIdKey, Operation, OperationBuffer, VersionVector } from './types.js';
import { assertValidOperation, isValidReplicaId, MAX_LAMPORT, parseOpId } from './utils.js';
import { advanceContiguous } from './vv.js';
import { bufferOp, createOperationBuffer, takeReadyFromBuffer } from './buffer.js';
import { appendOp, createOpLog, getAllOps } from './oplog.js';
import type { OpLog } from './oplog.js';
import { EventEmitter } from './events.js';
import type { EventCallback, EventType } from './events.js';
import {
  applyDelete,
  applyInsert,
  createRGA,
  delete_,
  getSequence,
  insert,
  isElementDeleted,
} from './rga.js';
import type { RGAState } from './rga.js';

/** Outcome of `applyOp`. */
export interface ApplyResult {
  /**
   * - `applied`: the operation was applied (and possibly unblocked buffered ones)
   * - `buffered`: a dependency is missing; held back, never dropped, VV not advanced
   * - `duplicate`: already applied or already buffered; nothing changed
   * - `fenced`: rejected because its author is not allowed to write (membership; not enforced yet)
   */
  status: 'applied' | 'buffered' | 'duplicate' | 'fenced';
  /** True if the visible/structural state changed (false e.g. for a no-op delete). */
  changed: boolean;
  /** Buffered operations that were applied as a consequence of this call, in application order. */
  unblocked: OpIdKey[];
  /** Buffered operations rejected during this call because they became fenced. */
  fenced: OpIdKey[];
}

/**
 * One CRDT replica holding an ordered sequence of values of type T.
 *
 * @template T Payload type; treated as immutable by the kernel
 */
export class CRDT<T = unknown> {
  /** This replica's ID (e.g. `site1.0`). A returning evicted replica must use a NEW one. */
  readonly replicaId: string;

  private readonly rga: RGAState<T> = createRGA<T>();
  private vv: VersionVector = new Map();
  private readonly buffer: OperationBuffer<T> = createOperationBuffer<T>();
  private readonly log: OpLog<T> = createOpLog<T>();
  private readonly events = new EventEmitter();
  private lamportClock = 0;

  /**
   * Fencing hook. Stub: accepts everything until membership exists (call site is final).
   * Real rule (requirements.md 10.0): accept if the author is active, or evicted with
   * `seq <= cutoff`. Never consults `op.epoch`.
   */
  private readonly isFenced: (op: Operation<T>) => boolean = () => false;

  /**
   * @param replicaId - Unique ID of this replica; letters, digits, `_`, `-` and `.` only
   * @throws TypeError if the ID is empty or contains characters that cannot appear in an Op ID
   */
  constructor(replicaId: string) {
    if (!isValidReplicaId(replicaId)) {
      throw new TypeError(`CRDT: invalid replicaId "${replicaId}" (use letters, digits, "_", "-" and ".")`);
    }
    this.replicaId = replicaId;
  }

  // ==================== Local operations ====================

  /**
   * Insert a value immediately after `anchorId` (or at the start when undefined).
   * Creates the operation, applies it to this replica through `applyOp`, and returns it so the
   * caller can broadcast it.
   *
   * @param anchorId - Element to insert after; undefined = start of the sequence
   * @param value - Payload
   * @returns The operation to broadcast to other replicas
   * @throws RangeError if `anchorId` is not an element of this replica (nothing is changed)
   */
  insert(anchorId: OpIdKey | undefined, value: T): Operation<T> {
    if (anchorId !== undefined && !this.rga.elements.has(anchorId)) {
      throw new RangeError(`insert: unknown anchor ${anchorId}`);
    }
    this.assertClockHasRoom();
    const { operation } = insert<T>({
      replicaId: this.replicaId,
      anchor: anchorId,
      value,
      clock: this.lamportClock,
      seq: this.vv.get(this.replicaId) ?? 0,
      epoch: 0, // membership epoch: diagnostic only, wired up with membership
    });
    this.applyLocal(operation);
    return operation;
  }

  /**
   * Delete an element (it becomes a tombstone; the structure and anchors are kept).
   * Deleting an already deleted element is allowed: it produces a logged no-op operation.
   *
   * @param elementId - Element to delete
   * @returns The operation to broadcast to other replicas
   * @throws RangeError if `elementId` is not an element of this replica (nothing is changed)
   */
  delete(elementId: OpIdKey): Operation<T> {
    if (!this.rga.elements.has(elementId)) {
      throw new RangeError(`delete: unknown element ${elementId}`);
    }
    this.assertClockHasRoom();
    const { operation } = delete_({
      replicaId: this.replicaId,
      target: elementId,
      clock: this.lamportClock,
      seq: this.vv.get(this.replicaId) ?? 0,
      epoch: 0,
    }) as { operation: Operation<T> };
    this.applyLocal(operation);
    return operation;
  }

  /**
   * A new local operation gets lamport `clock + 1`, which must stay within MAX_LAMPORT (other
   * replicas reject anything larger). Called before an operation is created, so a refusal
   * changes nothing and consumes no sequence number.
   */
  private assertClockHasRoom(): void {
    if (this.lamportClock >= MAX_LAMPORT) {
      throw new RangeError('CRDT: Lamport clock exhausted (reached MAX_LAMPORT); no more local operations');
    }
  }

  private applyLocal(operation: Operation<T>): void {
    const result = this.applyOp(operation);
    if (result.status !== 'applied') {
      // Cannot happen: the anchor/target exists and seq = VV + 1. Fail loudly, never silently.
      throw new Error(`CRDT: local operation ${operation.id} was ${result.status}`);
    }
  }

  // ==================== Remote operations ====================

  /**
   * Apply an operation from any replica (design.md Algorithm 3):
   * 1. validate its structure (`assertValidOperation`)
   * 2. fencing (stub)
   * 3. suppress duplicates: `seq <= VV[author]`, or already buffered
   * 4. if not ready (earlier seq, anchor or target missing): buffer it, never drop it
   * 5. apply it, log it, advance the VV (also for no-ops), absorb its Lamport time
   * 6. drain: apply every buffered op this unblocked, with an iterative queue (no recursion)
   *
   * Emits `sequenceChanged` at most once per call.
   *
   * @param op - The operation
   * @returns What happened to it (see {@link ApplyResult})
   * @throws TypeError if the operation is malformed (state is untouched)
   */
  applyOp(op: Operation<T>): ApplyResult {
    assertValidOperation(op);
    const parsed = parseOpId(op.id) as { replicaId: string; seq: number };

    if (this.isFenced(op)) {
      return { status: 'fenced', changed: false, unblocked: [], fenced: [] };
    }

    if (parsed.seq <= (this.vv.get(parsed.replicaId) ?? 0) || this.buffer.ops.has(op.id)) {
      return { status: 'duplicate', changed: false, unblocked: [], fenced: [] };
    }

    if (!this.isReady(op)) {
      bufferOp(this.buffer, op, (id) => this.rga.elements.has(id));
      return { status: 'buffered', changed: false, unblocked: [], fenced: [] };
    }

    const checks = {
      isReady: (candidate: Operation<T>) => this.isReady(candidate),
      isFenced: (candidate: Operation<T>) => this.isFenced(candidate),
    };
    const queue: Operation<T>[] = [op];
    const unblocked: OpIdKey[] = [];
    const fenced: OpIdKey[] = [];
    let changed = false;
    for (let head = 0; head < queue.length; head++) {
      const next = queue[head];
      if (this.applyReadyOp(next)) changed = true;
      if (next !== op) unblocked.push(next.id);
      for (const ready of takeReadyFromBuffer(this.buffer, next, checks, fenced)) queue.push(ready);
    }

    if (changed) this.events.emit('sequenceChanged');
    return { status: 'applied', changed, unblocked, fenced };
  }

  /** Ready = it is the author's next seq AND its anchor (insert) / target (delete) is applied. */
  private isReady(op: Operation<T>): boolean {
    const parsed = parseOpId(op.id);
    if (parsed === null) return false;
    if (parsed.seq !== (this.vv.get(parsed.replicaId) ?? 0) + 1) return false;
    if (op.type === 'insert') return op.anchor === undefined || this.rga.elements.has(op.anchor);
    return op.target !== undefined && this.rga.elements.has(op.target);
  }

  /** Apply one ready op: RGA, log, version vector and clock. Returns whether state changed. */
  private applyReadyOp(op: Operation<T>): boolean {
    const changed = op.type === 'insert' ? applyInsert(this.rga, op) : applyDelete(this.rga, op);

    // ALWAYS, whether or not state changed. A no-op (e.g. a second concurrent delete of the same
    // element) is still an applied op: skipping it would leave VV[author] one short, and every
    // later op from that author would wait in the buffer forever.
    appendOp(this.log, op);
    const parsed = parseOpId(op.id) as { replicaId: string; seq: number };
    this.vv = advanceContiguous(this.vv, parsed.replicaId, parsed.seq);
    // Absorb the Lamport time. This is what makes a later local insert NEWER than everything
    // this replica has seen, so it sorts first among its siblings (lands right after its anchor).
    this.lamportClock = Math.max(this.lamportClock, op.lamport);
    return changed;
  }

  // ==================== Queries (read-only; return copies) ====================

  /**
   * The visible sequence: non-deleted elements in order.
   *
   * @returns Copies of the elements
   */
  getSequence(): Element<T>[] {
    return getSequence(this.rga);
  }

  /**
   * The version vector: highest contiguous applied seq per replica.
   *
   * @returns A copy
   */
  getVV(): VersionVector {
    return new Map(this.vv);
  }

  /**
   * All applied operations in application order (a valid causal replay order).
   *
   * @returns A new array
   */
  getOps(): Operation<T>[] {
    return getAllOps(this.log);
  }

  /**
   * Number of operations waiting in the dependency buffer.
   *
   * @returns The count
   */
  getPendingCount(): number {
    return this.buffer.ops.size;
  }

  /**
   * This replica's Lamport clock: the highest Lamport time it has created or applied.
   *
   * @returns The clock value
   */
  getLamportClock(): number {
    return this.lamportClock;
  }

  /**
   * Whether an element is a tombstone.
   *
   * @param elementId - Element ID
   * @returns true if it exists and is deleted; false if it is live or unknown
   */
  isElementDeleted(elementId: OpIdKey): boolean {
    return isElementDeleted(this.rga, elementId);
  }

  // ==================== Events ====================

  /**
   * Register a listener. `sequenceChanged` fires at most once per local operation or `applyOp`
   * call, and only when the sequence actually changed.
   *
   * @param event - Event name
   * @param callback - Listener (registering the same function twice has no effect)
   */
  on(event: EventType, callback: EventCallback): void {
    this.events.on(event, callback);
  }

  /**
   * Remove a listener.
   *
   * @param event - Event name
   * @param callback - The function that was registered
   */
  off(event: EventType, callback: EventCallback): void {
    this.events.off(event, callback);
  }
}
