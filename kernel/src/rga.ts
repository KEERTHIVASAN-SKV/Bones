/**
 * Replicated Growable Array (RGA) as an anchor tree.
 *
 * Every element is a child of its `anchor` (or of HEAD when the anchor is undefined).
 * The sequence order is the depth-first PRE-ORDER traversal of that tree. Children of
 * the same parent are kept NEWEST FIRST by the key `(lamport, replicaId)`: higher lamport
 * first; on equal lamport, higher replicaId first, compared by code unit.
 *
 * Consequences (design.md Algorithm 1):
 * - A local insert has the highest lamport its replica has seen, so it becomes the FIRST
 *   child of its anchor and lands immediately after it.
 * - An element's descendants always stay contiguous after it, so a concurrent sibling is
 *   never placed inside another sibling's subtree.
 * - The final tree depends only on the SET of applied inserts, not their arrival order.
 *
 * Kernel purity: no clocks, randomness, I/O or recursion (traversal uses an explicit stack
 * because typing a long string builds a chain as deep as the string).
 */

import type { Element, OpIdKey, Operation } from './types.js';
import { createOpId, compareOpIds, parseOpId } from './utils.js';

/** Key of a parent in the tree: an element ID, or 'HEAD' for top-level elements. */
export type ParentKey = OpIdKey | 'HEAD';

/**
 * RGA state. Mutated in place by the functions in this module; callers that need an
 * immutable view must copy (see `traverse`).
 */
export interface RGAState<T> {
  /** Every element, including tombstones, by Op ID. */
  readonly elements: Map<OpIdKey, Element<T>>;
  /** parent -> child IDs. Invariant: each list is sorted newest first. */
  readonly children: Map<ParentKey, OpIdKey[]>;
  /**
   * element -> every delete operation applied to it, INCLUDING no-op deletes (a second
   * delete of an already-deleted element). Stage 1 GC reclaims a payload when ANY of these
   * is causally stable (requirements.md 12.2).
   */
  readonly deleteOps: Map<OpIdKey, Set<OpIdKey>>;
}

/**
 * Create an empty RGA.
 *
 * @returns A new, empty RGAState
 */
export function createRGA<T>(): RGAState<T> {
  return { elements: new Map(), children: new Map(), deleteOps: new Map() };
}

/**
 * Compare two sibling elements by the RGA key `(lamport, replicaId)`.
 * Code-unit comparison only (never localeCompare). The Op ID string is a final tie-break
 * so the order stays total even for malformed input; for well-formed operations lamport
 * strictly increases per replica and it never decides anything.
 *
 * @returns > 0 when `a` is NEWER than `b`, < 0 when older, 0 only for the same element
 */
export function compareSiblingKeys<T>(a: Element<T>, b: Element<T>): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  const ra = replicaIdOf(a.id);
  const rb = replicaIdOf(b.id);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return compareOpIds(a.id, b.id);
}

function replicaIdOf(id: OpIdKey): string {
  const parsed = parseOpId(id);
  if (parsed === null) {
    throw new TypeError(`rga: malformed Op ID "${id}"`);
  }
  return parsed.replicaId;
}

/**
 * Create a local insert operation (design.md Algorithm 1, "Local operation creation").
 * Pure: it does not touch any RGA state; the caller applies the returned operation.
 *
 * Named fields (one options object) instead of positional numbers: `clock`, `seq` and
 * `epoch` are all plain numbers, and swapping them positionally compiles but silently
 * produces wrong Op IDs and Lamport values.
 *
 * @param p.replicaId - Author replica ID
 * @param p.anchor - Element to insert after; undefined = HEAD
 * @param p.value - Payload
 * @param p.clock - Current Lamport clock of this replica; the op's lamport is `clock + 1`
 * @param p.seq - Highest sequence number this replica has ALREADY issued; the op's seq is `seq + 1`
 * @param p.epoch - Current membership epoch (diagnostic only, never used for fencing)
 * @returns The operation and the new Lamport clock value
 */
