# Cursed Checklist

Collaborative to-do list built on the Bones CRDT kernel (`/kernel`). Task KER-080 in `.kiro/specs/crdt-kernel/tasks.md`.

This is one of the two separate application folders required by the Skeleton Crew category (the other is `apps/graveyard-whiteboard`).

## What works today

- Add an item (it goes after the last visible item) and complete it. Completing **buries** the item: it is a CRDT delete, which leaves a tombstone.
- Open the page in two or more tabs of the same browser and they stay in sync. Concurrent adds end up in the same order in every tab.
- A tab opened late, or reloaded, catches up from the other open tabs.
- Each page load gets a new replica ID (`tab-<8 hex>.0`), shown at the bottom of the page. An ID is never reused: a reload always gets a new one.
- If the control page exorcises a tab, that tab shows a banner with a **Rejoin** button (and how many of its offline edits were not accepted and will be discarded). Rejoin asks the other tabs for a snapshot, and the first valid answer wins. The tab then reloads itself and restarts from the snapshot as the next incarnation of its ID (`tab-1a2b3c4d.0` becomes `tab-1a2b3c4d.1`), with the same list as the others. If no tab answers within 5 seconds it says so, and you can press Rejoin again.

**Not built yet:** other browsers or devices, persistence. Membership, the stable frontier and garbage collection exist but only run while the control page is open. The tombstones of completed items always stay; once the frontier passes their delete, only their text is reclaimed.

## Run it

Needs Node 22.12 or newer (Vitest 5).

```bash
cd apps/cursed-checklist
npm ci
npm run dev        # open the printed URL in two tabs
npm test           # 219 tests
npm run build      # typecheck + production build into dist/
```

`.npmrc` sets `legacy-peer-deps=true`. Without it, npm 10 fails to resolve the Vitest 5 and Vite 8 dependency tree (`Cannot read properties of null (reading 'edgesOut')`). All dependencies are pinned to exact versions.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds the app (running its tests first) with `BASE_PATH=/<repo>/cursed-checklist/`, runs `node scripts/assemble-site.mjs` to put every built app under `_site/<app>/` with a landing page, and publishes it with the official Pages actions. It is live: `https://keerthivasan-skv.github.io/Bones/`, the app at `.../cursed-checklist/` and the control page at `.../cursed-checklist/control.html`. (For a fork, the one-time setup is Settings, Pages, Build and deployment, Source: "GitHub Actions"; only the repository owner can change it.) Locally the same build works with `BASE_PATH` unset (`/`).

The app and the control page must be opened from the same site (they share a `BroadcastChannel`), in windows of the same browser.

## How it works

| File | Role |
|------|------|
| `src/replica.ts` | creates the CRDT with a fresh replica ID; `isItem` and `visibleItems` decide what the UI shows |
| `src/transport.ts` | a thin wrapper over `BroadcastChannel` |
| `src/protocol.ts` | the wire format: one place that encodes and parses every message (untrusted input) |
| `src/sync.ts` | `startSync(crdt, transport)`: broadcasts local operations, applies received ones, answers "hello" messages, carries the coordinator's messages to the kernel, and can pause (stall) |
| `src/session.ts` | the one replica and one sync per page load (restored from a stored snapshot after a Rejoin) |
| `src/rejoin.ts` | Rejoin over the wire: a surviving tab answers an exorcised tab's `snapshot-request`; the exorcised tab keeps the first valid `snapshot` |
| `src/rejoinSession.ts` | Rejoin across the reload: stores the snapshot in `sessionStorage`, restores it at startup as the next incarnation of the old ID, and counts the edits that will be discarded |
| `control.html`, `src/control.tsx`, `src/ControlApp.tsx`, `src/controlSession.ts` | the control page: a second page of the same build (same origin, so it shares the channel) that runs the coordinator |
| `src/panel.ts`, `src/GraveyardPanel.tsx` | the Graveyard panel: `panelModel` computes the numbers (tested without a browser), the component renders them and has the Stall and Stress buttons |
| `src/coordinatorAdapter.ts` | runs the pure coordinator core (`coordinator/src/core.ts`) on a transport with an injected clock |
| `src/App.tsx`, `src/main.tsx` | the UI (no `React.StrictMode`, see the comment in `main.tsx`) |

**Catch-up.** `BroadcastChannel` does not replay messages sent before a tab opened. So every tab sends a hello with its version vector when it starts and every 3 seconds. A tab that hears a hello replies with the operations the sender lacks (`crdt.opsSince`). A tab that missed a message, or joined late, therefore catches up within one interval. Duplicated or reordered messages are harmless: the kernel drops duplicates and buffers operations that arrive early.

**Untrusted input.** Any script on the same origin can post to the channel. `sync.ts` ignores anything that is not a well-formed message or a valid operation (the kernel validates operations), and never throws. An operation whose value is not a well-formed item is still **applied**, because dropping it would leave a gap in its author's sequence and stall every later operation from that author. The UI hides it (`visibleItems`). Item text is rendered as text by React, never as HTML.

