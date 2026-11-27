/**
 * What the Graveyard panel shows (`panelModel`) and what the Stress button does (`runStress`).
 * Plain functions, no React: the component only renders what they return, so the numbers can be
 * tested without a browser.
 *
 * Honest labels (the demo-apps design, "Graveyard panel"): Stage 1 GC drops only the PAYLOAD of a
 * buried item. The tombstone (the structural node) stays, so "tombstones" never goes down and the
 * panel says "structure kept". The savings are payload bytes.
 */
import type { CRDT, OpIdKey } from '@bones/kernel';
import { visibleItems } from './replica';
import type { Item } from './replica';
import type { Sync, SyncStats } from './sync';

/** How many items the Stress button adds and then buries. */
export const STRESS_COUNT = 200;
/** How long each stress item's text is (about 100 characters, as in the demo script). */
export const STRESS_LENGTH = 100;

export interface PanelModel {
  /** True once a coordinator has published a view to this tab (epoch above 0). Without one nothing is ever reclaimed. */
  coordinated: boolean;
  epoch: number;
  /** Active members, sorted. Before a coordinator exists: just this tab. */
  members: string[];
  /** Exorcised tabs and the number of their operations that are still accepted, sorted by ID. */
  evicted: Array<{ id: string; cutoff: number }>;
  /** Buried items still in the structure (a reclaimed payload leaves its tombstone behind). */
  tombstones: number;
  /** How many of those lost their payload. */
  payloadsReclaimed: number;
  /** Estimated bytes of payload freed, each counted once. */
  bytesReclaimed: number;
  /** The stable frontier this tab holds, sorted: `[replicaId, seq]`. */
  frontier: Array<[string, number]>;
  /** Operations refused because their author was exorcised and they lie beyond its cutoff. */
  refused: Array<{ author: string; count: number }>;
  paused: boolean;
  /** Edits made while paused that have not been sent yet. */
  unsent: number;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The numbers for the panel, read from the kernel and the sync counters.
 *
 * @param crdt - This tab's replica
 * @param stats - `sync.getStats()`
 * @returns A fresh snapshot (changing it changes nothing)
 */
export function panelModel(crdt: CRDT<Item>, stats: SyncStats): PanelModel {
  const view = crdt.getMembershipView();
  const gc = crdt.getGCStats();
  return {
    coordinated: view.epoch > 0,
    epoch: view.epoch,
    members: [...view.activeMembers].sort(byId),
    evicted: [...view.evictedMembers].map(([id, cutoff]) => ({ id, cutoff })).sort((a, b) => byId(a.id, b.id)),
    tombstones: gc.tombstoneCount,
    payloadsReclaimed: gc.payloadsReclaimed,
    bytesReclaimed: gc.bytesSaved,
    frontier: [...gc.stableFrontier].sort(([a], [b]) => byId(a, b)),
    refused: Object.entries(stats.fenced)
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => byId(a.author, b.author)),
    paused: stats.paused,
    unsent: stats.unsent,
  };
}

export interface StressResult {
  added: number;
  buried: number;
  /** Set only if the kernel refused to create more operations (this tab was exorcised). */
  refused?: true;
}

/** Item `i` of the stress run: `ghost 001 xxxx...`, exactly STRESS_LENGTH characters. */
function stressText(i: number): string {
  return `ghost ${String(i).padStart(3, '0')} `.padEnd(STRESS_LENGTH, 'x');
}

/**
 * The Stress button: add STRESS_COUNT items of STRESS_LENGTH characters after the last visible
 * item, then bury all of them. It uses `crdt.insert`, `crdt.delete` and `sync.sendOp` exactly as
 * a user's clicks do, so the numbers on the panel come from the real path.
 *
 * If the kernel refuses to create more operations (this tab was exorcised) it stops and says so;
 * it never throws for that.
 *
 * @param crdt - This tab's replica
 * @param sync - Where every operation is sent
 * @returns How many items were added and buried
 */
export function runStress(crdt: CRDT<Item>, sync: Pick<Sync, 'sendOp'>): StressResult {
  const result: StressResult = { added: 0, buried: 0 };
  const current = visibleItems(crdt);
  let anchor: OpIdKey | undefined = current[current.length - 1]?.id;
  const ids: OpIdKey[] = [];
  try {
    for (let i = 1; i <= STRESS_COUNT; i++) {
      const op = crdt.insert(anchor, { text: stressText(i) });
      sync.sendOp(op);
      ids.push(op.id);
      anchor = op.id;
      result.added++;
    }
    for (const id of ids) {
      sync.sendOp(crdt.delete(id));
      result.buried++;
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    result.refused = true;
  }
  return result;
}
