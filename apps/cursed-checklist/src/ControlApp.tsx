import { useEffect, useState } from 'react';
import type { CoordinatorStatus, EvictionRefusal } from '@bones/coordinator';
import type { CoordinatorAdapter } from './coordinatorAdapter';

const REFUSALS: Record<EvictionRefusal, string> = {
  'invalid-id': 'That is not a valid replica ID.',
  'not-a-member': 'That tab is not an active member.',
  'eviction-in-progress': 'Another exorcism is still being prepared. Wait for it, or abort it first.',
  'no-survivors': 'Nobody would be left to keep its operations, so the last member cannot be exorcised.',
};

/** The coordinator's status, re-read on every change and once a second (the "last heard" ages move on their own). */
function useStatus(coordinator: CoordinatorAdapter): CoordinatorStatus {
  const [status, setStatus] = useState(() => coordinator.getStatus());
  useEffect(() => {
    const refresh = (): void => setStatus(coordinator.getStatus());
    const unsubscribe = coordinator.subscribe(refresh);
    const timer = setInterval(refresh, 1000);
    refresh();
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [coordinator]);
  return status;
}

function seen(lastHeard: number | undefined): string {
  if (lastHeard === undefined) return 'never';
  return `${Math.max(0, Math.round((Date.now() - lastHeard) / 1000))} s ago`;
}

/** `a.0:5, b.0:2`, or a note when nothing is stable yet. */
function formatVV(vv: ReadonlyMap<string, number>): string {
  if (vv.size === 0) return 'nothing is stable yet';
  return [...vv].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, seq]) => `${id}:${seq}`).join(', ');
}

export function ControlApp({ coordinator }: { coordinator: CoordinatorAdapter }) {
  const status = useStatus(coordinator);
  const [refusal, setRefusal] = useState<string | null>(null);

  function exorcise(target: string): void {
    const result = coordinator.exorcise(target);
    setRefusal(result.ok ? null : REFUSALS[result.reason]);
  }

  return (
    <main>
      <h1>Control</h1>
      <p>
        Epoch <strong>{status.epoch}</strong>. Stable frontier: <code>{formatVV(status.frontier)}</code>
      </p>

      <h2>Members</h2>
      {status.members.length === 0 ? (
        <p>No tab has said hello yet. Open the app in another window; each tab joins by saying hello.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tab</th>
              <th>Last heard</th>
              <th>Operations acknowledged</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <code>{m.id}</code>
                </td>
                <td>
                  {seen(m.lastHeard)}
                  {m.stalled ? ' (silent: possibly stalled)' : ''}
                </td>
                <td>{[...m.ack.values()].reduce((sum, seq) => sum + seq, 0)}</td>
                <td>
                  <button type="button" disabled={status.eviction !== null} onClick={() => exorcise(m.id)}>
                    Exorcise
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {refusal !== null && <p role="alert">{refusal}</p>}

      {status.eviction !== null && (
        <section>
          <h2>Exorcism in progress</h2>
          <p>
            Asking the other tabs to freeze <code>{status.eviction.target}</code>. Still waiting for:{' '}
            {status.eviction.waitingFor.map((id) => (
              <code key={id}>{id} </code>
            ))}
          </p>
          <button type="button" onClick={() => coordinator.abort()}>
            Abort
          </button>
        </section>
      )}

      <h2>Exorcised</h2>
      {status.evicted.length === 0 ? (
        <p>Nobody yet.</p>
      ) : (
        <ul>
          {status.evicted.map((e) => (
            <li key={e.id}>
              <code>{e.id}</code>: its operations up to number {e.cutoff} are kept, later ones are refused.{' '}
              {e.complete ? 'Complete: every tab holds them.' : (
                <>
                  Pending: still waiting for {e.waitingFor.map((id) => <code key={id}>{id} </code>)}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <footer>
        <small>
          Keep this page open: it IS the coordinator, and reloading it resets it. Nothing is ever exorcised
          automatically; a silent tab is only flagged.
        </small>
      </footer>
    </main>
  );
}
