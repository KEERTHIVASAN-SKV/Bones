/**
 * Public entry point test (E1). Imports from `../src/index.js`, NOT from `../src/rga.js`,
 * so it fails if an RGA export is ever dropped from the package's public API.
 */

import { describe, it, expect } from 'vitest';
import {
  createOpId,
  createRGA,
  applyInsert,
  applyDelete,
  insert,
  delete_,
  getSequence,
  isElementDeleted,
  markPayloadReclaimed,
  traverse,
  compareSiblingKeys,
  advanceContiguous,
  stableFrontier,
  cloneRGA,
  createOpLog,
  appendOp,
  shouldAppendOp,
  getAllOps,
  getOpsByReplica,
  getOpAt,
  logLength,
  replayLog,
  createOperationBuffer,
  bufferOp,
  takeReadyFromBuffer,
  takeBufferedOp,
  purgeFencedBuffered,
  refreshMissing,
  assertValidOperation,
  MAX_LAMPORT,
  computeVVDifference,
  getAllElements,
  CRDT,
  createMembership,
  getMembership,
  getEpoch,
  addReplica,
  removeReplica,
  applyMembershipView,
  assertValidMembershipView,
  isReplicaActive,
  getCutoff,
  isBeyondCutoff,
  isFenced,
  isControlMessageRejected,
  membershipToJSON,
  membershipFromJSON,
  serializeMembership,
  deserializeMembership,
  assertValidVersionVector,
  computeStableFrontier,
  isCausallyStable,
  performStage1GC,
  buildGCStats,
  redactReclaimedPayloads,
} from '../src/index.js';
import type { RGAState, ParentKey, Operation } from '../src/index.js';

