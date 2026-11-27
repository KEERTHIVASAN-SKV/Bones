/**
 * The one coordinator of this control page. Module scope on purpose, like session.ts: exactly one
 * per page, whatever React renders. Importing this file starts it, so only control.tsx imports it.
 *
 * It uses the SAME channel as the app tabs, so the control page must be served from the same
 * origin as the app (it is a second page of the same build).
 */
import { startCoordinator } from './coordinatorAdapter';
import { createBroadcastTransport } from './transport';

const transport = createBroadcastTransport();

export const coordinator = startCoordinator(transport, Date.now);

// Vite hot reload re-runs this module: release the old channel first.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    coordinator.stop();
    transport.close();
  });
}
