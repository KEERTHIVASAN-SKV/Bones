# Bones — Project Specification and AI Handoff Document

| Field | Value |
|---|---|
| Document version | 1.0 |
| Created | 2026-11-11 |
| Owner | Keerthivasan S. (solo participant, B.Tech IT student, India / IST) |
| Project (working name) | **Bones** |
| Status | Pre-implementation. Update Section 22 at the start and end of every working session. |

---

## 0. READ THIS FIRST — rules for any AI working from this document

This document is the single source of truth for the project. It was produced from a long planning conversation between the owner and Claude (Anthropic). Everything the owner explicitly chose is marked **[DECIDED]**. Gaps that Claude filled in so the document is complete are marked **[PROPOSED]**. Unresolved questions are marked **[OPEN]**.

### 0.1 Tag meanings

| Tag | Meaning | What the AI must do |
|---|---|---|
| **[DECIDED]** | The owner discussed and chose this. | Follow it exactly. Do not change it without the owner's explicit instruction. |
| **[PROPOSED]** | Added by Claude to fill a gap. The owner has not confirmed it. | Use it as the default, but tell the owner it is an unconfirmed default the first time it affects code. Do not treat it as an owner decision. |
| **[OPEN]** | Not decided. | **Stop and ask the owner** before implementing anything that depends on it. Do not guess. |

Untagged explanatory text (background, definitions, examples) is informational, not a requirement.

### 0.2 Behaviour rules

1. **Do not add features, libraries, files, or architecture** that are not in this document. If something seems necessary, propose it to the owner and wait.
2. **Do not substitute the stack** in Section 13. TypeScript, React, Vite, Vitest, fast-check, IndexedDB, Node.js are decided.
3. **Do not make claims the project cannot back up.** Section 3.4 lists allowed and forbidden claims. Never describe the project as a new algorithm, production-ready, or a replacement for Yjs, Automerge or Loro.
4. **Tests come with the code.** No kernel feature is "done" without unit tests and, where Section 15 lists one, a property-based test.
5. **Keep the kernel pure and deterministic** (Section 7.1). No `Date.now()`, `Math.random()`, DOM, network, or storage inside `/kernel`.
6. **Never add `/.kiro` or any sub-folder to `.gitignore`.** The hackathon rules say this can disqualify the submission.
7. **Never mark a Must item as cut or done silently.** If a checkpoint (Section 19) is missed or a Must item is at risk, stop and report to the owner with a re-scope proposal.
8. **Be honest in all documentation** (README, write-up, UI text). State limitations plainly (Section 20).
9. **Do not invent Kiro features.** Check the official Kiro documentation for exact feature names and behaviour before writing Kiro configuration (Section 17).
10. **Update the Decision Log and Status Tracker (Section 22)** whenever a decision is made or a milestone changes.
11. If the owner's latest instruction conflicts with this document, the owner's latest instruction wins. Then update this document.
12. Do not use copyrighted assets (images, fonts with restrictive licences, music) in the app or demo video.

---

## 1. Project at a glance

