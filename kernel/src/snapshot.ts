/**
 * Snapshots (KER-027, KER-028; requirements.md section 13; design.md Algorithms 7 and 8).
 *
 * A snapshot is a complete, serializable picture of one replica: every element in depth-first
 * order (tombstones too, each with its anchor), the version vector, the membership with the
 * evicted replicas' cutoffs, the Lamport clock and the GC statistics. It has no wall-clock field.
 * It does NOT contain the operation log or the dependency buffer: a replica restored from it
 * starts a fresh log, so it can only answer a hello with operations after the snapshot point.
 *
 * A snapshot arrives from another tab, so reading one is a TRUST BOUNDARY: `assertValidSnapshot`
 * checks everything the restore relies on, and `deserializeSnapshot` never returns a snapshot
 * that fails it.
 *
 * Payloads must be JSON-compatible (like operations): a payload that hides a Map or a Set is
 * refused instead of being silently turned into `{}`.
 */

import type { Element, GCStats, MembershipView, OpIdKey, Snapshot, VersionVector } from './types.js';
import {
  assertValidMembershipView,
  getMembership,
  membershipFromJSON,
  membershipToJSON,
} from './membership.js';
import { compareSiblingKeys, createRGA, traverse } from './rga.js';
import type { ParentKey, RGAState } from './rga.js';
import {
  assertValidVersionVector,
  deserializeVersionVector,
  isValidReplicaId,
  isValidSequence,
  MAX_LAMPORT,
  parseOpId,
  serializeVersionVector,
  stableStringify,
} from './utils.js';

