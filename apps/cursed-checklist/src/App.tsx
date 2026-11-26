import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_ITEM_LENGTH, isItem, visibleItems } from './replica';
import type { ItemElement } from './replica';
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

export function App() {
  const items = useItems();
  const [text, setText] = useState('');

  function add(event: FormEvent): void {
    event.preventDefault();
    const value = { text: text.trim() };
    if (!isItem(value)) return; // empty, or longer than MAX_ITEM_LENGTH
    const current = visibleItems(crdt); // read now, not from render state: a remote op may have just arrived
    const last = current[current.length - 1];
    sync.sendOp(crdt.insert(last?.id, value));
    setText('');
  }

  return (
    <main>
      <h1>Cursed Checklist</h1>
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
            <button type="button" onClick={() => sync.sendOp(crdt.delete(item.id))}>
              Complete (bury)
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p>Nothing here. Open this page in a second tab to watch the two tabs sync.</p>}
      <footer>
        <small>This tab is replica {crdt.replicaId}</small>
      </footer>
    </main>
  );
}
