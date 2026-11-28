# Coordinator

Decides who is a member, what is stable, and who gets evicted, for the Bones demo apps. It collects version-vector acknowledgements (a member's hello is its ack), computes the stable frontier, publishes membership, and runs the manual two-phase "Exorcise" eviction (requirements.md section 10.3). It never evicts a replica automatically. Task KER-077 in `.kiro/specs/crdt-kernel/tasks.md`; the design is in `.kiro/specs/demo-apps/design.md`.

## What exists

`src/core.ts` is the whole decision logic as a **pure core**: it takes what happened (a hello, a reply, a time) and returns the effects the caller must perform (broadcast a view, broadcast a frontier, ask survivors to freeze a target). It has no I/O, no timers, no clock reads and no randomness, and `scripts/check-purity.mjs` enforces that. The caller passes `now`.

```ts
import { CoordinatorCore } from '@bones/coordinator'; // the apps import it through an alias, like @bones/kernel

const core = new CoordinatorCore();
const effects = core.onHello({ from: 'tab-1.0', epoch: 0, vv: crdt.getVV() }, now); // join, or ack
core.startEviction('tab-3.0');                          // the operator pressed Exorcise
core.onPrepared({ from, target, epoch, seq }, now);    // a survivor's reply: cutoff = max of the replies
core.getStatus(now, 10_000);                            // members, stalled flags, frontier, evictions
```

A tab does what each effect says with the kernel: `view` becomes `crdt.updateMembership(view)`, `frontier` becomes `crdt.updateStableFrontier(vv, epoch)`, `prepare` becomes `crdt.holdAuthor(target)` followed by a `prepared` reply with the seq it returns, and `release` becomes `crdt.releaseAuthor(target)`.

## Run the tests

```bash
cd coordinator
npm ci
npm run typecheck
npm run lint
npm test          # 116 tests: 104 on the core (8 with real kernel replicas) and 12 whole-stack seeds (tests/chaos.integration.test.ts)
```

The coordinator imports the kernel source through an alias, so it needs no kernel install of its own. Dev dependencies are pinned to the kernel's versions; `npm audit` reports the same dev-tooling advisories as the kernel.

## Where it runs

In the Cursed Checklist, `control.html` (a second page of the same build, so it shares the tabs' origin and channel) runs the core through `apps/cursed-checklist/src/coordinatorAdapter.ts`. The Whiteboard will get the same page when the shared code is extracted. A Node service is not built. Limits to know about:

- The core keeps its state in memory. Reloading the control page resets the coordinator; open tabs keep their view.
- A reloaded tab gets a new replica ID. Its old ID stays a member, silent, and holds the frontier back until it is exorcised.
- Any script on the same origin can post control messages. Replicas are assumed to report their version vectors honestly.

This project is an educational CRDT implementation. It is not production-ready and does not replace Yjs, Automerge or Loro.
