/**
 * Operation log tests (KER-015 to KER-017) and cloneRGA (needed by replay).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createOpId, stableStringify } from '../src/utils.js';
import type { OpIdKey, Operation } from '../src/types.js';
import { applyDelete, applyInsert, cloneRGA, createRGA, getSequence, traverse } from '../src/rga.js';
import type { RGAState } from '../src/rga.js';
import {
  appendOp,
  createOpLog,
  getAllOps,
  getOpAt,
  getOpsByReplica,
  logLength,
  replayLog,
  shouldAppendOp,
} from '../src/oplog.js';

const RUNS = { seed: 12345, numRuns: 200 } as const;

const ins = (r: string, seq: number, anchor: OpIdKey | undefined, lamport: number, value: string): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'insert',
  anchor,
  value,
  lamport,
  replicaId: r,
});
const del = (r: string, seq: number, target: OpIdKey, lamport: number): Operation<string> => ({
  id: createOpId(r, seq),
  type: 'delete',
  target,
  lamport,
  replicaId: r,
});

/** Everything observable about an RGA, as deterministic JSON (structure, flags, delete-op index). */
function fingerprint(rga: RGAState<string>): string {
  const deleteOps: Record<string, string[]> = {};
  for (const [id, ops] of rga.deleteOps) deleteOps[id] = [...ops].sort();
  return stableStringify({ elements: traverse(rga), deleteOps });
}

describe('KER-015: append-only log in application order', () => {
  it('starts empty', () => {
    const log = createOpLog<string>();
    expect(logLength(log)).toBe(0);
    expect(getAllOps(log)).toEqual([]);
    expect(getOpAt(log, 0)).toBeUndefined();
  });

  it('stores operations in append order, with a local index independent of the Op ID seq', () => {
    const log = createOpLog<string>();
    const a = ins('r2', 7, undefined, 1, 'a'); // high seq appended first
    const b = ins('r1', 1, undefined, 2, 'b');
    const c = del('r3', 4, a.id, 3);
    expect(appendOp(log, a)).toBe(true);
    expect(appendOp(log, b)).toBe(true);
    expect(appendOp(log, c)).toBe(true);
    expect(getAllOps(log).map((o) => o.id)).toEqual([a.id, b.id, c.id]);
    expect(logLength(log)).toBe(3);
    expect(getOpAt(log, 0)).toBe(a);
    expect(getOpAt(log, 2)).toBe(c);
    expect(getOpAt(log, 3)).toBeUndefined();
    expect(getOpAt(log, -1)).toBeUndefined();
  });

  it('is append-only: the array returned by getAllOps is a copy, so callers cannot remove or reorder', () => {
    const log = createOpLog<string>();
    const a = ins('r1', 1, undefined, 1, 'a');
    const b = ins('r1', 2, a.id, 2, 'b');
    appendOp(log, a);
    appendOp(log, b);
    const snapshot = getAllOps(log);
    snapshot.reverse();
    snapshot.pop();
    expect(getAllOps(log).map((o) => o.id)).toEqual([a.id, b.id]);
    expect(logLength(log)).toBe(2);
  });

  it('getOpsByReplica filters by author and keeps log order', () => {
    const log = createOpLog<string>();
    const r1a = ins('r1', 1, undefined, 1, 'a');
    const r2a = ins('r2', 1, undefined, 2, 'b');
    const r1b = ins('r1', 2, r1a.id, 3, 'c');
    for (const op of [r1a, r2a, r1b]) appendOp(log, op);
    expect(getOpsByReplica(log, 'r1').map((o) => o.id)).toEqual([r1a.id, r1b.id]);
    expect(getOpsByReplica(log, 'r2').map((o) => o.id)).toEqual([r2a.id]);
    expect(getOpsByReplica(log, 'nobody')).toEqual([]);
  });

  it('getOpsByReplica matches the whole replica ID, not a prefix', () => {
    const log = createOpLog<string>();
    appendOp(log, ins('site1', 1, undefined, 1, 'a'));
    appendOp(log, ins('site1.2', 1, undefined, 2, 'b'));
    expect(getOpsByReplica(log, 'site1')).toHaveLength(1);
    expect(getOpsByReplica(log, 'site1.2')).toHaveLength(1);
  });
});