export function insert<T>(p: {
  replicaId: string;
  anchor: OpIdKey | undefined;
  value: T;
  clock: number;
  seq: number;
  epoch: number;
}): { operation: Operation<T>; newLamport: number } {
  const newLamport = p.clock + 1;
  const operation: Operation<T> = {
    id: createOpId(p.replicaId, p.seq + 1),
    type: 'insert',
    anchor: p.anchor,
    value: p.value,
    lamport: newLamport,
    replicaId: p.replicaId,
    epoch: p.epoch,
  };
  return { operation, newLamport };
}

/**
 * Apply an insert operation (local or remote) to the RGA.
 *
 * Precondition (guaranteed by the orchestrator's readiness check): the anchor is HEAD or
 * already present. Violating it is a caller bug and throws, so a buffering mistake cannot
 * silently re-anchor an element to HEAD and break convergence.
 *
 * @param rga - RGA state (mutated)
 * @param op - An insert operation
 * @returns true if a new element was created; false if the element already existed (duplicate)
 * @throws TypeError if `op` is not an insert or its id is malformed
 * @throws RangeError if the anchor element is not in the RGA
 */
export function applyInsert<T>(rga: RGAState<T>, op: Operation<T>): boolean {
  if (op.type !== 'insert') {
    throw new TypeError(`applyInsert: expected an insert operation, got "${op.type}"`);
  }
  replicaIdOf(op.id); // validates the id format
  if (rga.elements.has(op.id)) return false;
  if (op.anchor !== undefined && !rga.elements.has(op.anchor)) {
    throw new RangeError(`applyInsert: anchor ${op.anchor} has not been applied; buffer the operation`);
  }

  const element: Element<T> = {
    id: op.id,
    anchor: op.anchor,
    lamport: op.lamport,
    value: op.value,
    deleted: false,
    payloadReclaimed: false,
  };
  rga.elements.set(op.id, element);

  // Insert into the parent's child list newest first: skip siblings that are NEWER.
  const parent: ParentKey = op.anchor ?? 'HEAD';
  let siblings = rga.children.get(parent);
  if (siblings === undefined) {
    siblings = [];
    rga.children.set(parent, siblings);
  }
  let pos = 0;
  while (pos < siblings.length && compareSiblingKeys(rga.elements.get(siblings[pos])!, element) > 0) {
    pos++;
  }
  siblings.splice(pos, 0, op.id);
  return true;
}

/**
 * Create a local delete operation (design.md Algorithm 2). Pure: the caller applies it.
 *
 * Same named-field convention as {@link insert}.
 *
 * @param p.replicaId - Author replica ID
 * @param p.target - Element to delete
 * @param p.clock - Current Lamport clock of this replica; the op's lamport is `clock + 1`
 * @param p.seq - Highest sequence number this replica has ALREADY issued; the op's seq is `seq + 1`
 * @param p.epoch - Current membership epoch (diagnostic only, never used for fencing)
 * @returns The operation and the new Lamport clock value
 */
export function delete_(p: {
  replicaId: string;
  target: OpIdKey;
  clock: number;
  seq: number;
  epoch: number;
}): { operation: Operation; newLamport: number } {
  const newLamport = p.clock + 1;
  const operation: Operation = {
    id: createOpId(p.replicaId, p.seq + 1),
    type: 'delete',
    target: p.target,
    lamport: newLamport,
    replicaId: p.replicaId,
    epoch: p.epoch,
  };
  return { operation, newLamport };
}

