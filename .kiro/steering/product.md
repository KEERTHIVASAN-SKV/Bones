# CRDT Kernel — Product Context

## What is Bones?

**Bones** is a specification-driven implementation of a Conflict-Free Replicated Data Type (CRDT) kernel for collaborative applications. It is built for the Kiroween Hackathon (BONES track) and demonstrates how to use the Kiro IDE for spec-driven development.

## Who It's For

- **Hackers learning CRDT fundamentals** — the kernel is an educational reference implementation
- **Collaborative app builders** — the two demo apps (Graveyard Whiteboard, Cursed Checklist) show integration patterns
- **CRDT researchers** — property-based testing with 18 correctness properties verifies the design

## The Spooky Framing: Graveyard & Exorcism

The project embraces a *graveyard metaphor* for data deletion and membership management:

- **Tombstones** → deleted elements remain as "ghosts" in the structure, supporting undo and structural integrity
- **Graveyard Panel** → visualizes the ghost population (tombstones, reclaimed payloads, evicted replicas)
- **Exorcise Action** → operator manually evicts a stalled replica, freeing it from the "graveyard"
- **Stable Frontier** → operations that have "crossed over" and are safe to reclaim

This framing makes the underlying systems more intuitive and memorable, turning a technical data structure challenge into a narrative about managing digital hauntings.

## Core Principles

1. **Specification-Driven** — all code flows from formal requirements + algorithms in `.kiro/specs/crdt-kernel/`
2. **Deterministic** — no wall-clock time; same seed = identical results; reproducible in CI
3. **No Data Loss** — operations buffered indefinitely; never silently dropped
4. **Causally Consistent** — Version Vectors enforce causal ordering across all replicas
5. **Kernel Purity** — `/kernel` is pure TypeScript; no DOM, network, storage, randomness

## Key Delivery Artifacts

1. **CRDT Kernel** (pure TS library in `/kernel/src/`) — RGA + VV + GC + Snapshots
2. **Graveyard Whiteboard** — collaborative drawing app showcasing the graveyard visualization
3. **Cursed Checklist** — collaborative to-do app with membership status display
4. **Coordinator Service** — Node.js service for frontier computation and membership coordination
5. **Spec & Design Docs** — 4 spec files in `.kiro/specs/crdt-kernel/` + 80 implementation tasks

## Success Criteria

- ✅ All 80 tasks completed before Dec 3, 2026
- ✅ 18 property-based tests pass (correctness verification)
- ✅ 2 apps demo sync across tabs/replicas with Graveyard panel
- ✅ Spec-driven workflow documented via Kiro hooks & steering files
- ✅ Honest claims (§3.4 of project spec) met; no overreach