describe('KER-016: deduplication by Op ID', () => {
  it('detects duplicates by Op ID and does not append them', () => {
    const log = createOpLog<string>();
    const a = ins('r1', 1, undefined, 1, 'a');
    expect(shouldAppendOp(log, a)).toBe(true);
    expect(appendOp(log, a)).toBe(true);
    expect(shouldAppendOp(log, a)).toBe(false);
    expect(appendOp(log, a)).toBe(false);
    expect(logLength(log)).toBe(1);
  });

  it('the Op ID is the key, not the contents: a different op with the same ID is a duplicate', () => {
    const log = createOpLog<string>();
    appendOp(log, ins('r1', 1, undefined, 1, 'first'));
    expect(appendOp(log, ins('r1', 1, undefined, 99, 'different content'))).toBe(false);
    expect(getAllOps(log)[0].value).toBe('first');
  });

  it('shouldAppendOp does not modify the log', () => {
    const log = createOpLog<string>();
    const a = ins('r1', 1, undefined, 1, 'a');
    shouldAppendOp(log, a);
    expect(logLength(log)).toBe(0);
  });

  it('uses a set for the check: 20,000 appends and 20,000 duplicate checks stay fast', () => {
    const log = createOpLog<string>();
    const ops = Array.from({ length: 20_000 }, (_, i) => ins('r1', i + 1, undefined, i + 1, 'x'));
    const t0 = Date.now();
    for (const op of ops) appendOp(log, op);
    for (const op of ops) expect(shouldAppendOp(log, op)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000); // a linear scan per check would take ~10 s
    expect(logLength(log)).toBe(20_000);
  });

  it('treats no-op operations like any other: logged exactly once', () => {
    const log = createOpLog<string>();
    const target = createOpId('r1', 1);
    const d1 = del('r2', 1, target, 5);
    const d2 = del('r3', 1, target, 5); // concurrent delete of the same element (a no-op when applied second)
    expect(appendOp(log, d1)).toBe(true);
    expect(appendOp(log, d2)).toBe(true);
    expect(appendOp(log, d2)).toBe(false);
    expect(logLength(log)).toBe(2);
  });
});

describe('cloneRGA', () => {
  it('copies elements, children lists and delete-op sets so the copy is independent', () => {
    const rga = createRGA<string>();
    const a = ins('r1', 1, undefined, 1, 'A');
    const b = ins('r1', 2, a.id, 2, 'B');
    applyInsert(rga, a);
    applyInsert(rga, b);
    applyDelete(rga, del('r2', 1, b.id, 3));
    const copy = cloneRGA(rga);
    expect(fingerprint(copy)).toBe(fingerprint(rga));

    applyInsert(copy, ins('r3', 1, a.id, 9, 'X'));
    applyDelete(copy, del('r3', 2, a.id, 10));
    applyDelete(copy, del('r3', 3, b.id, 11)); // b ALREADY has a delete-op set: it must not be shared
    copy.elements.get(b.id)!.value = 'TAMPERED';
    expect(getSequence(rga).map((e) => e.value)).toEqual(['A']);
    expect(rga.elements.get(b.id)!.value).toBe('B');
    expect(rga.deleteOps.get(a.id)).toBeUndefined();
    expect(rga.deleteOps.get(b.id)).toEqual(new Set([createOpId('r2', 1)]));
    expect(rga.children.get(a.id)).toEqual([b.id]);
  });
});