| Item | Value |
|---|---|
| One-line description | A small, from-scratch, fault-aware CRDT kernel for offline-first collaborative apps that safely reclaims deleted-data metadata (tombstones) using causal stability and explicit membership epochs, demonstrated through two apps. **[DECIDED]** |
| Hackathon | Kiroween 2026 on Devpost (https://kiroween.devpost.com/), hosted by the Kiro team **[DECIDED]** |
| Category | **Skeleton Crew** (a lean, flexible code foundation plus two distinct applications built from it) **[DECIDED]** |
| Participation | Solo **[DECIDED]** |
| Owner's goals | (1) Learn and gain first hackathon experience, (2) build a competitive project aimed at prizes, (3) build something impressive for a placement portfolio **[DECIDED]** |
| Application 1 | **Graveyard Whiteboard** — collaborative drawing canvas **[DECIDED]** |
| Application 2 | **Cursed Checklist** — shared to-do list **[DECIDED]** |
| Core language | TypeScript **[DECIDED]** |
| Build tool used for development | AWS **Kiro** (specs, steering, hooks, property-based testing) **[DECIDED]** |
| Final deadline (official) | Dec 4, 2026, 2:00 PM Pacific Time (= Dec 5, 03:30 AM IST) |
| Personal submission target | **Dec 3, 2026** **[PROPOSED]** (one day of safety margin) |
| Nature of the project | Educational, carefully scoped kernel. **Not** a production replacement for Yjs/Automerge/Loro. **[DECIDED]** |

---

## 2. Hackathon context and rules (verified from the Devpost page on 2026-11-08)

The owner must re-verify against the Official Rules tab before submitting. Devpost rules override this document.

### 2.1 Submission requirements

| Requirement | Detail |
|---|---|
| Eligible work | Only **new** projects started during the Submission Period (Oct 30 – Dec 4, 2026). Nothing started before Oct 30. |
| Public repository | Public **GitHub** repo (not GitLab/Bitbucket). Must contain all source, assets and instructions. |
| Licence | Open-source licence file, detectable and visible in the repo's About section. **[PROPOSED]** MIT. **[OPEN]** owner has not confirmed the licence. |
| `/.kiro` directory | Must exist at the repo root, showing specs, hooks and steering. **Must never be gitignored.** |
| Skeleton Crew rule | The repo must contain **2 separate repo folders for the 2 separate applications**. Re-check the Rules tab for exact structure. |
| Working app URL(s) | Public URL(s) for the working app(s). Credentials, if any, go in the Devpost form (judges only). |
| Text description | Features and functionality. |
| Demo video | **Under 3 minutes**, public on YouTube, shows the project working on the device it was built for. No third-party trademarks or copyrighted music. |
| Kiro write-up | How Kiro was used. Judges expect depth: IDE/CLI/Web/Crew differences, custom agents, hooks, spec-driven development vs vibe coding, steering strategy, MCP, property-based testing, Kiro powers. |
| Free Kiro credits | Request 4,000 credits on the Resources tab **by Dec 1, 12:00 PM PT** (= Dec 2, 01:30 AM IST). |
| Team size | Up to 3. The owner is solo. |
| Build session | Devpost Build Session Nov 11, 10:00 AM PT (= Nov 11, 11:30 PM IST). |

### 2.2 Judging criteria (five, weights not stated on the page)

1. **Potential Impact** — credible case for a real problem and audience; useful, intuitive, accessible.
2. **Technological Implementation** — how thoroughly and skillfully Kiro is used; variety of Kiro tools; strategy; experimentation.
3. **Design** — a complete, coherent, polished product experience, not just a proof of concept.
4. **Innovation/Idea** — creativity and novelty; difference from existing concepts.
5. **Presentation** — the video clearly shows the project working end-to-end; the pitch is easy to follow and memorable.

**Consequence for this project [DECIDED by analysis]:** the kernel alone will not score well on Impact, Design and Presentation. The two apps, the Graveyard panel and the demo video must be polished.

### 2.3 Prizes this project targets

| Prize | Condition |
|---|---|
| Best Skeleton Crew (category prize, $5,000) | Skeleton Crew category. |
| Best Student Project: Skeleton Crew ($1,500 + 1-year Kiro Pro Max) | All team members are students. Submission needs LinkedIn profile, student email, year and degree, school name. Proof of enrolment may be requested. |
| Bonus Blog Prize | Publish a public blog post about Kiro and the project on a third-party platform during the Submission Period; state it is written for Kiroween 2026; add URL to submission. |
| Social Blitz Prize | Post on a social platform during the Submission Period starting with `#KiroweenHackathon26`; share favourite thing about Kiro and how it changed development; add URL. |
| Best Demo | No extra steps; all eligible submissions considered. |

An eligible project can win one Overall **or** one Category prize (not both) and any number of Bonus prizes.

---

## 3. Problem, thesis and honest claims

### 3.1 Problem

A CRDT (conflict-free replicated data type) lets several devices edit shared data independently and converge to the same state after exchanging updates, without a central server deciding. Deletion is the hard part. When an element is deleted, other devices may have concurrent edits that refer to it. If it is physically removed too early, those edits can no longer be placed correctly. The standard solution is a **tombstone**: the element is marked deleted but kept. Tombstones accumulate forever in long-lived documents.

Worked example (from the planning discussion):

```
Initial:  C A T
Alice:    deletes "A"             -> C T
Bob:      inserts "X" after "A"   -> C A X T
Merged:   C X T
```

Bob's insert refers to "A" as its anchor. If Alice's device had removed "A" entirely, Bob's insert could not be placed. The tombstone preserves the anchor.

### 3.2 Thesis **[DECIDED]**

Build a small CRDT kernel from scratch that:

1. converges under reordering, duplication, delay and partitions;
2. tracks causal progress with version vectors;
3. computes a **stable frontier** (what all active replicas have acknowledged);
4. **safely reclaims** deleted-data metadata once it is causally stable;
5. handles an offline replica that blocks reclamation through explicit **membership epochs**, **eviction** and **stale-peer fencing**;
6. makes all of this visible in a "graveyard" UI and verifies it with property-based tests.

### 3.3 What is and is not novel **[DECIDED]**

Tombstones, version vectors, causal stability and CRDT compaction are **established ideas** (Yjs, Automerge and Loro each handle related problems). The contribution is a **small, readable, from-scratch implementation** that makes membership, stale-peer fencing, safe reclamation and correctness testing **visible and explainable**.

### 3.4 Allowed and forbidden claims **[DECIDED]**

| Allowed | Forbidden |
|---|---|
| "A small, educational CRDT kernel." | "A new CRDT algorithm." |
| "Tested with property-based tests (fast-check)." | "Production-ready." / "Replaces Yjs, Automerge or Loro." |
| "Makes tombstone reclamation, membership and fencing visible." | "Provably correct" (unless a proof actually exists). |
| "Uses a small coordinator for membership and compaction authorization; edits are peer-to-peer." | "Fully decentralized" / "authority-free membership." |
| "Evicted peers must rejoin from a snapshot." | "Offline peers can always merge any amount of old edits." |

### 3.5 Prior art to acknowledge in the README **[PROPOSED]**

crdt.tech, the RGA paper (Roh et al.), Kleppmann and Beresford's JSON CRDT paper, Shapiro et al.'s CRDT paper, Yjs, Automerge, Loro. Verify each citation before quoting. See Appendix B.

---

## 4. Glossary

| Term | Meaning in this project |
|---|---|
| **Replica** | One independent copy of the document, e.g. one browser tab. |
| **Replica ID** | Unique identifier of one replica *incarnation*. **[PROPOSED]** format `${siteId}.${incarnation}`. |
| **Incarnation** | A replica that is evicted and later returns is a **new incarnation** with a new Replica ID. **[DECIDED]** |
| **Operation (op)** | An insert or delete, created at one replica and sent to the others. |
| **Op ID** | `(replica, seq)`; `seq` counts that replica's ops 1, 2, 3, … with no gaps. |
| **RGA** | Replicated Growable Array, the sequence CRDT used. **[DECIDED]** |
| **Anchor** | The existing element an insert is placed after (or `HEAD`). |
| **Tombstone** | A deleted element that is retained (invisible to the user) so concurrent operations can still be placed. |
| **Version vector (VV)** | Map from replica to the highest **contiguous** op `seq` applied from it. **[DECIDED]** contiguous prefix, not "largest seen". |
| **Ack** | A replica reporting its VV to the coordinator. |
| **Stable frontier** | Component-wise **minimum** of the acknowledged VVs of all **active** members in the current membership view. Ops at or below it have been applied by every active member. |
| **Causal stability** | An op is causally stable when it is at or below the stable frontier. |
| **Stage 1 GC** | Reclaim the **payload** of a deleted element; keep a lightweight structural anchor. |
| **Stage 2 GC** | Remove the structural anchor itself, only when provably safe. **Stretch goal.** |
| **Retained anchor** | A deleted element whose payload was reclaimed in Stage 1 but whose structural node remains. |
| **Membership view** | The set of active replicas, with an **epoch** number. |
| **Epoch** | Integer incremented on every membership change. |
| **Zombie peer** | A replica still registered as a member but no longer communicating; it stalls the stable frontier. |
| **Eviction ("exorcism")** | An authorized membership change removing a zombie and incrementing the epoch. |
| **Fencing** | Rejecting messages/ops from evicted or stale-epoch peers. |
| **Snapshot** | Full current state plus VV, used to bootstrap a new or returning replica. |
| **Coordinator** | A small trusted Node.js service managing membership, epochs and GC authorization. **[DECIDED]** |
| **Graveyard panel** | UI panel visualizing tombstones, anchors, frontier, epoch and reclaimed memory. **[DECIDED]** |

---

## 5. Scope

### 5.1 Scope tiers

| Tier | Items |
|---|---|
| **MUST** | RGA sequence (insert, delete, traversal) · logical clocks and unique element IDs · per-replica op log · contiguous version vectors · missing-op exchange · dependency buffering · duplicate suppression · deterministic simulated network · property-based tests · membership epochs · zombie eviction · stale-peer fencing · stable-frontier computation · Stage 1 GC (payload reclamation) · snapshots and snapshot rejoin · Graveyard Whiteboard · Cursed Checklist · Graveyard panel **[DECIDED]** |
| **SHOULD** | BroadcastChannel transport for multi-tab demo · IndexedDB persistence · exportable orphaned edits for an evicted peer · polished spooky UI · CI running tests **[DECIDED]** for the first three; **[PROPOSED]** for CI |
| **STRETCH** | Stage 2 structural GC (only if safety is proven by tests) · simple LWW map · WebRTC transport **[DECIDED]** |
| **NEVER CUT** | Membership fencing · GC safety · property-based tests **[DECIDED]** |

### 5.2 Cut order if behind **[DECIDED]**

1. WebRTC  →  2. LWW map functionality  →  3. elaborate visual design.

**[PROPOSED]** Add Stage 2 GC as the first thing cut after WebRTC, because it is already a stretch goal. Never cut anything in the NEVER CUT row.

### 5.3 Explicitly out of scope **[PROPOSED]**

Rich text formatting · undo/redo · live cursor/presence · user accounts and authentication · multi-document support · server-side storage of document content · mobile-optimized UI · internationalization · LLM/AI features · production hardening and performance tuning for large documents · automatic eviction by timeout (manual eviction only, see Section 8.6).