/** What `createSnapshot` copies from a live replica. */
export interface SnapshotParts<T> {
  rga: RGAState<T>;
  vv: VersionVector;
  /** The membership view in force, or undefined for a replica that never received one (open mode). */
  membership: MembershipView | undefined;
  lamportClock: number;
  replicaId: string;
  gcStats: GCStats;
  /** The stable frontier the replica holds (set for a snapshot that will be used to rejoin). */
  stableFrontier?: VersionVector;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isLamport = (v: unknown): v is number => isCount(v) && v <= MAX_LAMPORT;

/** A canonical Op ID: `<valid replica ID>:<positive integer>`. */
function isOpId(v: unknown): v is OpIdKey {
  if (typeof v !== 'string') return false;
  const parsed = parseOpId(v as OpIdKey);
  return parsed !== null && isValidSequence(parsed.seq) && isValidReplicaId(parsed.replicaId);
}

/** A faithful deep copy of a JSON-compatible payload; throws TypeError for a Map or a Set inside it. */
function copyPayload<T>(value: T): T {
  if (value === undefined) return value; // a reclaimed payload
  return JSON.parse(stableStringify(value)) as T;
}

function copyVV(vv: VersionVector): VersionVector {
  return new Map(vv);
}

function copyStats(stats: GCStats): GCStats {
  return { ...stats, stableFrontier: copyVV(stats.stableFrontier) };
}

function copyElement<T>(e: Element<T>): Element<T> {
  const copy: Element<T> = {
    id: e.id,
    anchor: e.anchor,
    lamport: e.lamport,
    deleted: e.deleted,
    payloadReclaimed: e.payloadReclaimed,
  };
  if (e.value !== undefined) copy.value = copyPayload(e.value);
  if (e.deletedAt !== undefined) copy.deletedAt = e.deletedAt;
  return copy;
}

/**
 * Take a snapshot of a replica's state (design.md Algorithm 7).
 *
 * @param parts - The replica's state (not changed)
 * @returns A snapshot sharing no mutable object with the replica
 * @throws TypeError if a payload cannot be copied faithfully (it contains a Map or a Set)
 */
export function createSnapshot<T>(parts: SnapshotParts<T>): Snapshot<T> {
  const snapshot: Snapshot<T> = {
    elements: traverse(parts.rga).map(copyElement),
    vv: copyVV(parts.vv),
    membership:
      parts.membership === undefined
        ? { activeMembers: new Set(), evictedMembers: new Map(), epoch: 0 }
        : getMembership(parts.membership),
    lamportClock: parts.lamportClock,
    replicaId: parts.replicaId,
    gcStats: copyStats(parts.gcStats),
  };
  if (parts.stableFrontier !== undefined) snapshot.stableFrontier = copyVV(parts.stableFrontier);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidStats(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('snapshot: "gcStats" must be an object');
  for (const key of ['tombstoneCount', 'payloadsReclaimed', 'bytesSaved', 'replicasEvicted'] as const) {
    if (!isCount(value[key])) throw new TypeError(`snapshot: gcStats.${key} must be a non-negative integer`);
  }
  assertValidVersionVector(value.stableFrontier);
}

/** A lightweight RGA over the snapshot's own element objects (no copies), only to check the shape. */
function structureOf<T>(elements: readonly Element<T>[]): RGAState<T> {
  const rga = createRGA<T>();
  for (const e of elements) {
    rga.elements.set(e.id, e);
    const parent: ParentKey = e.anchor ?? 'HEAD';
    const list = rga.children.get(parent);
    if (list === undefined) rga.children.set(parent, [e.id]);
    else list.push(e.id);
  }
  return rga;
}

/**
 * Check that a value is a snapshot a replica can safely be restored from.
 *
 * Validated: every field and its type; the version vector and membership; the Lamport clock is in
 * range and not below any element's time; every element has a canonical ID of an author the version
 * vector covers up to that seq, no ID repeats, its anchor is an element listed EARLIER (checked by
 * the depth-first comparison at the end), its flags
 * are consistent (a tombstone has `deletedAt`, a live element does not, only a tombstone can have
 * its payload reclaimed, and a reclaimed one has no value); the list is a depth-first pre-order of
 * the anchor tree with every parent's children newest first.
 *
 * @param value - Candidate snapshot
 * @throws TypeError describing the first problem found
 */
export function assertValidSnapshot(value: unknown): asserts value is Snapshot<unknown> {
  if (!isRecord(value)) throw new TypeError('snapshot: expected an object');
  const s = value;
  if (!Array.isArray(s.elements)) throw new TypeError('snapshot: "elements" must be an array');
  assertValidVersionVector(s.vv);
  assertValidMembershipView(s.membership);
  if (!isLamport(s.lamportClock)) throw new TypeError('snapshot: "lamportClock" must be an integer in [0, MAX_LAMPORT]');
  if (typeof s.replicaId !== 'string' || !isValidReplicaId(s.replicaId)) {
    throw new TypeError('snapshot: "replicaId" must be a valid replica ID');
  }
  if (s.gcStats !== undefined) assertValidStats(s.gcStats);
  if (s.stableFrontier !== undefined) assertValidVersionVector(s.stableFrontier);

  const vv = s.vv as VersionVector;
  const clock = s.lamportClock;
  const covered = (id: OpIdKey): boolean => {
    const parsed = parseOpId(id) as { replicaId: string; seq: number };
    return parsed.seq <= (vv.get(parsed.replicaId) ?? 0);
  };

  const seen = new Set<OpIdKey>();
  for (const [i, raw] of (s.elements as unknown[]).entries()) {
    if (!isRecord(raw)) throw new TypeError(`snapshot: element ${i} must be an object`);
    if (!isOpId(raw.id)) throw new TypeError(`snapshot: element ${i} has an invalid id`);
    if (!covered(raw.id)) throw new TypeError(`snapshot: element ${raw.id} is beyond the version vector`);
    if (seen.has(raw.id)) throw new TypeError(`snapshot: element ${raw.id} is listed twice`);
    // The anchor is not looked at here: that it names an element that comes earlier, and that this
    // element sits in the right place among that element's children, is checked below by comparing
    // the list with a real depth-first traversal of the anchor tree.
    if (!isLamport(raw.lamport)) throw new TypeError(`snapshot: element ${raw.id} has an invalid Lamport time`);
    if (raw.lamport > clock) throw new TypeError(`snapshot: element ${raw.id} is newer than the Lamport clock`);
    if (typeof raw.deleted !== 'boolean') throw new TypeError(`snapshot: element ${raw.id} needs a boolean "deleted"`);
    if (typeof raw.payloadReclaimed !== 'boolean') {
      throw new TypeError(`snapshot: element ${raw.id} needs a boolean "payloadReclaimed"`);
    }
    if (raw.deleted) {
      if (!isOpId(raw.deletedAt) || !covered(raw.deletedAt)) {
        throw new TypeError(`snapshot: tombstone ${raw.id} needs a "deletedAt" the version vector covers`);
      }
    } else {
      if (raw.deletedAt !== undefined) throw new TypeError(`snapshot: live element ${raw.id} must not have "deletedAt"`);
      if (raw.payloadReclaimed) throw new TypeError(`snapshot: live element ${raw.id} cannot have its payload reclaimed`);
    }
    if (raw.payloadReclaimed && raw.value !== undefined) {
      throw new TypeError(`snapshot: element ${raw.id} is marked reclaimed but still has a value`);
    }
    seen.add(raw.id);
  }

  // Depth-first pre-order of the anchor tree, with every parent's children newest first.
  const elements = s.elements as Array<Element<unknown>>;
  const rga = structureOf(elements);
  for (const list of rga.children.values()) {
    for (let i = 1; i < list.length; i++) {
      const previous = rga.elements.get(list[i - 1]) as Element<unknown>;
      const next = rga.elements.get(list[i]) as Element<unknown>;
      // never 0 for two distinct elements: compareSiblingKeys ends with an Op ID tie-break
      if (compareSiblingKeys(previous, next) < 0) {
        throw new TypeError(`snapshot: ${previous.id} and ${next.id} are not ordered newest first`);
      }
    }
  }
  const order = traverse(rga);
  if (order.length !== elements.length || order.some((e, i) => e.id !== elements[i].id)) {
    throw new TypeError('snapshot: the elements are not in depth-first order');
  }
}

// ---------------------------------------------------------------------------
// Serialization (KER-028)
// ---------------------------------------------------------------------------

function elementToJSON(e: Element<unknown>): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: e.id,
    lamport: e.lamport,
    deleted: e.deleted,
    payloadReclaimed: e.payloadReclaimed,
  };
  if (e.anchor !== undefined) json.anchor = e.anchor;
  if (e.value !== undefined) json.value = e.value;
  if (e.deletedAt !== undefined) json.deletedAt = e.deletedAt;
  return json;
}