describe('KER-017: deterministic replay', () => {
  /** A small causal history with a nested insert, a middle insert, a delete and a no-op delete. */
  function history(): Operation<string>[] {
    const c = ins('r1', 1, undefined, 1, 'C');
    const a = ins('r1', 2, c.id, 2, 'A');
    const t = ins('r1', 3, a.id, 3, 'T');
    const x = ins('r2', 1, a.id, 4, 'X'); // lands between A and T
    const d1 = del('r2', 2, a.id, 5);
    const d2 = del('r3', 1, a.id, 5); // concurrent delete of the same element: a no-op
    return [c, a, t, x, d1, d2];
  }

  it('rebuilds the same state as live application', () => {
    const ops = history();
    const live = createRGA<string>();
    const log = createOpLog<string>();
    for (const op of ops) {
      if (op.type === 'insert') applyInsert(live, op);
      else applyDelete(live, op);
      appendOp(log, op);
    }
    const replayed = replayLog(log);
    expect(fingerprint(replayed)).toBe(fingerprint(live));
    expect(getSequence(replayed).map((e) => e.value).join('')).toBe('CXT');
  });

  it('produces byte-identical results on every replay', () => {
    const log = createOpLog<string>();
    for (const op of history()) appendOp(log, op);
    const first = fingerprint(replayLog(log));
    for (let i = 0; i < 5; i++) expect(fingerprint(replayLog(log))).toBe(first);
  });

  it('does not change the log', () => {
    const log = createOpLog<string>();
    for (const op of history()) appendOp(log, op);
    const before = stableStringify(getAllOps(log));
    replayLog(log);
    expect(stableStringify(getAllOps(log))).toBe(before);
  });

  it('replays onto an initial RGA without mutating it', () => {
    const ops = history();
    const head = createOpLog<string>();
    const tail = createOpLog<string>();
    ops.slice(0, 3).forEach((op) => appendOp(head, op));
    ops.slice(3).forEach((op) => appendOp(tail, op));

    const initial = replayLog(head);
    const initialBefore = fingerprint(initial);
    const full = replayLog(tail, initial);

    expect(fingerprint(initial)).toBe(initialBefore); // untouched
    expect(getSequence(initial).map((e) => e.value).join('')).toBe('CAT');
    expect(getSequence(full).map((e) => e.value).join('')).toBe('CXT');

    const whole = createOpLog<string>();
    ops.forEach((op) => appendOp(whole, op));
    expect(fingerprint(full)).toBe(fingerprint(replayLog(whole)));
  });

  it('an empty log replays to an empty RGA', () => {
    expect(traverse(replayLog(createOpLog<string>()))).toEqual([]);
  });

  it('refuses a log that is not in causal order (the caller appended an op before its dependency)', () => {
    const log = createOpLog<string>();
    const a = ins('r1', 1, undefined, 1, 'A');
    const child = ins('r1', 2, a.id, 2, 'B');
    appendOp(log, child); // wrong: child before its anchor
    appendOp(log, a);
    expect(() => replayLog(log)).toThrow(RangeError);
  });

  it('property: replay equals live application, and split replay (snapshot-style) equals full replay', () => {
    const specArb = fc.record({
      replica: fc.integer({ min: 0, max: 2 }),
      pick: fc.integer({ min: 0, max: 10_000 }),
      isDelete: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 40 }), (specs, cut) => {
        const replicas = ['r1', 'r2', 'r3'];
        const clock = new Map<string, number>();
        const seq = new Map<string, number>();
        const inserted: Operation<string>[] = [];
        const ops: Operation<string>[] = [];
        specs.forEach((s, i) => {
          const r = replicas[s.replica];
          const nextSeq = (seq.get(r) ?? 0) + 1;
          seq.set(r, nextSeq);
          if (s.isDelete && inserted.length > 0) {
            const target = inserted[s.pick % inserted.length];
            const lamport = Math.max(clock.get(r) ?? 0, target.lamport) + 1;
            clock.set(r, lamport);
            ops.push(del(r, nextSeq, target.id, lamport));
          } else {
            const anchor = inserted.length === 0 || s.pick % 4 === 0 ? undefined : inserted[s.pick % inserted.length];
            const lamport = Math.max(clock.get(r) ?? 0, anchor?.lamport ?? 0) + 1;
            clock.set(r, lamport);
            const op = ins(r, nextSeq, anchor?.id, lamport, `v${i}`);
            inserted.push(op);
            ops.push(op);
          }
        });

        const live = createRGA<string>();
        const log = createOpLog<string>();
        for (const op of ops) {
          if (op.type === 'insert') applyInsert(live, op);
          else applyDelete(live, op);
          appendOp(log, op);
        }
        expect(fingerprint(replayLog(log))).toBe(fingerprint(live));

        const k = cut % (ops.length + 1);
        const head = createOpLog<string>();
        const tail = createOpLog<string>();
        ops.slice(0, k).forEach((op) => appendOp(head, op));
        ops.slice(k).forEach((op) => appendOp(tail, op));
        expect(fingerprint(replayLog(tail, replayLog(head)))).toBe(fingerprint(live));
      }),
      RUNS
    );
  });
});
