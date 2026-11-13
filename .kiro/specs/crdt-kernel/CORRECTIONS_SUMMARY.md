# CRDT Kernel Specs Corrections Summary - UPDATED

**Status**: ✅ **COMPLETE** — All 6 corrections applied and verified in actual document text

**Date**: December 11, 2026 (Updated with verified fixes)  
**Baseline**: Master spec BONES_PROJECT_SPEC.md (project scope, architecture, constraints)  
**Scope**: Align kernel specs with master spec *without changing architecture, scope, or correctness properties*

---

## Corrections Applied and Verified

### 1. **Eviction Policy: Manual Only (No Timeout-Based Auto-Eviction)** ✅ VERIFIED

**Correction Directive**: Remove automatic timeout-based eviction. Coordinator detects zombie peers but only manual "Exorcise" UI action triggers eviction.

**Verification**:
- ✅ requirements.md Req 1.8: Manual eviction documented
- ✅ design.md Section 4.3: Graveyard panel for detection, "Exorcise" for manual trigger
- ✅ tasks.md KER-075: "Provide manual eviction via 'Exorcise' UI action — only operator can trigger eviction"

---

### 2. **Deterministic Op ID Comparison (No localeCompare)** ✅ VERIFIED

**Correction Directive**: Replace localeCompare() with pure code-unit comparison:  < b ? -1 : a > b ? 1 : 0

**Verification**:
- ✅ tasks.md KER-009: "Use Op ID (replicaId + seq) for consistent tie-breaking with code-unit comparison:  < b ? -1 : a > b ? 1 : 0 (no localeCompare)"
- ✅ tasks.md KER-014: "Use code-unit comparison for replicaId ordering in serialization:  < b ? -1 : a > b ? 1 : 0 (no localeCompare)"
- ✅ design.md zero occurrences of localeCompare in code blocks

---

### 3. **Remove Date.now() from Kernel Code** ✅ VERIFIED

**Correction Directive**: Remove wall-clock timestamps from snapshot metadata. Use logical index derived from kernel state instead.

**Verification**:
- ✅ design.md Algorithm 7: Changed from createdAt: Date.now() to logicalIndex: rga.length with comment "Derived from kernel state; number of applied operations"
- ✅ design.md: Zero occurrences of Date.now() in entire document
- ✅ Removed comment: "Outside kernel; would be logical timestamp in pure kernel" 
- ✅ requirements.md Req 1.2: Metadata uses logicalIndex instead of createdAt
- ✅ tasks.md KER-026: "No Date.now() calls in kernel code" acceptance criterion

---

### 4. **Implementation Cut Order (WebRTC First)** ✅ VERIFIED

**Correction Directive**: Follow master spec's feature priority: WebRTC → Stage 2 GC → LWW map → Visual design. Keep BroadcastChannel as SHOULD.

**Verification**:
- ✅ tasks.md "Order if Behind" section: Updated to read "WebRTC (KER-076) → Stage 2 GC (stretch, first cut after WebRTC) → LWW map → elaborate visual design"
- ✅ Corrected: "BroadcastChannel (KER-073) is a DECIDED Should-have, not cut before WebRTC"
- ✅ Removed incorrect phrase: "BroadcastChannel stretch (not in scope)"

---

### 5. **RGA Insertion: Tombstones in Scan But Not as Insertion Points** ✅ VERIFIED

**Correction Directive**: Clarify that tombstones are included when determining insertion position, but are not used as insertion targets. Concurrent inserts ordered by Op ID.

**Verification**:
- ✅ design.md Algorithm 1: Removed condition !rga[insertAt].deleted so scan includes tombstones
- ✅ Comment updated: "Scan includes tombstones; insertion proceeds until Op ID is >= current element"
- ✅ Added: "Tombstones are structural anchors and are traversed during position calculation"
- ✅ Resolved contradiction: Code now matches comment (no deletion check in while loop)
- ✅ tasks.md KER-009: "Tombstones included in position scan but skipped as insertion targets"

---

### 6. **Requirement 1.6: Visible Element Ordering by Anchor with Deterministic Op ID Tie-Breaking** ✅ VERIFIED

**Correction Directive**: Clarify that visible elements follow RGA anchor placement order. Concurrent inserts at same anchor ordered deterministically by Op ID (replicaId first, then sequence).

**Verification**:
- ✅ requirements.md Req 1.6: "Concurrent inserts at same anchor ordered deterministically by Op ID (replicaId first, then sequence number)"
- ✅ design.md Section 2: "Op ID tie-breaking: replicaId (primary), sequence (secondary)"
- ✅ tasks.md KER-009: Tie-breaking specification with code-unit comparison

---

## Summary Table: Changes Verified in Document Text

| # | Correction | Files Updated | Verification Status |
|----|-----------|--|--|
| 1 | Manual Eviction | req (1.8), design (4.3), tasks (KER-075) | ✅ Text verified |
| 2 | Op ID Code-Unit | design (Sec 2), tasks (KER-009, KER-014) | ✅ Text verified,  < b ? -1 : a > b ? 1 : 0 found |
| 3 | Remove Date.now() | design (Algorithm 7, 0 occurrences), req (1.2), tasks (KER-026) | ✅ All Date.now() removed, logicalIndex present |
| 4 | Cut Order | tasks (Order if Behind) | ✅ Stage 2 GC and Should-have text present |
| 5 | Tombstone Scan | design (Algorithm 1 - condition removed), req (1.1, 1.3), tasks (KER-009) | ✅ !deleted condition removed from while loop |
| 6 | Req 1.6 Ordering | req (1.6), design (Sec 2), tasks (KER-009) | ✅ Op ID tie-breaking specification present |

---

## Final Consistency Checks

✅ design.md: Zero Date.now() occurrences  
✅ design.md: Zero localeCompare() occurrences in code blocks  
✅ requirements.md: Requirement numbering intact (all cross-references valid)  
✅ design.md Algorithm 1: Removed !rga[insertAt].deleted condition  
✅ design.md Algorithm 7: logicalIndex present, "Outside kernel" comment removed  
✅ tasks.md: "Order if Behind" section updated with correct cut order  
✅ tasks.md: BroadcastChannel correctly identified as Should-have  

---

## Backward Compatibility Assessment

| Change | API Impact | Data Format | Migration | Status |
|--------|-----------|-------------|-----------|--------|
| Manual eviction | ❌ Minor — new UI action | N/A | UI updates | ✅ Compatible |
| Op ID comparison | ✅ None | N/A | No action | ✅ Compatible |
| Remove Date.now() | ⚠️ Minor | Metadata changed | Legacy migration | ⚠️ Needs app update |
| Cut order | ✅ None | N/A | No action | ✅ Compatible |
| Tombstone scan | ✅ None | N/A | No action | ✅ Compatible |
| Req 1.6 Ordering | ✅ None | N/A | No action | ✅ Compatible |

---

## Sign-Off

**All corrections verified in actual document text**  
**No pending items**  
**Ready for implementation phase**

---

*Generated: December 11, 2026 — Updated with verified fixes*
