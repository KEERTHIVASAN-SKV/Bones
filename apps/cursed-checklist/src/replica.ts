import { CRDT } from '@bones/kernel';

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
 */
export function newReplicaId(): string {
  return `tab-${crypto.randomUUID().slice(0, 8)}.0`;
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
 * else are ignored (see sync.ts), so the UI only ever renders `{ text: string }`.
 */
export function isItem(value: unknown): value is Item {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_ITEM_LENGTH;
}
