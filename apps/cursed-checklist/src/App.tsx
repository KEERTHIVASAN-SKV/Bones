import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_ITEM_LENGTH, isItem, visibleItems } from './replica';
import type { ItemElement } from './replica';
import { GraveyardPanel } from './GraveyardPanel';
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

export function App() {
  const items = useItems();
  const evictedCutoff = useEvictedCutoff();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

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
        <p role="alert">
          This tab was exorcised. The other tabs keep its first {evictedCutoff} operations and refuse the rest.
        </p>
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
