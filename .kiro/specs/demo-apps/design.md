# Demo Apps Design

How the apps and the coordinator are built so that the demo script in `requirements.md` works. The kernel's design is in `.kiro/specs/crdt-kernel/design.md`.

## Components

```
kernel/src            pure CRDT (no DOM, network, storage, clock)
shared/               transport, sync, panel, control page            (S5, adopted in the Nov 26 plan)
coordinator/src/core  pure coordinator logic: membership, acks, frontier, eviction   (S6)
apps/cursed-checklist   Vite app: main page + /control page, channel "bones-checklist"
apps/graveyard-whiteboard   Vite app: main page + /control page, channel "bones-whiteboard"
```

Apps and `shared/` import the kernel and the coordinator core through Vite aliases (no package publishing). The Checklist already imports the kernel this way. Each app keeps its own folder, as the hackathon requires; `shared/` is extracted only on day 4 (Mon Nov 30), once the Checklist flow works, so nothing is shared before it is needed.

## Coordinator

The coordinator logic is a **pure core** with two thin adapters (S6):

- `coordinator/src/core.ts`: state is the epoch, the active set, the evicted map with cutoffs, the last acknowledged version vector per member and a last-heard time supplied by the caller. Functions: `onHello`, `frontier`, `evict`. No timers, no I/O, no clock reads; the caller passes `now`.
- Adapter 1, in the browser: the `/control` page of each app, using the core over the same `BroadcastChannel` as the app tabs. It is a second page **inside each app** because `BroadcastChannel` only connects pages of the same origin (a coordinator on another origin could not reach the tabs).
- Adapter 2, Node: the existing `coordinator/` service folder, for a future WebSocket transport. Not on the demo path.

Rules:

- A **hello** is the acknowledgement of a member's version vector. A hello from an unknown, not-evicted replica adds it to the active set (epoch + 1). A hello from an evicted replica is answered with a rejection carrying the current epoch.
- `frontier` is the kernel's `stableFrontier` over **active members only**, with an empty vector for a member that has not acknowledged.
- `evict(target)` is manual. The cutoff is `max` over the survivors' acknowledged contiguous seq for the target, never derived from time. The kernel spec (section 10) describes the two phases; the reconciliation barrier (survivors backfill and confirm before the eviction is called complete) lives in the coordinator, never in the kernel.
- No automatic eviction.

## Wire format v2

Every message is a JSON string. Everything received is untrusted: parsed in `try/catch`, malformed input ignored, never thrown.

```
{ t: 'op',       op: '<serializeOp output>' }
{ t: 'hello',    from: '<replicaId>', epoch: <number>, vv: { <replicaId>: <seq> } }   // also the ack
{ t: 'view',     view: <serialized membership view> }                                 // from the coordinator
{ t: 'frontier', epoch: <number>, vv: { <replicaId>: <seq> } }                        // from the coordinator
```

- A tab applies a `view` with `crdt.updateMembership(view)` (ignores a non-increasing epoch) and a `frontier` with `crdt.updateStableFrontier(vv)` **only if** its epoch equals the tab's current epoch (kernel requirement 11.8).
- Control messages are fenced by epoch and membership, edit operations by author and cutoff. The two mechanisms are never mixed (kernel requirement 10.0).
- Any script on the same origin can post a `view` or `frontier`. The README keeps the "honest peers" assumption.

## Stall, stress, rejoin

- `Sync.pause()` / `resume()`: a paused sync sends and receives nothing and keeps counting local edits that were not sent. No timers are used to fake staleness.
- Stress: 200 items of about 100 characters, then bury all, through the same code path as user clicks.
- Rejoin: the evicted tab asks for a snapshot (from the coordinator page or a peer), calls `CRDT.fromSnapshot(snapshot, newReplicaId)` with `tab-xxxx.1`, then feeds every later operation through `applyOp`. A replica restored from a snapshot starts a fresh operation log, so it can only answer a hello with operations after the snapshot point (a README limitation).

## Graveyard panel

Reads kernel queries only: `getAllElements()` (tombstones), `getGCStats()` (payloads reclaimed, bytes saved, replicas evicted, frontier), `getMembershipView()`. Labels: `tombstones (structure kept)`, `payload bytes reclaimed`, `stable frontier`, `epoch`, `members`, `evicted`. "Bytes saved" counts payload cleared from **both** the sequence and the operation log (kernel decision D-A).

## Deploy

GitHub Pages through GitHub Actions: check out the whole repo (the aliases read `../../kernel`), Node 22, build each app with its own Vite `base` (its sub-path), publish. Verify the exact workflow steps against the current GitHub Pages documentation before relying on them. Each night the demo script runs on the deployed URL.

## Risks

| Risk | Handling |
|------|----------|
| Background tabs throttle timers, so a hidden tab's hello can slow to once a minute. | Record in two separate windows; make "stall" an explicit button. |
| `BroadcastChannel` is same-origin only. | `/control` is a page inside each app. Each app has its own channel name. |
| Deploying late means failing late. | Deploy the Checklist on day 2, then nightly. |