/**
 * Deterministic JSON for a snapshot (keys sorted at every level). Maps and Sets are written as
 * plain objects and sorted arrays: `JSON.stringify` alone would turn them into `{}` and lose the
 * version vector and the membership without a word.
 *
 * @param snapshot - The snapshot
 * @returns Canonical JSON; `serializeSnapshot(deserializeSnapshot(json)) === json`
 * @throws TypeError if a payload contains a Map or a Set
 */
export function serializeSnapshot<T>(snapshot: Snapshot<T>): string {
  const json: Record<string, unknown> = {
    elements: snapshot.elements.map(elementToJSON),
    vv: serializeVersionVector(snapshot.vv),
    membership: membershipToJSON(snapshot.membership),
    lamportClock: snapshot.lamportClock,
    replicaId: snapshot.replicaId,
  };
  if (snapshot.gcStats !== undefined) {
    json.gcStats = { ...snapshot.gcStats, stableFrontier: serializeVersionVector(snapshot.gcStats.stableFrontier) };
  }
  if (snapshot.stableFrontier !== undefined) json.stableFrontier = serializeVersionVector(snapshot.stableFrontier);
  return stableStringify(json);
}

/** A version vector from its JSON object form; throws if anything is invalid. */
function readVV(value: unknown, what: string): VersionVector {
  if (!isRecord(value)) throw new TypeError(`snapshot: "${what}" must be an object`);
  const vv = deserializeVersionVector(value as Record<string, number>);
  assertValidVersionVector(vv);
  return vv;
}

