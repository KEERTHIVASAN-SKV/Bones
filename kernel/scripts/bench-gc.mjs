#!/usr/bin/env node
/**
 * GC benchmark (DA-10, requirements R10). What does evicting a stalled replica free?
 *
 *   cd kernel && npm run build && node scripts/bench-gc.mjs [--ops 2000] [--seed 20261128]
 *   (or: npm run bench:gc, which builds first)
 *
 * It uses the BUILT kernel (`../dist/index.js`), so it measures the code that ships. It lives
 * outside `kernel/src`, so the purity rules (no clock, no randomness) do not apply to it: it reads
 * the clock only to print run times, and its randomness is a seeded generator, so every number
 * except the run times is the same on every run.
 *
 * The scenario: three replicas (a.0, b.0, c.0) edit and sync completely until op K (10% of N);
 * then c.0 STALLS (it neither sends nor receives again) and only a.0 and b.0 keep editing. About
 * 40% of the operations are deletes, and every inserted payload is a 100-character text. The
 * coordinator's part is played here by the kernel's own functions: every 50 operations each live
 * replica "acknowledges" its version vector, the frontier is `computeStableFrontier` over the
 * ACTIVE members, and the eviction is `removeReplica` with the cutoff the survivors hold.
 *
 * Four runs replay the SAME history (same seed, same operations in the same order):
 *   1. no GC at all: the frontier is never applied (the upper bound);
 *   2. c stalled and never evicted (this is also the state just BEFORE the eviction);
 *   3. the same run after c is evicted and the frontier moves;
 *   4. nobody stalled: c keeps receiving everything (a reference for what GC reaches when no
 *      replica falls behind).
 *
 * "Estimated bytes" are the kernel's `estimatePayloadSize`: the JSON LENGTH of a payload, not the
 * memory the browser uses. The sequence and the operation log hold the SAME payload objects, so the
 * two byte columns must not be added together. Stage 1 GC drops payloads only: the tombstone count
 * never goes down, and the script checks that.
 *
 * Output: Markdown on stdout. Exit code 1 if a built-in check fails (the visible sequence differs
 * between runs, the survivors do not converge, or the eviction changed the tombstone count).
 */
import { performance } from 'node:perf_hooks';

let kernel;
try {
  kernel = await import('../dist/index.js');
} catch (error) {
  console.error('bench-gc: cannot load ../dist/index.js. Run `npm run build` in kernel/ first.');
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(2);
}
const { CRDT, computeStableFrontier, createMembership, estimatePayloadSize, removeReplica } = kernel;

// ---------------------------------------------------------------- settings

