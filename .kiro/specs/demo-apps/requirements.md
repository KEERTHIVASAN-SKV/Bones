# Demo Apps Requirements

Spec for the two applications and the coordinator that show the Bones kernel working. It is derived from the demo script below, so every requirement traces to a step that must work on the **deployed** URL. The kernel's own requirements are in `.kiro/specs/crdt-kernel/`.

## The demo script (60 to 90 seconds)

| Step | What the viewer sees |
|------|----------------------|
| D1 | Two windows side by side, each with the Checklist. Items are added and buried; both windows stay in sync. A third tab opens late and catches up. |
| D2 | **Stress**: 200 items of about 100 characters are added, then all buried. The panel shows tombstones going up and payload bytes reclaimed still at 0, because the stable frontier waits for the slowest replica. |
| D3 | **Stall** on tab C. The panel shows the frontier stuck behind C. Reclaimed stays at 0 while edits continue. |
| D4 | On `/control`, **Exorcise** C. The epoch increases, the frontier moves, and payload bytes reclaimed jump. Tombstones (structure) stay, and the label says so. |
| D5 | Tab C resumes and tries to edit. Its edits beyond the cutoff are rejected, and the panel says so. |
| D6 | C presses **Rejoin**: a new replica ID, a snapshot restore, and the same list as the others. |
| D7 | Closing line: the numbers from the benchmark table. |

## Glossary

- **Tombstone**: a deleted element. Its structural node stays after Stage 1 GC; only its payload is reclaimed.
- **Stable frontier**: the component-wise minimum, over active members, of the version vectors they acknowledged.
- **Stall**: a tab that sends and receives nothing (`pause()`), as if it were offline. It keeps its local edits.
- **Exorcise**: the operator evicts a member from the `/control` page.
- **Rejoin**: an evicted tab returns from a snapshot as a new incarnation (`tab-xxxx.1`).

## Requirements

### R1. Live sync between windows (D1)
1. WHEN an item is added or buried in one tab, THE other tabs of the same app and origin SHALL show the change.
2. WHEN a tab opens late or reloads, IT SHALL show the same items as the other tabs within one hello interval.
3. WHEN two tabs add at the same moment, ALL tabs SHALL show the same order.
4. THE app SHALL ignore any message that is not a well-formed message or a valid operation, and SHALL NOT throw.
5. Item text SHALL be rendered as text, never as HTML.

Status: **done** for the Checklist (`apps/cursed-checklist`, 124 tests, checked in three real Edge tabs).

### R2. Stress (D2)
1. A **Stress** button SHALL add 200 items of about 100 characters each and then bury them, using `crdt.insert`, `crdt.delete` and `sync.sendOp` exactly as a user's clicks do.
2. THE numbers shown afterwards SHALL come from the kernel's real GC path, not from a simulation.

### R3. Stall (D3)
1. A **Stall** button SHALL call `sync.pause()`: the tab stops sending and receiving, and keeps its local edits.
2. A paused tab SHALL show how many local edits have not been sent.
3. Staleness SHALL NOT be simulated with timers. Browsers throttle background tabs, so the demo is recorded in two separate windows.

### R4. Graveyard panel (D2, D3, D4)
1. THE panel SHALL show: tombstones **(structure kept)**, payload bytes reclaimed, stable frontier, epoch, members, evicted members.
2. THE panel SHALL NOT say "tombstones removed": Stage 1 GC reclaims payloads only, and the tombstone count never goes down.
3. WHEN a rejected edit is detected, THE panel SHALL say so (R6).

### R5. Control page and Exorcise (D4)
1. A `/control` page, in the same Vite build and origin as the app, SHALL list members with their last-heard time, the frontier and the epoch.
2. EACH member SHALL have an **Exorcise** button. Eviction is manual only; it SHALL NOT happen automatically.
3. THE coordinator SHALL treat a hello as the acknowledgement of a member's version vector (no separate ack message).
4. EVICTION SHALL follow the kernel's two-phase rule (`requirements.md` section 10 of the kernel spec): the cutoff is supplied by the coordinator from the survivors' version vectors.

### R6. Fencing is visible (D5)
1. WHEN a tab that was evicted keeps editing, SURVIVORS SHALL reject its operations beyond the cutoff.
2. THE evicted tab and the panel SHALL show a clear message that edits were rejected.

### R7. Rejoin (D6)
1. AN evicted tab SHALL show "evicted" and a **Rejoin** button.
2. REJOIN SHALL restore from a snapshot under a new replica ID, and feed every later operation through the normal `applyOp` path.
3. AFTER rejoin, THE tab SHALL show the same items as the others.

### R8. Whiteboard (second app)
1. `apps/graveyard-whiteboard` SHALL be a separate app folder (hackathon rule) with strokes stored as sequence elements whose payload is an array of points, so payloads are large.
2. IT SHALL support live drawing in two windows and undo by burying a stroke.
3. IT SHALL show the same panel and `/control` page, and use its own channel name (`bones-whiteboard`).

### R9. Deployed and verified (all steps)
1. BOTH apps SHALL be deployed to public URLs (GitHub Pages through GitHub Actions, each with its own Vite `base`).
2. EVERY demo step SHALL be run on the **deployed** URL, in two separate windows, before the video is recorded. A failed step is the next day's first task.

### R10. Honest numbers (D7)
1. A benchmark script outside `kernel/src` SHALL report operations, payload bytes held in the sequence and in the log before and after GC, the tombstone count (stated as unchanged) and run time.
2. THE README SHALL contain only numbers that script printed, and SHALL state the limits plainly.

## Out of scope

More app unit tests beyond one smoke test per feature, persistence (IndexedDB), WebRTC, login, rooms, editing or reordering items, undo, drag and drop, Stage 2 structural GC, a third app, extra data types.
