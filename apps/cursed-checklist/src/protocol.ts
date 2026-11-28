/**
 * The wire format (v2): every message is a JSON string, and everything received is UNTRUSTED
 * (any script on the same origin can post to the channel). This is the one place that parses it,
 * for the tabs (sync.ts) and for the control page, so the two sides cannot drift apart.
 *
 *   { t: 'op',       op: '<serializeOp output>' }                                   a tab's operation
 *   { t: 'hello',    from, epoch, vv: { <replicaId>: <seq> } }                      "this is what I hold"; also the ack
 *   { t: 'view',     view: <membership JSON> }                                      coordinator: a membership view
 *   { t: 'frontier', epoch, vv }                                                    coordinator: the stable frontier
 *   { t: 'prepare',  target, epoch }                                                coordinator: survivors freeze `target`
 *   { t: 'prepared', from, target, epoch, seq }                                     a survivor's reply (its frozen seq)
 *   { t: 'release',  target }                                                       coordinator: an eviction was aborted
 *   { t: 'rejected', to, epoch }                                                    coordinator: a control message was refused
 *   { t: 'snapshot-request', from }                                                an exorcised tab asks to rejoin (`from` = its old ID)
 *   { t: 'snapshot', to, snap: '<serializeSnapshot output>' }                      a surviving tab's answer, addressed to the old ID
 *
 * `decode` never throws: anything that is not a well-formed message returns null. `from` and
 * `epoch` of a hello are optional on receive (a peer answers a hello with catch-up operations
 * whether or not it says who it is); the coordinator ignores a hello without them.
 */

import {
  assertValidVersionVector,
  deserializeOp,
  deserializeVersionVector,
  isValidReplicaId,
  membershipFromJSON,
  membershipToJSON,
  serializeOp,
  serializeVersionVector,
} from '@bones/kernel';
import type { MembershipView, Operation, VersionVector } from '@bones/kernel';

/** A decoded, validated message. */
export type Incoming =
  | { t: 'op'; op: Operation<unknown> }
  | { t: 'hello'; from: string | undefined; epoch: number | undefined; vv: VersionVector }
  | { t: 'view'; view: MembershipView }
  | { t: 'frontier'; epoch: number; vv: VersionVector }
  | { t: 'prepare'; target: string; epoch: number }
  | { t: 'prepared'; from: string; target: string; epoch: number; seq: number }
  | { t: 'release'; target: string }
  | { t: 'rejected'; to: string; epoch: number }
  | { t: 'snapshot-request'; from: string }
  | { t: 'snapshot'; to: string; snap: string };

/**
 * Longest snapshot string accepted (characters). A snapshot is validated in full by the kernel
 * (`deserializeSnapshot`) before it is used; this only stops an absurdly large string from being
 * handed to that validator at all.
 */
export const MAX_SNAPSHOT_CHARS = 5_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && isValidReplicaId(value);
/** Epochs and sequence numbers: non-negative safe integers. */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A version vector from its JSON object form; throws if anything is invalid (the caller catches). */
function readVV(value: unknown): VersionVector {
  if (!isRecord(value)) throw new TypeError('version vector must be an object');
  const vv = deserializeVersionVector(value as Record<string, number>);
  assertValidVersionVector(vv); // replica IDs too: deserializeVersionVector only checks the numbers
  return vv;
}

function need<T>(value: unknown, ok: (v: unknown) => v is T, what: string): T {
  if (!ok(value)) throw new TypeError(`invalid ${what}`);
  return value;
}

/**
 * Parse and validate a received message.
 *
 * @param message - Whatever arrived on the channel
 * @returns The decoded message, or null if it is not a well-formed message (never throws)
 */
export function decode(message: unknown): Incoming | null {
  if (typeof message !== 'string') return null;
  try {
    const wire: unknown = JSON.parse(message);
    if (!isRecord(wire)) return null;
    switch (wire.t) {
      case 'op': {
        if (typeof wire.op !== 'string') return null;
        return { t: 'op', op: deserializeOp(wire.op) }; // throws on a malformed operation
      }
      case 'hello':
        return {
          t: 'hello',
          from: isId(wire.from) ? wire.from : undefined,
          epoch: isCount(wire.epoch) ? wire.epoch : undefined,
          vv: readVV(wire.vv),
        };
      case 'view':
        return { t: 'view', view: membershipFromJSON(wire.view) };
      case 'frontier':
        return { t: 'frontier', epoch: need(wire.epoch, isCount, 'epoch'), vv: readVV(wire.vv) };
      case 'prepare':
        return { t: 'prepare', target: need(wire.target, isId, 'target'), epoch: need(wire.epoch, isCount, 'epoch') };
      case 'prepared':
        return {
          t: 'prepared',
          from: need(wire.from, isId, 'from'),
          target: need(wire.target, isId, 'target'),
          epoch: need(wire.epoch, isCount, 'epoch'),
          seq: need(wire.seq, isCount, 'seq'),
        };
      case 'release':
        return { t: 'release', target: need(wire.target, isId, 'target') };
      case 'rejected':
        return { t: 'rejected', to: need(wire.to, isId, 'to'), epoch: need(wire.epoch, isCount, 'epoch') };
      case 'snapshot-request':
        return { t: 'snapshot-request', from: need(wire.from, isId, 'from') };
      case 'snapshot': {
        const snap = need(wire.snap, (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_SNAPSHOT_CHARS, 'snap');
        return { t: 'snapshot', to: need(wire.to, isId, 'to'), snap };
      }
      default:
        return null;
    }
  } catch {
    return null; // not JSON, or a field failed validation: ignored, never thrown
  }
}

export const encodeOp = (op: Operation<unknown>): string => JSON.stringify({ t: 'op', op: serializeOp(op) });

export const encodeHello = (from: string, epoch: number, vv: VersionVector): string =>
  JSON.stringify({ t: 'hello', from, epoch, vv: serializeVersionVector(vv) });

export const encodeView = (view: MembershipView): string => JSON.stringify({ t: 'view', view: membershipToJSON(view) });

export const encodeFrontier = (epoch: number, vv: VersionVector): string =>
  JSON.stringify({ t: 'frontier', epoch, vv: serializeVersionVector(vv) });

export const encodePrepare = (target: string, epoch: number): string => JSON.stringify({ t: 'prepare', target, epoch });

export const encodePrepared = (from: string, target: string, epoch: number, seq: number): string =>
  JSON.stringify({ t: 'prepared', from, target, epoch, seq });

export const encodeRelease = (target: string): string => JSON.stringify({ t: 'release', target });

export const encodeRejected = (to: string, epoch: number): string => JSON.stringify({ t: 'rejected', to, epoch });

export const encodeSnapshotRequest = (from: string): string => JSON.stringify({ t: 'snapshot-request', from });

export const encodeSnapshot = (to: string, snap: string): string => JSON.stringify({ t: 'snapshot', to, snap });
