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

- A **hello** is the acknowledgement of a member's version vector. A hello from an unknown, not-evicted replica adds it to the active set (epoch + 1). A hello from an evicted replica is answered with a rejection carrying the current epoch. A hello at a stale epoch is NOT an acknowledgement: it is answered with the current view. No replica is joined while an eviction is being prepared (a newcomer was not asked to freeze the target); it retries on its next hello.
- `frontier` is the kernel's `stableFrontier` over **active members only**, with an empty vector for a member that has not acknowledged.
- Eviction is manual and two-phase (kernel spec, section 10.3). `startEviction(target)` asks the survivors to freeze the target; each survivor calls `crdt.holdAuthor(target)` and replies with the contiguous seq it returns; when every survivor has replied the cutoff is the **max** of the replies (never derived from time) and the view is published. The eviction is then **pending** until every active member's acknowledged vector holds the target's operations up to the cutoff. That hello **is** the `evict-confirm`, so there is no confirm message; `getStatus` lists who is still backfilling. The first reply of a survivor wins, so a repeated reply cannot inflate the cutoff.
- `abortEviction()` backs out of a prepare that cannot finish (a stalled survivor): the survivors release the target and the operator can exorcise the stalled one instead.
- Retries need no timers in the core: a survivor that has not replied is asked again when it says hello, and the frontier is re-broadcast on a hello at most every `frontierResendMs` (default 3 s), so a lost message cannot strand garbage collection.
- No automatic eviction. A member that has been silent is only shown as stalled.
- Limits: the core keeps its state in memory, so reloading the control page resets the coordinator (open tabs keep their view; keep the control page open). A tab that is reloaded gets a new replica ID and leaves its old ID behind as a silent member that holds the frontier back until it is exorcised.

## Wire format v2

Every message is a JSON string. Everything received is untrusted: parsed in `try/catch`, malformed input ignored, never thrown.

```
{ t: 'op',       op: '<serializeOp output>' }
{ t: 'hello',    from: '<replicaId>', epoch: <number>, vv: { <replicaId>: <seq> } }   // also the ack
{ t: 'view',     view: <serialized membership view> }                                 // from the coordinator
{ t: 'frontier', epoch: <number>, vv: { <replicaId>: <seq> } }                        // from the coordinator
{ t: 'prepare',  target: '<replicaId>', epoch: <number> }                             // from the coordinator: survivors freeze the target
{ t: 'prepared', from: '<replicaId>', target: '<replicaId>', epoch: <number>, seq: <number> }   // a survivor's reply
{ t: 'release',  target: '<replicaId>' }                                              // from the coordinator: an eviction was aborted
{ t: 'rejected', to: '<replicaId>', epoch: <number> }                                 // from the coordinator: a control message was refused
```

`prepare`, `prepared` and `release` are additions to the Nov 26 plan's list of messages. Requirement 10.3 and KER-77 need a prepare round (the survivors must freeze the target and report their seq, otherwise a live target splits them), and the plan's `hello` cannot carry that. There is still no separate confirm message.

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
