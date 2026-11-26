/**
 * This page load's replica and its sync. Module scope on purpose: there must be exactly one of
 * each per page, whatever React renders or re-renders (two replicas in one tab would be two
 * authors, and a second sync would double every message).
 *
 * Importing this file starts syncing, so only the app entry (App.tsx) imports it; tests build
 * their own replicas with `createReplica` and `startSync`.
 */
import { createReplica } from './replica';
import { startSync } from './sync';
import { createBroadcastTransport } from './transport';

const transport = createBroadcastTransport();

/** The CRDT of this tab. */
export const crdt = createReplica();

/** Broadcasts this tab's operations and answers other tabs' hellos. */
export const sync = startSync(crdt, transport);

// Vite hot reload re-runs this module: release the old channel and timer first.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sync.stop();
    transport.close();
  });
}