describe('public API (index.ts) exposes the RGA', () => {
  it('exports every RGA function', () => {
    for (const fn of [
      createRGA,
      applyInsert,
      applyDelete,
      insert,
      delete_,
      getSequence,
      isElementDeleted,
      markPayloadReclaimed,
      traverse,
      compareSiblingKeys,
      advanceContiguous,
      stableFrontier,
      cloneRGA,
      createOpLog,
      appendOp,
      shouldAppendOp,
      getAllOps,
      getOpsByReplica,
      getOpAt,
      logLength,
      replayLog,
      createOperationBuffer,
      bufferOp,
      takeReadyFromBuffer,
      takeBufferedOp,
      purgeFencedBuffered,
      refreshMissing,
      assertValidOperation,
      computeVVDifference,
      getAllElements,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('the CRDT class exposes membership, frontier and GC through the public entry point', () => {
    expect(typeof assertValidVersionVector).toBe('function');
    const members = createMembership(['a.0', 'b.0']);
    const a = new CRDT<string>('a.0', members);
    const b = new CRDT<string>('b.0', members);
    const x = a.insert(undefined, 'payload');
    b.applyOp(x);
    const d = a.delete(x.id);
    b.applyOp(d);

    const acks = new Map([['a.0', a.getVV()], ['b.0', b.getVV()]]);
    const frontier = computeStableFrontier(acks, members.activeMembers);
    let gcEvents = 0;
    a.on('gcEvent', () => {
      gcEvents++;
    });
    expect(a.updateStableFrontier(frontier, a.getMembershipView().epoch)).toBe(true);
    expect(gcEvents).toBe(1);
    expect(a.isCausallyStable(d.id)).toBe(true);
    expect(a.getGCStats()).toMatchObject({ tombstoneCount: 1, payloadsReclaimed: 1 });
    expect(a.getGCStats().bytesSaved).toBeGreaterThan(0);

    // prepare phase: hold b, so what b writes while the eviction is in flight is buffered, not applied
    expect(a.holdAuthor('b.0')).toBe(0);
    expect(a.isAuthorHeld('b.0')).toBe(true);
    const inFlight = b.insert(undefined, 'in flight');
    expect(a.applyOp(inFlight).status).toBe('buffered');

    // evict b: a view with a higher epoch installs (and ends the hold), and b's later operations are fenced
    expect(a.updateMembership(removeReplica(members, 'b.0', 0))).toBe(true); // cutoff = a's reply to the prepare
    expect(a.getMembershipView().epoch).toBe(1);
    expect(a.isAuthorHeld('b.0')).toBe(false);
    expect(a.getPendingCount()).toBe(0); // the in-flight operation lay beyond the cutoff: purged
    expect(a.applyOp(b.insert(undefined, 'too late')).status).toBe('fenced');
  });

  it('exports GC: frontier from acks, stability check, reclaim a payload, redact the log, stats', () => {
    for (const fn of [computeStableFrontier, isCausallyStable, performStage1GC, buildGCStats, redactReclaimedPayloads]) {
      expect(typeof fn).toBe('function');
    }
    const rga = createRGA<string>();
    const op: Operation<string> = { id: createOpId('r1', 1), type: 'insert', value: 'secret', lamport: 1, replicaId: 'r1' };
    applyInsert(rga, op);
    applyDelete(rga, { id: createOpId('r2', 1), type: 'delete', target: op.id, lamport: 2, replicaId: 'r2' });

    const acks = new Map([['r1', new Map([['r2', 1]])], ['r2', new Map([['r2', 1]])]]);
    const frontier = computeStableFrontier(acks, new Set(['r1', 'r2']));
    expect(isCausallyStable(createOpId('r2', 1), frontier)).toBe(true);

    const result = performStage1GC(rga, frontier);
    expect(result.reclaimed).toEqual([op.id]);
    const log = createOpLog<string>();
    appendOp(log, op);
    expect(redactReclaimedPayloads(log, result.reclaimed)).toBe(1);
    expect(getAllOps(log)[0].value).toBeUndefined();
    expect(buildGCStats(rga, result.bytesReclaimed, 0, frontier)).toMatchObject({ tombstoneCount: 1, payloadsReclaimed: 1 });
  });

  it('exports membership: evict with a cutoff, fence by author, round-trip through JSON', () => {
    for (const fn of [
      createMembership, getMembership, getEpoch, addReplica, removeReplica, applyMembershipView,
      assertValidMembershipView, isReplicaActive, getCutoff, isBeyondCutoff, isFenced,
      isControlMessageRejected, membershipToJSON, membershipFromJSON, serializeMembership,
      deserializeMembership,
    ]) {
      expect(typeof fn).toBe('function');
    }
    const m = removeReplica(addReplica(createMembership(['a']), 'b'), 'b', 3);
    expect(getEpoch(m)).toBe(2);
    expect(isFenced(m, 'b', 3)).toBe(false);
    expect(isFenced(m, 'b', 4)).toBe(true);
    expect(deserializeMembership(serializeMembership(m))).toEqual(m);
  });

  it('exports the CRDT class, and two replicas converge through the public entry point', () => {
    expect(typeof CRDT).toBe('function');
    expect(MAX_LAMPORT).toBe(2 ** 48);
    const a = new CRDT<string>('site1.0');
    const b = new CRDT<string>('site2.0');
    const c = a.insert(undefined, 'C');
    const t = a.insert(c.id, 'T');
    const x = b.applyOp(c).status === 'applied' ? b.insert(c.id, 'X') : c; // concurrent with T
    b.applyOp(t);
    a.applyOp(x);
    const text = (r: CRDT<string>): string => r.getSequence().map((e) => e.value).join('');
    expect(text(a)).toBe(text(b));
    expect(text(a)).toHaveLength(3);
  });

  it('catch-up works through the public entry point: opsSince, computeVVDifference and getAllElements', () => {
    const a = new CRDT<string>('site1.0');
    const b = new CRDT<string>('site2.0');
    const h = a.insert(undefined, 'H');
    const i = a.insert(h.id, 'i');
    a.delete(i.id);

    // b has nothing: the difference says a is ahead by 3 operations of its own
    expect(computeVVDifference(a.getVV(), b.getVV()).get('site1.0')).toEqual({ from: 1, to: 3 });
    const missing = a.opsSince(b.getVV());
    expect(missing).toHaveLength(3);
    for (const op of missing) expect(b.applyOp(op).status).toBe('applied');

    expect(computeVVDifference(a.getVV(), b.getVV()).size).toBe(0);
    expect(a.opsSince(b.getVV())).toEqual([]);
    expect(b.getSequence().map((e) => e.value)).toEqual(['H']);
    // the tombstone is visible through the public API, on both replicas
    for (const replica of [a, b]) {
      expect(replica.getAllElements().map((e) => [e.value, e.deleted])).toEqual([['H', false], ['i', true]]);
    }
  });

  it('getAllElements (RGA level) is reachable from the entry point and returns tombstones', () => {
    const rga = createRGA<string>();
    const op: Operation<string> = { id: createOpId('r1', 1), type: 'insert', value: 'x', lamport: 1, replicaId: 'r1' };
    applyInsert(rga, op);
    applyDelete(rga, { id: createOpId('r2', 1), type: 'delete', target: op.id, lamport: 2, replicaId: 'r2' });
    expect(getSequence(rga)).toEqual([]);
    expect(getAllElements(rga)).toHaveLength(1);
  });

  it('runs the CAT/A/X example through the public entry point', () => {
    const rga: RGAState<string> = createRGA<string>();
    const head: ParentKey = 'HEAD';
    expect(rga.children.has(head)).toBe(false);

    const mk = (seq: number, anchor: Operation<string>['anchor'], lamport: number, value: string): Operation<string> => ({
      id: createOpId('r1', seq),
      type: 'insert',
      anchor,
      value,
      lamport,
      replicaId: 'r1',
    });
    const c = mk(1, undefined, 1, 'C');
    const a = mk(2, c.id, 2, 'A');
    const t = mk(3, a.id, 3, 'T');
    const x = mk(4, a.id, 4, 'X'); // inserted after A, before A's existing child T
    for (const op of [c, a, t, x]) applyInsert(rga, op);

    expect(getSequence(rga).map((e) => e.value).join('')).toBe('CAXT');

    const del: Operation<string> = {
      id: createOpId('r2', 1),
      type: 'delete',
      target: a.id,
      lamport: 5,
      replicaId: 'r2',
    };
    expect(applyDelete(rga, del)).toBe(true);
    expect(isElementDeleted(rga, a.id)).toBe(true);
    expect(getSequence(rga).map((e) => e.value).join('')).toBe('CXT');
    expect(markPayloadReclaimed(rga, a.id)).toBe(true);
    expect(traverse(rga).map((e) => e.id)).toEqual([c.id, a.id, x.id, t.id]);
  });
});
