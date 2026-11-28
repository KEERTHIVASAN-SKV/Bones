import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_ITEM_LENGTH, isItem, visibleItems } from './replica';
import type { ItemElement } from './replica';
import { GraveyardPanel } from './GraveyardPanel';
import { REJOIN_TIMEOUT_MS } from './rejoin';
import type { RejoinStatus } from './rejoin';
import { getSessionStore, stashRejoin, unacceptedEdits } from './rejoinSession';
import { crdt, sync } from './session';

/** The items to render; re-renders whenever the CRDT's visible sequence changes (local or remote). */
function useItems(): ItemElement[] {
  const [items, setItems] = useState<ItemElement[]>(() => visibleItems(crdt));
  useEffect(() => {
    const refresh = (): void => setItems(visibleItems(crdt));
    crdt.on('sequenceChanged', refresh);
    refresh(); // a change between the first render and this effect would otherwise be missed
    return () => crdt.off('sequenceChanged', refresh);
  }, []);
  return items;
}

/** This tab's cutoff if the coordinator exorcised it (its kernel learns that from a membership view), else undefined. */
function useEvictedCutoff(): number | undefined {
  const [cutoff, setCutoff] = useState(() => crdt.getMembershipView().evictedMembers.get(crdt.replicaId));
  useEffect(() => {
    const refresh = (): void => setCutoff(crdt.getMembershipView().evictedMembers.get(crdt.replicaId));
    crdt.on('membershipChanged', refresh);
    refresh();
    return () => crdt.off('membershipChanged', refresh);
  }, []);
  return cutoff;
}

/** Where this tab's Rejoin request stands (see rejoin.ts); re-read whenever sync reports a change. */
function useRejoinStatus(): RejoinStatus {
  const [status, setStatus] = useState<RejoinStatus>(() => sync.getRejoin());
  useEffect(() => {
    const refresh = (): void => setStatus(sync.getRejoin());
    const unsubscribe = sync.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, []);
  return status;
}

export function App() {
  const items = useItems();
  const evictedCutoff = useEvictedCutoff();
  const rejoin = useRejoinStatus();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [rejoinNote, setRejoinNote] = useState<string | null>(null);

  // A snapshot arrived: keep it for the next page load and reload. The replica is not swapped under
  // the running page; the new page load restores from it under the next incarnation of this ID.
  useEffect(() => {
    if (rejoin.state !== 'ready') return;
    if (stashRejoin(getSessionStore(), rejoin.snapshot, crdt.replicaId)) {
      location.reload();
    } else {
      setRejoinNote('This browser blocks session storage, so the page cannot restart from the snapshot. Reload the page to get a new replica instead.');
    }
  }, [rejoin]);

  function startRejoin(): void {
    setRejoinNote(
      sync.requestRejoin() ? null : 'This tab is stalled, so it cannot ask for a snapshot. Resume it first, then press Rejoin.'
    );
  }

  /** An exorcised tab's kernel refuses to create operations past its cutoff (RangeError): say so instead of crashing. */
  function guarded(action: () => void): void {
    try {
      action();
      setNotice(null);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      setNotice('This tab was exorcised, so it can no longer add or complete items.');
    }
  }

  function add(event: FormEvent): void {
    event.preventDefault();
    const value = { text: text.trim() };
    if (!isItem(value)) return; // empty, or longer than MAX_ITEM_LENGTH
    const current = visibleItems(crdt); // read now, not from render state: a remote op may have just arrived
    const last = current[current.length - 1];
    guarded(() => sync.sendOp(crdt.insert(last?.id, value)));
    setText('');
  }

  return (
    <main>
      <h1>Cursed Checklist</h1>
      {evictedCutoff !== undefined && (
        <section aria-label="Rejoin">
          <p role="alert">
            This tab was exorcised. The other tabs keep its first {evictedCutoff} operations and refuse the rest.
          </p>
          {unacceptedEdits(crdt) > 0 && (
            <p>
              {unacceptedEdits(crdt)} offline edit{unacceptedEdits(crdt) === 1 ? ' was' : 's were'} not accepted by the
              other tabs and will be discarded if you rejoin.
            </p>
          )}
          <p>
            <button type="button" onClick={startRejoin} disabled={rejoin.state === 'waiting' || rejoin.state === 'ready'}>
              Rejoin
            </button>{' '}
            Rejoining restarts this tab from a snapshot of the other tabs, under a new replica ID.
          </p>
          {rejoin.state === 'waiting' && <p>Asking the other tabs for a snapshot...</p>}
          {rejoin.state === 'timed-out' && (
            <p role="alert">
              No tab answered within {REJOIN_TIMEOUT_MS / 1000} seconds. Rejoin needs another tab of this app that is
              still a member and not stalled. Open or resume one, then press Rejoin again.
            </p>
          )}
          {rejoinNote !== null && <p role="alert">{rejoinNote}</p>}
        </section>
      )}
      {notice !== null && <p role="alert">{notice}</p>}
      <form onSubmit={add}>
        <input
          value={text}
          maxLength={MAX_ITEM_LENGTH}
          placeholder="Something to do before the dead rise"
          aria-label="New item"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span>{item.value.text}</span>{' '}
            {/* Completing buries the item: a delete operation, which leaves a tombstone. */}
            <button type="button" onClick={() => guarded(() => sync.sendOp(crdt.delete(item.id)))}>
              Complete (bury)
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p>Nothing here. Open this page in a second tab to watch the two tabs sync.</p>}
      <GraveyardPanel crdt={crdt} sync={sync} />
      <footer>
        <small>
          This tab is replica {crdt.replicaId}.{' '}
          <a href="control.html" target="_blank" rel="noopener noreferrer">
            Control page
          </a>
        </small>
      </footer>
    </main>
  );
}