/**
 * Apply a delete operation: tombstone the target. The element keeps its place in the tree
 * (and its children), so it still works as an anchor.
 *
 * The delete is ALWAYS recorded in `rga.deleteOps`, even when it changes nothing (the
 * element was already deleted): Stage 1 GC reclaims when ANY delete of the element is stable.
 * `deletedAt` is the smallest delete Op ID applied so far (code-unit order), so concurrent
 * deletes yield the same value on every replica regardless of arrival order.
 *
 * Precondition (guaranteed by the orchestrator's readiness check): the target is present.
 *
 * @param rga - RGA state (mutated)
 * @param op - A delete operation
 * @returns true if the element went from visible to deleted; false for a no-op delete
 * @throws TypeError if `op` is not a delete or has no target
 * @throws RangeError if the target element is not in the RGA
 */
export function applyDelete<T>(rga: RGAState<T>, op: Operation<T>): boolean {
  if (op.type !== 'delete' || op.target === undefined) {
    throw new TypeError('applyDelete: expected a delete operation with a target');
  }
  const element = rga.elements.get(op.target);
  if (element === undefined) {
    throw new RangeError(`applyDelete: target ${op.target} has not been applied; buffer the operation`);
  }

  let ops = rga.deleteOps.get(op.target);
  if (ops === undefined) {
    ops = new Set();
    rga.deleteOps.set(op.target, ops);
  }
  ops.add(op.id);

  if (element.deleted) {
    if (element.deletedAt === undefined || compareOpIds(op.id, element.deletedAt) < 0) {
      element.deletedAt = op.id;
    }
    return false;
  }
  element.deleted = true;
  element.deletedAt = op.id;
  return true;
}

/**
 * The visible sequence: all non-deleted elements in sequence order.
 * Returns copies, so callers cannot corrupt the RGA by mutating them.
 *
 * @param rga - RGA state
 * @returns Copies of the non-deleted elements
 */
export function getSequence<T>(rga: RGAState<T>): Element<T>[] {
  return traverse(rga)
    .filter((element) => !element.deleted)
    .map((element) => ({ ...element }));
}

/**
 * Whether an element is a tombstone.
 *
 * @param rga - RGA state
 * @param elementId - Element Op ID
 * @returns true if the element exists and is deleted; false if it is live OR unknown
 */
export function isElementDeleted<T>(rga: RGAState<T>, elementId: OpIdKey): boolean {
  return rga.elements.get(elementId)?.deleted ?? false;
}

/**
 * Stage 1 GC primitive: drop the payload of a tombstone but keep its structural node
 * (id, anchor, lamport, children), so it still orders its subtree and anchors new inserts.
 * The visible sequence and the structural order are unchanged.
 *
 * Deciding WHEN this is safe (causal stability) is the GC module's job, not this function's.
 *
 * @param rga - RGA state (mutated)
 * @param elementId - Element whose payload to reclaim
 * @returns true if a payload was reclaimed; false if it had already been reclaimed
 * @throws RangeError if the element is unknown or not deleted (a live payload must never be dropped)
 */
export function markPayloadReclaimed<T>(rga: RGAState<T>, elementId: OpIdKey): boolean {
  const element = rga.elements.get(elementId);
  if (element === undefined || !element.deleted) {
    throw new RangeError(`markPayloadReclaimed: ${elementId} is unknown or not deleted`);
  }
  if (element.payloadReclaimed) return false;
  element.value = undefined;
  element.payloadReclaimed = true;
  return true;
}

/**
 * Depth-first pre-order traversal of the whole RGA, tombstones included.
 * Iterative (explicit stack): safe for chains of any depth.
 *
 * The returned array is new, but its elements are the RGA's own objects. Treat them as
 * read-only; the public CRDT API copies them before handing them to applications.
 *
 * @param rga - RGA state
 * @returns All elements in sequence order
 */
export function traverse<T>(rga: RGAState<T>): Element<T>[] {
  const out: Element<T>[] = [];
  const stack: OpIdKey[] = [];

  const pushChildrenReversed = (parent: ParentKey): void => {
    const kids = rga.children.get(parent);
    if (kids === undefined) return;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]); // first child ends on top
  };

  pushChildrenReversed('HEAD');
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(rga.elements.get(id)!);
    pushChildrenReversed(id);
  }
  return out;
}
