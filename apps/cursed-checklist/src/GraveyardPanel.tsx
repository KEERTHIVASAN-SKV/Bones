import { useEffect, useState } from 'react';
import type { CRDT } from '@bones/kernel';
import { panelModel, runStress, STRESS_COUNT } from './panel';
import type { PanelModel } from './panel';
import type { Item } from './replica';
import type { Sync } from './sync';

/** The panel's numbers, re-read whenever the document, the membership, the GC or the sync counters change. */
function usePanel(crdt: CRDT<Item>, sync: Sync): PanelModel {
  const [model, setModel] = useState(() => panelModel(crdt, sync.getStats()));
  useEffect(() => {
    const refresh = (): void => setModel(panelModel(crdt, sync.getStats()));
    crdt.on('sequenceChanged', refresh);
    crdt.on('membershipChanged', refresh);
    crdt.on('gcEvent', refresh);
    const unsubscribe = sync.subscribe(refresh);
    refresh();
    return () => {
      crdt.off('sequenceChanged', refresh);
      crdt.off('membershipChanged', refresh);
      crdt.off('gcEvent', refresh);
      unsubscribe();
    };
  }, [crdt, sync]);
  return model;
}

const formatVV = (vv: Array<[string, number]>): string =>
  vv.length === 0 ? 'nothing is stable yet' : vv.map(([id, seq]) => `${id}:${seq}`).join(', ');

export function GraveyardPanel({ crdt, sync }: { crdt: CRDT<Item>; sync: Sync }) {
  const model = usePanel(crdt, sync);
  const [stressNote, setStressNote] = useState<string | null>(null);

  function stress(): void {
    const result = runStress(crdt, sync);
    setStressNote(
      result.refused
        ? `Stopped after ${result.added} added and ${result.buried} buried: this tab was exorcised.`
        : `Added ${result.added} items and buried ${result.buried}.`
    );
  }

  return (
    <section aria-label="Graveyard">
      <h2>Graveyard</h2>
      {!model.coordinated && (
        <p>
          No control page is running, so nothing here can be reclaimed. Open the control page in another window;
          every tab that says hello joins it.
        </p>
      )}
      <dl>
        <dt>tombstones (structure kept)</dt>
        <dd>{model.tombstones}</dd>
        <dt>payloads reclaimed</dt>
        <dd>
          {model.payloadsReclaimed} of {model.tombstones}
        </dd>
        <dt>estimated payload bytes reclaimed</dt>
        <dd>{model.bytesReclaimed}</dd>
        <dt>stable frontier</dt>
        <dd>
          <code>{formatVV(model.frontier)}</code>
        </dd>
        <dt>epoch</dt>
        <dd>{model.epoch}</dd>
        <dt>members</dt>
        <dd>{model.members.map((id) => <code key={id}>{id} </code>)}</dd>
        <dt>evicted</dt>
        <dd>
          {model.evicted.length === 0
            ? 'none'
            : model.evicted.map((e) => (
                <span key={e.id}>
                  <code>{e.id}</code> (its first {e.cutoff} operations are kept){' '}
                </span>
              ))}
        </dd>
      </dl>

      {model.refused.map((r) => (
        <p key={r.author} role="alert">
          Refused {r.count} operation{r.count === 1 ? '' : 's'} from <code>{r.author}</code>: it was exorcised, and
          what it wrote beyond its cutoff is rejected.
        </p>
      ))}

      <p>
        <button type="button" onClick={() => (model.paused ? sync.resume() : sync.pause())}>
          {model.paused ? 'Resume' : 'Stall this tab'}
        </button>{' '}
        <button type="button" onClick={stress}>
          Stress ({STRESS_COUNT} items, then bury all)
        </button>
      </p>
      {model.paused && (
        <p>
          This tab is stalled: it sends and hears nothing. {model.unsent} local edit{model.unsent === 1 ? '' : 's'} not
          sent yet.
        </p>
      )}
      {stressNote !== null && <p>{stressNote}</p>}
    </section>
  );
}