**Coordinator messages and pause.** `sync.ts` also speaks the coordinator's half of the wire format (`view`, `frontier`, `prepare`, `release`): a view goes to `crdt.updateMembership`, a frontier to `crdt.updateStableFrontier` (the kernel applies it only at this tab's epoch), `prepare` freezes the named tab and replies with the sequence number it holds, and `release` ends the freeze. `sync.pause()` is the demo's "stall": a paused tab sends and hears nothing, its local edits keep working and are counted, and `resume()` sends them and says hello. `sync.getStats()` reports whether the tab is paused, how many edits are unsent, and how many operations were refused by fencing, per author. **The control page** (`control.html`, next to the app page in the same build) runs the coordinator: open it once, keep it open, and every tab that says hello joins. It lists the members with when they were last heard, the epoch and the stable frontier, has an **Exorcise** button per member (and **Abort** while one is being prepared), and shows each exorcised tab with its cutoff and whether every tab holds its operations. A tab that was exorcised shows a banner and refuses new edits. **The Graveyard panel** (below the list) shows `tombstones (structure kept)`, how many payloads were reclaimed, `estimated payload bytes reclaimed` (the JSON length of the payloads, not memory), the stable frontier, the epoch, the members and the exorcised tabs, and says so when no control page is running. **Stall this tab** makes the tab send and hear nothing (its edits are counted as unsent), and **Stress** adds 200 items of 100 characters and buries them, through the same path as a click. A survivor's panel shows how many operations it refused from an exorcised tab. **Rejoin** (`rejoin.ts`, `rejoinSession.ts`): the exorcised tab sends `{ t: 'snapshot-request', from }`. A tab that is an active member in its own view, is not stalled, and sees the requester as evicted, answers after a random 0 to 300 ms wait with `{ t: 'snapshot', to, snap }` (the kernel's `serializeSnapshot`); a tab that sees another answer to the same requester first drops its own. The exorcised tab validates the first answer with the kernel's `deserializeSnapshot` and requires it to show its own old ID as evicted, stores it in `sessionStorage`, and reloads. At startup the page restores it with `CRDT.fromSnapshot` under the next incarnation of the old ID, removing the stored copy first, so a second reload cannot restore it again; anything unusable gives a fresh replica like a new tab. The replica is not swapped under the running page. For a recording, press Stall BEFORE Stress: with every tab live the frontier catches up within a few seconds and the zeros never show.

## Tests

219 tests in 8 files (`replica.test.ts` 13, `transport.test.ts` 4, `sync.test.ts` 109, `protocol.test.ts` 45, `sync.coordinator.test.ts` 12, `coordinatorAdapter.test.ts` 17, `panel.test.ts` 11, `rejoin.test.ts` 8), all run with `npm test`:

- `sync.test.ts` uses in-memory networks (`src/test-support.ts`) and a real `BroadcastChannel`. It includes 25 seeded runs where three replicas edit over a network that loses 30% and duplicates 20% of messages and delivers in random order, then recovers and must converge. It also has a table of 58 malformed or hostile messages, each of which must change nothing and send nothing.
- `sync.ts` was mutation-checked by hand: 23 deliberate bugs (drop the hello reply, subscribe after the first hello, accept an array version vector, rethrow errors, and so on), each caught by a test.
- `rejoin.test.ts` has the answering rules (who may answer, who must stay silent, the first answer wins), the asking rules (unusable replies ignored, the first valid one kept, the 5 second timeout), the restart from a stored snapshot (nine kinds of unusable stored data each give a fresh replica), and one smoke test of the whole story with the real tab code and the real coordinator: stall, exorcise, ask, restart as `c.1` with the same list, edits accepted again, then a second cycle as `c.2`. 35 deliberate bugs in `rejoin.ts`, `rejoinSession.ts`, `replica.ts`, `protocol.ts` and `sync.ts` were applied one at a time; all were caught (one survived the first version of the smoke test, because the tab's cutoff was 0, and the scenario was changed so it is caught).
- Not covered by automated tests in the repo: React rendering (including the Rejoin banner and the reload itself). It was checked once by hand against the built app, with three real Edge tabs driven by a throwaway script (add, complete, concurrent adds, late tab, reload, HTML in an item, hostile messages on the channel). That script is not committed.

## Known limitations

- **Same browser only.** `BroadcastChannel` connects tabs of one browser and origin. It does not reach other browsers or machines.
- **Rejoin needs a running member.** Another tab of the app that is still a member and not stalled has to answer, and the page needs `sessionStorage`. The control page has to be open for the new ID to be admitted: until a membership view lists it, the other tabs refuse its edits. The edits the exorcised tab made after its cutoff are discarded, not merged. A tab restored from a snapshot starts with an empty operation log, so other tabs, not it, supply anything older than the snapshot.
- **No persistence.** If every tab is closed, the list is gone. A reloaded tab gets its content back only while another tab is open.
- **Hidden tabs sync slowly.** Browsers throttle timers in background tabs, so a hidden tab may take up to a minute to catch up.
- **No authentication.** An operation names its author, and nothing proves it. A script on the same origin can forge operations (the kernel assumes honest replicas; see the repository README).
- **Control messages are not authenticated.** Any script on the same origin can post a `view`, a `frontier` or a `prepare`. A forged `prepare` freezes the named tab's operations on every other tab until a `release` or an eviction view arrives, and a forged `frontier` for the right epoch could authorize reclaiming a payload too early. Tabs only act on a `prepare` for their own epoch, which stops a replayed old one. The design assumes honest peers.
- **A hello is answered with everything the sender lacks.** There is no rate limit; this is fine for tabs of one browser.
- Items are plain text, 1 to 200 characters. No editing or reordering.

This project is an educational CRDT implementation. It is not production-ready and does not replace Yjs, Automerge or Loro.
