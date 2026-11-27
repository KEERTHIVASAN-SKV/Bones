/**
 * The CRDT orchestrator (design.md Algorithm 3; KER-030 to KER-032, in progress).
 *
 * One replica: an RGA, a version vector, an operation log, a dependency buffer and a Lamport
 * clock. Local operations and remote operations go through the SAME pipeline (`applyOp`), so a
 * replica never has a second, subtly different way of applying an operation.
 *
 * Implemented: local insert/delete, the applyOp pipeline (validate, fence by author + cutoff,
 * suppress duplicates, buffer, apply, drain), membership (`updateMembership`), the stable
 * frontier and Stage 1 GC with log redaction (`updateStableFrontier`), the queries below, and
 * events. Not implemented yet (separate task): snapshots and rejoin.
 *
 * Open mode: a replica that was never given a membership view accepts operations from every
 * author, so a standalone replica works without a coordinator. Fencing starts when the first
 * view is installed (constructor argument or `updateMembership`).
 *
 * Kernel purity: no clocks, randomness or I/O; the only "time" is the Lamport clock.
 */

import type {
  Element,
  GCStats,
  MembershipView,
  OpIdKey,
  Operation,
  OperationBuffer,
  VersionVector,
} from './types.js';
import {
  assertValidOperation,
  assertValidVersionVector,
  createOpId,
  isValidReplicaId,
  MAX_LAMPORT,
  mergeVersionVectors,
  parseOpId,
} from './utils.js';
import { advanceContiguous, isCausallyStable } from './vv.js';
import {
  bufferOp,
  createOperationBuffer,
  purgeFencedBuffered,
  takeBufferedOp,
  takeReadyFromBuffer,
} from './buffer.js';
import { appendOp, createOpLog, getAllOps, redactReclaimedPayloads } from './oplog.js';
import type { OpLog } from './oplog.js';
import { applyMembershipView, assertValidMembershipView, getMembership, isFenced as isFencedByView } from './membership.js';
import { buildGCStats, performStage1GC } from './gc.js';
import { EventEmitter } from './events.js';
import type { EventCallback, EventType } from './events.js';
import {
  applyDelete,
  applyInsert,
  createRGA,
  delete_,
  getAllElements,
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
   * - `fenced`: rejected because its author is not an active member and the operation is beyond
   *   the author's cutoff (or the author is unknown). Nothing at all changed: not the version
   *   vector, the log, the buffer nor the Lamport clock.
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

  /** The membership view in force; undefined = open mode (no view installed yet: accept every author). */
  private membership: MembershipView | undefined;
  /** The stable frontier this replica has been told about; only ever grows. */
  private frontier: VersionVector = new Map();
  /** Cumulative estimated payload bytes freed by Stage 1 GC (each payload counted once). */
  private bytesSaved = 0;
  /** Authors whose operations are held back (buffered, not applied): the eviction prepare phase. */
  private readonly held = new Set<string>();

  /**
   * @param replicaId - Unique ID of this replica; letters, digits, `_`, `-` and `.` only
   * @param initialMembership - Optional first membership view (copied). Without it the replica
   *   starts in open mode and accepts every author until `updateMembership` installs a view.
   * @throws TypeError if the ID is empty or contains characters that cannot appear in an Op ID,
   *   or if the membership view is malformed
   */
  constructor(replicaId: string, initialMembership?: MembershipView) {
    if (!isValidReplicaId(replicaId)) {
      throw new TypeError(`CRDT: invalid replicaId "${replicaId}" (use letters, digits, "_", "-" and ".")`);
    }
    this.replicaId = replicaId;
    if (initialMembership !== undefined) {
      assertValidMembershipView(initialMembership);
      this.membership = getMembership(initialMembership);
    }
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
   * @throws RangeError if `anchorId` is not an element of this replica, or if this replica was
   *   evicted and its next sequence number is beyond its cutoff (nothing is changed)
   */
  insert(anchorId: OpIdKey | undefined, value: T): Operation<T> {
    if (anchorId !== undefined && !this.rga.elements.has(anchorId)) {
      throw new RangeError(`insert: unknown anchor ${anchorId}`);
    }
    this.assertMayWrite();
    this.assertClockHasRoom();
    const { operation } = insert<T>({
      replicaId: this.replicaId,
      anchor: anchorId,
      value,
      clock: this.lamportClock,
      seq: this.vv.get(this.replicaId) ?? 0,
      epoch: this.currentEpoch(), // diagnostic only, never used for fencing
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
   * @throws RangeError if `elementId` is not an element of this replica, or if this replica was
   *   evicted and its next sequence number is beyond its cutoff (nothing is changed)
   */
  delete(elementId: OpIdKey): Operation<T> {
    if (!this.rga.elements.has(elementId)) {
      throw new RangeError(`delete: unknown element ${elementId}`);
    }
    this.assertMayWrite();
    this.assertClockHasRoom();
    const { operation } = delete_({
      replicaId: this.replicaId,
      target: elementId,
      clock: this.lamportClock,
      seq: this.vv.get(this.replicaId) ?? 0,
      epoch: this.currentEpoch(),
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

  /** The epoch of the view in force (0 in open mode). Put on local operations for diagnostics only. */
  private currentEpoch(): number {
    return this.membership?.epoch ?? 0;
  }

  /**
   * A replica that has been told it was evicted may only create operations up to its cutoff:
   * survivors would fence the rest, so creating them would only produce operations that can
   * never be accepted. A replica that is not in the view at all is just joining and may write.
   * Called before anything is created, so a refusal consumes no sequence number.
   */
  private assertMayWrite(): void {
    const cutoff = this.membership?.evictedMembers.get(this.replicaId);
    if (cutoff === undefined) return;
    if ((this.vv.get(this.replicaId) ?? 0) + 1 > cutoff) {
      throw new RangeError(
        `CRDT: replica "${this.replicaId}" was evicted (cutoff ${cutoff}); rejoin from a snapshot with a new replica ID`
      );
    }
  }

  /**
   * Edit-operation fencing (requirements.md 10.0): by AUTHOR and CUTOFF, read from the Op ID.
   * `op.epoch` is never consulted. Open mode (no view yet) fences nothing.
   */
  private isFenced(op: Operation<T>): boolean {
    if (this.membership === undefined) return false;
    const parsed = parseOpId(op.id);
    if (parsed === null) return true; // cannot happen after assertValidOperation; fail closed
    return isFencedByView(this.membership, parsed.replicaId, parsed.seq);
  }

  private applyLocal(operation: Operation<T>): void {
    const result = this.pipeline(operation, true);
    if (result.status !== 'applied') {
      // Cannot happen: the anchor/target exists and seq = VV + 1. Fail loudly, never silently.
      throw new Error(`CRDT: local operation ${operation.id} was ${result.status}`);
    }
  }

  // ==================== Remote operations ====================

  /**
   * Apply an operation from any replica (design.md Algorithm 3):
   * 1. validate its structure (`assertValidOperation`)
   * 2. fencing by author + cutoff (membership); a fenced operation changes nothing
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
    return this.pipeline(op, false);
  }

  /**
   * The one pipeline for local and remote operations. `local` is true only for an operation this
   * replica has just created itself: it skips the author fence (a replica that has not been added
   * to the view yet may still write; `assertMayWrite` already stopped an evicted one).
   */
  private pipeline(op: Operation<T>, local: boolean): ApplyResult {
    assertValidOperation(op);
    const parsed = parseOpId(op.id) as { replicaId: string; seq: number };

    if (!local && this.isFenced(op)) {
      return { status: 'fenced', changed: false, unblocked: [], fenced: [] };
    }

    if (parsed.seq <= (this.vv.get(parsed.replicaId) ?? 0) || this.buffer.ops.has(op.id)) {
      return { status: 'duplicate', changed: false, unblocked: [], fenced: [] };
    }

    if (!this.isReady(op)) {
      bufferOp(this.buffer, op, (id) => this.rga.elements.has(id));
      return { status: 'buffered', changed: false, unblocked: [], fenced: [] };
    }

    const { unblocked, fenced, changed } = this.applyAndDrain(op);
    if (changed) this.events.emit('sequenceChanged');
    return { status: 'applied', changed, unblocked, fenced };
  }

  /**
   * Apply one READY operation, then every buffered operation it unblocks, with an iterative
   * queue (no recursion). Does not emit events: the caller emits `sequenceChanged` once.
   */
  private applyAndDrain(first: Operation<T>): { unblocked: OpIdKey[]; fenced: OpIdKey[]; changed: boolean } {
    const checks = {
      isReady: (candidate: Operation<T>) => this.isReady(candidate),
      isFenced: (candidate: Operation<T>) => this.isFenced(candidate),
    };
    const queue: Operation<T>[] = [first];
    const unblocked: OpIdKey[] = [];
    const fenced: OpIdKey[] = [];
    let changed = false;
    for (let head = 0; head < queue.length; head++) {
      const next = queue[head];
      if (this.applyReadyOp(next)) changed = true;
      if (next !== first) unblocked.push(next.id);
      for (const ready of takeReadyFromBuffer(this.buffer, next, checks, fenced)) queue.push(ready);
    }
    return { unblocked, fenced, changed };
  }

  /**
   * Ready = it is the author's next seq AND its anchor (insert) / target (delete) is applied,
   * AND its author is not held (eviction prepare phase: a held author's operations wait).
   */
  private isReady(op: Operation<T>): boolean {
    const parsed = parseOpId(op.id);
    if (parsed === null) return false;
    if (this.held.has(parsed.replicaId)) return false;
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
   * Every element in structural order, INCLUDING tombstones (deleted elements). Use it for the
   * Graveyard panel; `getSequence()` returns only live elements.
   *
   * @returns Copies of all elements, each with `anchor`, `deleted`, `deletedAt`, `payloadReclaimed`
   */
  getAllElements(): Element<T>[] {
    return getAllElements(this.rga);
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
   * Operations a peer with version vector `remoteVV` may still be missing, in causal (log) order.
   * The log is already in causal order, so the result can be applied in the order given; the peer
   * drops any duplicate harmlessly. Operations still waiting in this replica's buffer are not
   * included (they are not applied here yet).
   *
   * Use it to catch a peer up: it sends its version vector, you answer with `opsSince(thatVV)`.
   * A transport that does not replay old messages (e.g. BroadcastChannel) needs this.
   *
   * @param remoteVV - The peer's version vector (a missing entry counts as 0)
   * @returns A new array of the operations with seq above the peer's entry for their author
   */
  opsSince(remoteVV: VersionVector): Operation<T>[] {
    return this.getOps().filter((op) => {
      const parsed = parseOpId(op.id) as { replicaId: string; seq: number };
      return parsed.seq > (remoteVV.get(parsed.replicaId) ?? 0);
    });
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

  // ==================== Membership, frontier and GC ====================

  /**
   * The membership view in force. In open mode (no view installed yet) this replica is its own
   * only member at epoch 0.
   *
   * @returns An independent copy: changing it never changes this replica
   */
  getMembershipView(): MembershipView {
    if (this.membership === undefined) {
      return { activeMembers: new Set([this.replicaId]), evictedMembers: new Map(), epoch: 0 };
    }
    return getMembership(this.membership);
  }

  /**
   * Install a membership view published by the coordinator (KER-033).
   *
   * The first view is always installed (even at epoch 0): from then on the replica fences by
   * author + cutoff. After that a view replaces the current one only if its epoch is greater and
   * it does not contradict what this replica knows (an evicted replica stays evicted with the
   * same cutoff; see `applyMembershipView`). Installing a view then REJECTS every buffered
   * operation that is now fenced (they are removed from the buffer), emits `membershipChanged`,
   * and never un-applies an operation that was already applied.
   *
   * @param newView - The published view (validated; copied)
   * @returns true if it was installed, false if it was ignored (old, equal or contradictory)
   * @throws TypeError if the view is malformed (the replica is unchanged)
   */
  updateMembership(newView: MembershipView): boolean {
    assertValidMembershipView(newView);
    let next: MembershipView;
    if (this.membership === undefined) {
      next = getMembership(newView);
    } else {
      const result = applyMembershipView(this.membership, newView);
      if (!result.applied) return false;
      next = result.view;
    }
    this.membership = next;
    purgeFencedBuffered(this.buffer, (op) => this.isFenced(op));
    // The eviction of a held author ends its hold (publish and reconcile, requirements.md 10.3):
    // what lies beyond the cutoff was just purged, what lies within it is applied now.
    let sequenceChanged = false;
    for (const author of [...this.held]) {
      if (next.evictedMembers.has(author) && this.releaseHeld(author).changed) sequenceChanged = true;
    }
    if (sequenceChanged) this.events.emit('sequenceChanged');
    this.events.emit('membershipChanged');
    return true;
  }

  /**
   * Eviction PREPARE phase (requirements.md 10.3): stop applying NEW operations from `authorId`
   * and report how many of its operations this replica has applied.
   *
   * From now on that author's operations are BUFFERED (never applied, never dropped; the
   * version vector entry stays frozen) until the hold ends: `releaseAuthor`, or the view that
   * evicts that author is installed. Without the hold, a survivor could apply one more of a live
   * target's operations after the coordinator read its version vector, keep an operation that
   * every other survivor fences, and diverge for good.
   *
   * @param authorId - The replica about to be evicted (not this replica)
   * @returns The CONTIGUOUS applied seq for that author at this moment (0 if none): the reply to
   *   the coordinator's `evict-prepare`. Operations waiting behind a gap are not counted.
   * @throws TypeError if the ID is not a valid replica ID
   * @throws RangeError if `authorId` is this replica (it never holds back its own operations)
   */
  holdAuthor(authorId: string): number {
    this.assertReplicaIdArgument(authorId);
    if (authorId === this.replicaId) throw new RangeError('CRDT: a replica cannot hold its own operations');
    this.held.add(authorId);
    return this.vv.get(authorId) ?? 0;
  }

  /**
   * Whether `authorId`'s operations are currently held back.
   *
   * @param authorId - A replica ID
   * @returns true between `holdAuthor` and the release
   */
  isAuthorHeld(authorId: string): boolean {
    return this.held.has(authorId);
  }

  /**
   * End a hold (for example when the coordinator aborts an eviction) and apply the held
   * operations that are ready, in order, through the normal pipeline. Operations that still wait
   * for a missing predecessor stay buffered. Does nothing for an author that is not held. (The
   * hold also ends by itself when the view that evicts the author is installed.)
   *
   * @param authorId - The replica to release
   * @returns The IDs of the operations applied by the release, in application order
   * @throws TypeError if the ID is not a valid replica ID
   */
  releaseAuthor(authorId: string): OpIdKey[] {
    this.assertReplicaIdArgument(authorId);
    const result = this.releaseHeld(authorId);
    if (result.changed) this.events.emit('sequenceChanged');
    return result.applied;
  }

  private assertReplicaIdArgument(id: string): void {
    if (typeof id !== 'string' || !isValidReplicaId(id)) {
      throw new TypeError(`CRDT: invalid replica ID ${String(id)}`);
    }
  }

  /** Drop the hold and apply what is ready. Emits no event; the caller does. */
  private releaseHeld(authorId: string): { applied: OpIdKey[]; changed: boolean } {
    if (!this.held.delete(authorId)) return { applied: [], changed: false };
    // Nothing fenced can be buffered here: `updateMembership` purges whenever a view is installed.
    const nextId = createOpId(authorId, (this.vv.get(authorId) ?? 0) + 1);
    const candidate = this.buffer.ops.get(nextId);
    if (candidate === undefined || !this.isReady(candidate)) return { applied: [], changed: false };
    takeBufferedOp(this.buffer, nextId);
    const { unblocked, changed } = this.applyAndDrain(candidate);
    return { applied: [candidate.id, ...unblocked], changed };
  }

  /**
   * Tell this replica the stable frontier, then reclaim every payload that became safe to
   * reclaim (KER-033; requirements.md 11.8 and 12; design.md Algorithm 6 and decision D-A).
   *
   * The frontier is applied only if `epoch` equals this replica's CURRENT epoch: a frontier
   * computed for another membership view must not authorize reclamation. It is merged into the
   * frontier already held by taking the larger value per replica, so the frontier never moves
   * backwards. Reclaiming drops the payload from the sequence AND from the matching insert in
   * the operation log, then emits `gcEvent` once if anything was reclaimed. It changes neither
   * the version vector, the Lamport clock nor the visible sequence.
   *
   * Safe only if the frontier was computed from honest acknowledgements (requirements.md 11).
   *
   * @param frontier - The coordinator's stable frontier (validated; copied)
   * @param epoch - The membership epoch the frontier was computed for
   * @returns true if applied; false if ignored because of a stale or future (or malformed) epoch
   * @throws TypeError if the frontier is not a well-formed version vector (the replica is unchanged)
   */
  updateStableFrontier(frontier: VersionVector, epoch: number): boolean {
    assertValidVersionVector(frontier);
    if (epoch !== this.currentEpoch()) return false;

    this.frontier = mergeVersionVectors(this.frontier, frontier);
    const { reclaimed, bytesReclaimed } = performStage1GC(this.rga, this.frontier);
    if (reclaimed.length > 0) {
      redactReclaimedPayloads(this.log, reclaimed);
      this.bytesSaved += bytesReclaimed;
      this.events.emit('gcEvent');
    }
    return true;
  }

  /**
   * Whether an operation is at or below the stable frontier this replica holds (every active
   * member has applied it).
   *
   * @param opId - The operation's ID
   * @returns true if causally stable; false if not, or if the ID is malformed
   */
  isCausallyStable(opId: OpIdKey): boolean {
    return isCausallyStable(opId, this.frontier);
  }

  /**
   * The stable frontier this replica holds (starts empty; only grows).
   *
   * @returns A copy
   */
  getStableFrontier(): VersionVector {
    return new Map(this.frontier);
  }

  /**
   * Statistics for the Graveyard panel. `tombstoneCount` includes tombstones whose payload was
   * reclaimed: Stage 1 keeps the structure, so that count never goes down. `bytesSaved` counts
   * each reclaimed payload once (the sequence and the log share one object, and GC drops both).
   *
   * @returns A fresh GCStats
   */
  getGCStats(): GCStats {
    return buildGCStats(this.rga, this.bytesSaved, this.membership?.evictedMembers.size ?? 0, this.frontier);
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