/**
 * Parse and VALIDATE a snapshot serialized by {@link serializeSnapshot}. A snapshot comes from
 * another tab: nothing is repaired or dropped, and nothing half-built is ever returned.
 *
 * @param json - The JSON string
 * @returns A new snapshot (see {@link assertValidSnapshot} for what was checked)
 * @throws SyntaxError if the JSON is malformed
 * @throws TypeError if anything is invalid
 */
export function deserializeSnapshot(json: string): Snapshot<unknown> {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw)) throw new TypeError('snapshot: expected an object');
  if (!Array.isArray(raw.elements)) throw new TypeError('snapshot: "elements" must be an array');

  const elements: Array<Element<unknown>> = (raw.elements as unknown[]).map((e, i) => {
    if (!isRecord(e)) throw new TypeError(`snapshot: element ${i} must be an object`);
    return {
      id: e.id as OpIdKey,
      anchor: e.anchor as OpIdKey | undefined,
      lamport: e.lamport as number,
      deleted: e.deleted as boolean,
      payloadReclaimed: e.payloadReclaimed as boolean,
      ...(e.value !== undefined ? { value: e.value } : {}),
      ...(e.deletedAt !== undefined ? { deletedAt: e.deletedAt as OpIdKey } : {}),
    };
  });

  const snapshot: Snapshot<unknown> = {
    elements,
    vv: readVV(raw.vv, 'vv'),
    membership: membershipFromJSON(raw.membership),
    lamportClock: raw.lamportClock as number,
    replicaId: raw.replicaId as string,
  };
  if (raw.gcStats !== undefined) {
    if (!isRecord(raw.gcStats)) throw new TypeError('snapshot: "gcStats" must be an object');
    snapshot.gcStats = {
      tombstoneCount: raw.gcStats.tombstoneCount as number,
      payloadsReclaimed: raw.gcStats.payloadsReclaimed as number,
      bytesSaved: raw.gcStats.bytesSaved as number,
      replicasEvicted: raw.gcStats.replicasEvicted as number,
      stableFrontier: readVV(raw.gcStats.stableFrontier, 'gcStats.stableFrontier'),
    };
  }
  if (raw.stableFrontier !== undefined) snapshot.stableFrontier = readVV(raw.stableFrontier, 'stableFrontier');

  assertValidSnapshot(snapshot); // the shape of every field, the anchors, the order, the flags
  return snapshot;
}

// ---------------------------------------------------------------------------
// Restore (design.md Algorithm 8, restore step)
// ---------------------------------------------------------------------------

/**
 * Rebuild the RGA from a (validated) snapshot: the anchor tree from the elements' anchors, in list
 * order (so each parent's children are already newest first). `deleteOps` is seeded from
 * `deletedAt` for tombstones that still hold a payload: conservative, GC may reclaim later than
 * the snapshotting replica did, never earlier.
 *
 * @param snapshot - A snapshot that passed {@link assertValidSnapshot} (not changed)
 * @returns A new RGA sharing nothing with the snapshot
 */
export function restoreRGA<T>(snapshot: Snapshot<T>): RGAState<T> {
  const rga = createRGA<T>();
  for (const e of snapshot.elements) {
    const element = copyElement(e);
    rga.elements.set(element.id, element);
    const parent: ParentKey = element.anchor ?? 'HEAD';
    const list = rga.children.get(parent);
    if (list === undefined) rga.children.set(parent, [element.id]);
    else list.push(element.id);
    if (element.deleted && !element.payloadReclaimed && element.deletedAt !== undefined) {
      rga.deleteOps.set(element.id, new Set([element.deletedAt]));
    }
  }
  return rga;
}