const argv = process.argv.slice(2);
function option(name, fallback, min) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(argv[i + 1]);
  if (!Number.isSafeInteger(value) || value < min) {
    console.error(`bench-gc: --${name} needs an integer of at least ${min}, got "${argv[i + 1]}"`);
    process.exit(2);
  }
  return value;
}
const OPS = option('ops', 2000, 100);
const SEED = option('seed', 20261128, 0);
const STALL_AT = Math.floor(OPS * 0.1); // c is live for the first 10% of the operations
const DELETE_SHARE = 0.4;
const PAYLOAD_CHARS = 100;
const ACK_EVERY = 50; // operations between two rounds of hellos (acknowledgements + a new frontier)
const IDS = ['a.0', 'b.0', 'c.0'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** Small seeded generator (mulberry32): the same seed always gives the same numbers. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- one run

/**
 * Replay the seeded history.
 *
 * @param {'no-gc' | 'stalled' | 'healthy'} mode
 *   no-gc: c stalls and no frontier is ever applied; stalled: c stalls, frontier applied,
 *   `evict()` available; healthy: c never stalls.
 */
function simulate(mode) {
  const random = seededRandom(SEED);
  const start = performance.now();
  const initial = createMembership(IDS);
  const replicas = new Map(IDS.map((id) => [id, new CRDT(id, initial)]));
  const acks = new Map(); // the last version vector each replica reported (what its hello carries)
  let stalled = false;

  const live = () => IDS.filter((id) => !(stalled && id === 'c.0'));
  const refreshAcks = () => {
    for (const id of live()) acks.set(id, new Map(replicas.get(id).getVV()));
  };
  const pushFrontier = () => {
    if (mode === 'no-gc') return;
    refreshAcks();
    const view = replicas.get('a.0').getMembershipView();
    const frontier = computeStableFrontier(acks, view.activeMembers);
    for (const id of live()) replicas.get(id).updateStableFrontier(frontier, view.epoch);
  };
  const payload = () => {
    let text = '';
    for (let i = 0; i < PAYLOAD_CHARS; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return { text };
  };

  for (let i = 0; i < OPS; i++) {
    if (i === STALL_AT) {
      refreshAcks(); // c's last hello, just before it stalls: this is what keeps holding the frontier back
      if (mode !== 'healthy') stalled = true;
    }
    // From op K on only a.0 and b.0 write, in every run, so the history is the same in all of them.
    const pool = i < STALL_AT ? IDS : ['a.0', 'b.0'];
    const author = pool[Math.floor(random() * pool.length)];
    const replica = replicas.get(author);
    const visible = replica.getSequence();
    let op;
    if (visible.length > 0 && random() < DELETE_SHARE) {
      op = replica.delete(visible[Math.floor(random() * visible.length)].id);
    } else {
      const anchor = visible.length > 0 && random() < 0.9 ? visible[Math.floor(random() * visible.length)].id : undefined;
      op = replica.insert(anchor, payload());
    }
    for (const id of live()) {
      if (id !== author) replicas.get(id).applyOp(op);
    }
    if ((i + 1) % ACK_EVERY === 0) pushFrontier();
  }
  pushFrontier();

  /** Numbers read from a.0 (a survivor) at this moment. */
  function measure() {
    const a = replicas.get('a.0');
    let sequenceBytes = 0;
    for (const element of a.getAllElements()) {
      if (!element.payloadReclaimed && element.value !== undefined) sequenceBytes += estimatePayloadSize(element.value);
    }
    let logBytes = 0;
    for (const op of a.getOps()) {
      if (op.type === 'insert' && op.value !== undefined) logBytes += estimatePayloadSize(op.value);
    }
    // Ground truth, from the replicas' real version vectors (not from the frontier the kernel was
    // given): a payload may only be reclaimed if SOME delete of its element has been applied by
    // EVERY active member. The stalled replica counts as active until it is evicted.
    const activeNow = [...a.getMembershipView().activeMembers];
    const deletesOf = new Map();
    for (const op of a.getOps()) {
      if (op.type !== 'delete') continue;
      if (!deletesOf.has(op.target)) deletesOf.set(op.target, []);
      deletesOf.get(op.target).push(op);
    }
    const seqOf = (opId) => Number(opId.slice(opId.lastIndexOf(':') + 1));
    let unsafeReclaims = 0;
    for (const element of a.getAllElements()) {
      if (!element.deleted || !element.payloadReclaimed) continue;
      const safe = (deletesOf.get(element.id) ?? []).some((d) =>
        activeNow.every((member) => (replicas.get(member).getVV().get(d.replicaId) ?? 0) >= seqOf(d.id))
      );
      if (!safe) unsafeReclaims++;
    }
    const stats = a.getGCStats();
    return {
      unsafeReclaims,
      tombstones: stats.tombstoneCount,
      reclaimed: stats.payloadsReclaimed,
      bytesSaved: stats.bytesSaved,
      sequenceBytes,
      logBytes,
      visible: a.getSequence().map((e) => `${e.id}:${e.value.text}`),
      elapsedMs: performance.now() - start,
    };
  }

  /** The operator exorcises c.0: the cutoff is what the survivors hold of it, then the frontier moves. */
  function evict() {
    const a = replicas.get('a.0');
    const b = replicas.get('b.0');
    const cutoff = Math.max(a.getVV().get('c.0') ?? 0, b.getVV().get('c.0') ?? 0);
    const view = removeReplica(a.getMembershipView(), 'c.0', cutoff);
    a.updateMembership(view);
    b.updateMembership(view);
    const frontier = computeStableFrontier(acks, view.activeMembers); // c.0 is no longer counted
    a.updateStableFrontier(frontier, view.epoch);
    b.updateStableFrontier(frontier, view.epoch);
    return cutoff;
  }

  const survivorsConverge = () => {
    const text = (id) => replicas.get(id).getSequence().map((e) => `${e.id}:${e.value.text}`).join('|');
    return text('a.0') === text('b.0');
  };
  return { measure, evict, survivorsConverge };
}

// ---------------------------------------------------------------- the four runs

const noGc = simulate('no-gc');
const rowNoGc = noGc.measure();

const stalledRun = simulate('stalled');
const rowStalled = stalledRun.measure(); // c stalled, never evicted (= before the eviction)
const evictStart = performance.now();
const cutoff = stalledRun.evict();
const evictMs = performance.now() - evictStart;
const rowEvicted = stalledRun.measure();

const healthyRun = simulate('healthy');
const rowHealthy = healthyRun.measure();

// ---------------------------------------------------------------- checks and report

const sameVisible = (x, y) => x.visible.length === y.visible.length && x.visible.every((v, i) => v === y.visible[i]);
const checks = [
  ['the visible list is identical in all four runs (GC changes only what is held, never what is shown)',
    [rowStalled, rowEvicted, rowHealthy].every((row) => sameVisible(rowNoGc, row))],
  ['a.0 and b.0 hold the same list after the eviction', stalledRun.survivorsConverge()],
  ['the eviction did not change the tombstone count (structure is kept)', rowStalled.tombstones === rowEvicted.tombstones],
  ['nothing was reclaimed in the "no GC" run', rowNoGc.reclaimed === 0 && rowNoGc.bytesSaved === 0],
  ['GC safety, checked against the replicas\' real version vectors: no payload was reclaimed unless every active member had applied a delete of it (all four runs, and the stalled replica counts as active until it is evicted)',
    [rowNoGc, rowStalled, rowEvicted, rowHealthy].every((r) => r.unsafeReclaims === 0)],
  ['while c is stalled and not evicted, fewer payloads are reclaimed than when nobody is stalled', rowStalled.reclaimed < rowHealthy.reclaimed],
  ['the eviction reclaimed payloads and freed estimated bytes', rowEvicted.reclaimed > rowStalled.reclaimed && rowEvicted.bytesSaved > rowStalled.bytesSaved],
  ['after the eviction the stalled run holds exactly what the nobody-stalled run holds', rowEvicted.sequenceBytes === rowHealthy.sequenceBytes && rowEvicted.logBytes === rowHealthy.logBytes],
  ['the operation log keeps no payload that the sequence has dropped (log redaction, design decision D-A)',
    [rowNoGc, rowStalled, rowEvicted, rowHealthy].every((r) => r.logBytes === r.sequenceBytes)],
];

const n = (value) => value.toLocaleString('en-US');
const ms = (value) => value.toFixed(1);
const row = (label, r) =>
  `| ${label} | ${n(r.tombstones)} | ${n(r.visible.length)} | ${n(r.reclaimed)} of ${n(r.tombstones)} | ${n(r.sequenceBytes)} | ${n(r.logBytes)} | ${n(r.bytesSaved)} | ${ms(r.elapsedMs)} |`;
const percent = (part, whole) => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`);

const lines = [
  '### GC benchmark: what evicting a stalled replica frees',
  '',
  `Node ${process.version}, seed ${SEED}, ${n(OPS)} operations (${Math.round(DELETE_SHARE * 100)}% deletes, ${PAYLOAD_CHARS}-character payloads), 3 replicas. ` +
    `c.0 is live for the first ${n(STALL_AT)} operations and then stalls (sends and receives nothing). ` +
    `Numbers are read from survivor a.0. Cutoff used for the eviction: ${cutoff}. Eviction step (membership change + GC pass): ${ms(evictMs)} ms.`,
  '',
  '| run | tombstones (structure kept) | visible items | payloads reclaimed | estimated payload bytes held in the sequence | estimated payload bytes held in the operation log | estimated bytes saved | run time (ms) |',
  '|---|---|---|---|---|---|---|---|',
  row('no GC at all', rowNoGc),
  row('c stalled, never evicted (= before the eviction)', rowStalled),
  row('c stalled, then exorcised (after the eviction)', rowEvicted),
  row('nobody stalled (reference)', rowHealthy),
  '',
  `Eviction freed ${n(rowStalled.sequenceBytes - rowEvicted.sequenceBytes)} of ${n(rowStalled.sequenceBytes)} estimated payload bytes held in the sequence (${percent(rowStalled.sequenceBytes - rowEvicted.sequenceBytes, rowStalled.sequenceBytes)}) ` +
    `and ${n(rowStalled.logBytes - rowEvicted.logBytes)} of ${n(rowStalled.logBytes)} in the operation log (${percent(rowStalled.logBytes - rowEvicted.logBytes, rowStalled.logBytes)}). ` +
    `The tombstone count stayed at ${n(rowEvicted.tombstones)}: Stage 1 GC reclaims payloads, not structure.`,
  '',
  'Estimated bytes are the JSON length of each payload (`estimatePayloadSize`), not memory. The sequence and the log share the same payload objects, so the two byte columns are not added together. Run times depend on the machine; every other number is the same on every run.',
  '',
  'Built-in checks:',
  ...checks.map(([what, ok]) => `- ${ok ? 'pass' : 'FAIL'}: ${what}`),
];
console.log(lines.join('\n'));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
