/**
 * Rejoin across a page reload (DA-9). An exorcised tab that received a snapshot (rejoin.ts) does
 * not swap the replica under the running page. It stores the snapshot in `sessionStorage` and
 * reloads; on startup `createSessionReplica` finds it and builds the page's replica from it under
 * the next incarnation of the old ID (`tab-1a2b3c4d.0` -> `tab-1a2b3c4d.1`).
 *
 * Failure rules, because a wrong replica here would reuse Op IDs and diverge silently:
 * - The key is removed BEFORE it is used. If it cannot be removed, nothing is restored: a second
 *   reload must never restore the same snapshot again under the same ID.
 * - Anything wrong with the stored data (not JSON, wrong shape, a snapshot the kernel rejects, one
 *   that does not show the old ID as evicted, an ID the kernel refuses) gives a fresh random
 *   replica, exactly like a new tab. That loses nothing: a rejoining tab holds no operation the
 *   other tabs do not have, and it catches up by hello.
 */
import { CRDT, deserializeSnapshot, isValidReplicaId } from '@bones/kernel';
import type { Snapshot } from '@bones/kernel';
import { createReplica, nextIncarnation } from './replica';
import type { Item } from './replica';

/** The `sessionStorage` key that carries the snapshot from the old page load to the new one. */
export const REJOIN_STORAGE_KEY = 'bones-checklist-rejoin';

/** The part of `Storage` used here, so a test can pass a plain object. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * This tab's `sessionStorage` (it survives a reload of the tab and is not shared with other tabs).
 *
 * @returns The store, or undefined if the browser blocks it (reading it can throw)
 */
export function getSessionStore(): SessionStore | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Keep a validated snapshot for the next page load.
 *
 * @param store - Where to keep it
 * @param snapshot - A `serializeSnapshot` string that rejoin.ts has already validated
 * @param previousId - The exorcised tab's ID (the one the snapshot shows as evicted)
 * @returns true if it was stored; false if there is no store or it refused (quota, private mode)
 */
export function stashRejoin(store: SessionStore | undefined, snapshot: string, previousId: string): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(REJOIN_STORAGE_KEY, JSON.stringify({ snapshot, previousId }));
    return true;
  } catch {
    return false;
  }
}

/** The replica from a stored rejoin, or undefined if there is none or it is unusable (see the rules above). */
function takeRejoin(store: SessionStore | undefined): CRDT<Item> | undefined {
  if (store === undefined) return undefined;
  let raw: string | null;
  try {
    raw = store.getItem(REJOIN_STORAGE_KEY);
    if (raw === null) return undefined;
    store.removeItem(REJOIN_STORAGE_KEY); // before using it: see the module comment
  } catch {
    return undefined;
  }
  try {
    const stored: unknown = JSON.parse(raw);
    if (stored === null || typeof stored !== 'object') return undefined;
    const { snapshot, previousId } = stored as { snapshot?: unknown; previousId?: unknown };
    if (typeof snapshot !== 'string' || typeof previousId !== 'string' || !isValidReplicaId(previousId)) return undefined;
    const restored = deserializeSnapshot(snapshot); // validates everything
    if (!restored.membership.evictedMembers.has(previousId)) return undefined;
    const newId = nextIncarnation(previousId);
    // The kernel treats "the snapshot author's own ID" as a plain restart of that replica, which
    // would put two live replicas under one ID. A rejoining tab must never take it.
    if (newId === restored.replicaId) return undefined;
    // The kernel also refuses an evicted ID and another replica's ID (RangeError): caught below.
    return CRDT.fromSnapshot(restored as Snapshot<Item>, newId);
  } catch {
    return undefined;
  }
}

/**
 * The replica for this page load: restored from a stored rejoin snapshot if there is a usable
 * one, else a fresh one with a new random ID.
 *
 * @param store - `sessionStorage` (or a test double); undefined means none
 * @returns The page's replica
 */
export function createSessionReplica(store: SessionStore | undefined): CRDT<Item> {
  return takeRejoin(store) ?? createReplica();
}

/**
 * How many operations an exorcised tab made beyond its cutoff. The other tabs refused them, and
 * rejoining discards them (the tab restarts from the survivors' state).
 *
 * @param crdt - This tab's replica
 * @returns 0 if the tab was not exorcised
 */
export function unacceptedEdits<T>(crdt: CRDT<T>): number {
  const cutoff = crdt.getMembershipView().evictedMembers.get(crdt.replicaId);
  if (cutoff === undefined) return 0;
  return Math.max(0, (crdt.getVV().get(crdt.replicaId) ?? 0) - cutoff);
}
