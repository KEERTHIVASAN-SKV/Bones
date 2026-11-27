# Cursed Checklist

Collaborative to-do list built on the Bones CRDT kernel (`/kernel`). Task KER-080 in `.kiro/specs/crdt-kernel/tasks.md`.

This is one of the two separate application folders required by the Skeleton Crew category (the other is `apps/graveyard-whiteboard`).

## What works today

- Add an item (it goes after the last visible item) and complete it. Completing **buries** the item: it is a CRDT delete, which leaves a tombstone.
- Open the page in two or more tabs of the same browser and they stay in sync. Concurrent adds end up in the same order in every tab.
- A tab opened late, or reloaded, catches up from the other open tabs.
- Each page load gets a new replica ID (`tab-<8 hex>.0`), shown at the bottom of the page. The ID is never stored.

**Not built yet:** the Graveyard panel, membership and eviction, the stable frontier, garbage collection, other browsers or devices. The tombstones of completed items are kept and never reclaimed.

## Run it

Needs Node 22.12 or newer (Vitest 5).

```bash
cd apps/cursed-checklist
npm ci
npm run dev        # open the printed URL in two tabs
npm test           # 179 tests
npm run build      # typecheck + production build into dist/
```

`.npmrc` sets `legacy-peer-deps=true`. Without it, npm 10 fails to resolve the Vitest 5 and Vite 8 dependency tree (`Cannot read properties of null (reading 'edgesOut')`). All dependencies are pinned to exact versions.

## How it works

| File | Role |
|------|------|
| `src/replica.ts` | creates the CRDT with a fresh replica ID; `isItem` and `visibleItems` decide what the UI shows |
| `src/transport.ts` | a thin wrapper over `BroadcastChannel` |
| `src/protocol.ts` | the wire format: one place that encodes and parses every message (untrusted input) |
| `src/sync.ts` | `startSync(crdt, transport)`: broadcasts local operations, applies received ones, answers "hello" messages, carries the coordinator's messages to the kernel, and can pause (stall) |
| `src/session.ts` | the one replica and one sync per page load |
| `src/App.tsx`, `src/main.tsx` | the UI (no `React.StrictMode`, see the comment in `main.tsx`) |

**Catch-up.** `BroadcastChannel` does not replay messages sent before a tab opened. So every tab sends a hello with its version vector when it starts and every 3 seconds. A tab that hears a hello replies with the operations the sender lacks (`crdt.opsSince`). A tab that missed a message, or joined late, therefore catches up within one interval. Duplicated or reordered messages are harmless: the kernel drops duplicates and buffers operations that arrive early.

**Untrusted input.** Any script on the same origin can post to the channel. `sync.ts` ignores anything that is not a well-formed message or a valid operation (the kernel validates operations), and never throws. An operation whose value is not a well-formed item is still **applied**, because dropping it would leave a gap in its author's sequence and stall every later operation from that author. The UI hides it (`visibleItems`). Item text is rendered as text by React, never as HTML.

**Coordinator messages and pause.** `sync.ts` also speaks the coordinator's half of the wire format (`view`, `frontier`, `prepare`, `release`): a view goes to `crdt.updateMembership`, a frontier to `crdt.updateStableFrontier` (the kernel applies it only at this tab's epoch), `prepare` freezes the named tab and replies with the sequence number it holds, and `release` ends the freeze. `sync.pause()` is the demo's "stall": a paused tab sends and hears nothing, its local edits keep working and are counted, and `resume()` sends them and says hello. `sync.getStats()` reports whether the tab is paused, how many edits are unsent, and how many operations were refused by fencing, per author. **The coordinator itself (the `/control` page) and the panel that shows these numbers are not built yet**, so nothing in the running app sends these messages today.

## Tests

179 tests in 5 files (`replica.test.ts` 11, `transport.test.ts` 4, `sync.test.ts` 109, `protocol.test.ts` 43, `sync.coordinator.test.ts` 12), all run with `npm test`:

- `sync.test.ts` uses in-memory networks (`src/test-support.ts`) and a real `BroadcastChannel`. It includes 25 seeded runs where three replicas edit over a network that loses 30% and duplicates 20% of messages and delivers in random order, then recovers and must converge. It also has a table of 58 malformed or hostile messages, each of which must change nothing and send nothing.
- `sync.ts` was mutation-checked by hand: 23 deliberate bugs (drop the hello reply, subscribe after the first hello, accept an array version vector, rethrow errors, and so on), each caught by a test.
- Not covered by automated tests in the repo: React rendering. It was checked once by hand against the built app, with three real Edge tabs driven by a throwaway script (add, complete, concurrent adds, late tab, reload, HTML in an item, hostile messages on the channel). That script is not committed.

## Known limitations

- **Same browser only.** `BroadcastChannel` connects tabs of one browser and origin. It does not reach other browsers or machines.
- **No persistence.** If every tab is closed, the list is gone. A reloaded tab gets its content back only while another tab is open.
- **Hidden tabs sync slowly.** Browsers throttle timers in background tabs, so a hidden tab may take up to a minute to catch up.
- **No authentication.** An operation names its author, and nothing proves it. A script on the same origin can forge operations (the kernel assumes honest replicas; see the repository README).
- **Control messages are not authenticated.** Any script on the same origin can post a `view`, a `frontier` or a `prepare`. A forged `prepare` freezes the named tab's operations on every other tab until a `release` or an eviction view arrives, and a forged `frontier` for the right epoch could authorize reclaiming a payload too early. Tabs only act on a `prepare` for their own epoch, which stops a replayed old one. The design assumes honest peers.
- **A hello is answered with everything the sender lacks.** There is no rate limit; this is fine for tabs of one browser.
- Items are plain text, 1 to 200 characters. No editing or reordering.

This project is an educational CRDT implementation. It is not production-ready and does not replace Yjs, Automerge or Loro.
