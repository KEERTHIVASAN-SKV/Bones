import { CRDT, isValidReplicaId } from '@bones/kernel';
import type { Element } from '@bones/kernel';

/** A checklist item: the value stored in each CRDT element. */
export interface Item {
  text: string;
}

/** Longest item text accepted from the input box or from another tab. */
export const MAX_ITEM_LENGTH = 200;

/**
 * A new replica ID for this page load: `tab-<8 hex>.0` (`.0` is the incarnation).
 *
 * Never stored (no localStorage): a tab that reloads has lost its state, and reusing the old ID
 * would make it issue Op IDs that already exist, which other tabs would drop as duplicates and
 * silently diverge (README "Known limitations").
 *
 * Uses `crypto.getRandomValues`, which works on plain `http://` pages (for example a LAN IP while
 * testing on a phone). `crypto.randomUUID` exists only in secure contexts and would throw there.
 */
export function newReplicaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `tab-${hex}.0`;
}

/**
 * The ID a tab takes when it rejoins after being exorcised: the next incarnation of its old one
 * (`tab-1a2b3c4d.0` becomes `tab-1a2b3c4d.1`). The old ID stays evicted for good and the new one
 * starts its own sequence at 1, so no Op ID is ever reused.
 *
 * @param replicaId - The exorcised tab's ID
 * @returns The next incarnation, or a fresh random ID if `replicaId` does not end in `.<number>`
 *   (or the next number is not a safe integer)
 */
export function nextIncarnation(replicaId: string): string {
  const match = /^(.+)\.(\d+)$/.exec(replicaId);
  if (match !== null) {
    const next = Number(match[2]) + 1;
    if (Number.isSafeInteger(next)) {
      const id = `${match[1]}.${next}`;
      if (isValidReplicaId(id)) return id;
    }
  }
  return newReplicaId();
}

/**
 * The one CRDT for this page load.
 *
 * @param replicaId - Defaults to a fresh {@link newReplicaId}; tests pass a fixed one
 */
export function createReplica(replicaId: string = newReplicaId()): CRDT<Item> {
  return new CRDT<Item>(replicaId);
}

/**
 * True if a value received from another tab is a well-formed item. Operations carrying anything
 * else are still applied (dropping one would leave a gap in its author's sequence and stall every
 * later op from that author), but {@link visibleItems} hides them, so the UI only ever renders
 * `{ text: string }`.
 */
export function isItem(value: unknown): value is Item {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_ITEM_LENGTH;
}

/** A live CRDT element whose value has been checked to be an {@link Item}. */
export type ItemElement = Element<Item> & { value: Item };

/**
 * The elements the UI renders: live (not deleted) elements, in sequence order, whose value is a
 * well-formed {@link Item}. Elements with any other value stay in the CRDT (later ops may be
 * anchored on them) and are only hidden here.
 *
 * @param crdt - The replica to read
 * @returns Copies of the visible elements
 */
export function visibleItems(crdt: CRDT<Item>): ItemElement[] {
  return crdt.getSequence().filter((e): e is ItemElement => isItem(e.value));
}