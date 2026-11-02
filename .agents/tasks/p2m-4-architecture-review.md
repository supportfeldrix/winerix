# P2M-4 — Architecture Review (Review Only)

**Status:** Architecture review only. No code, migrations, UI, or data were changed. Nothing in this document is implemented. P2M-2 and P2M-3 remain untouched.

**Scope:** Decide what P2M-4 should be, after P2M-2 (dispatch processing) and P2M-3 (read-only dispatch management/UI), grounded in the actual Winerix schema (migrations 040, 048, 050, 051, 052) and the approved P2L/P2M/P2N boundaries.

---

## 1. Recommended P2M-4 capability

**P2M-4 = Dispatch Correction / Reversal (compensating-movement model), plus the minimal dispatch lifecycle it requires.**

Concretely, P2M-4 should introduce a single, atomic, SECURITY DEFINER reversal operation — provisionally `reverse_dispatch(p_dispatch_id uuid, p_reason text)` — that:

- marks an existing `recorded` dispatch as `voided` (using the status value **already reserved** in `051_dispatch_core.sql`'s `dispatch_status_check`),
- writes **new compensating `stock_movements`** that add the bottles back (positive deltas), rather than deleting or editing the original negative `dispatch` movements,
- **decrements** `stock_allocations.fulfilled_qty` back down (reversing the fulfilment), restoring the allocation to `partially_fulfilled` or `open`,
- recomputes the sales order dispatch status back down the lifecycle (`completed` → `partially_dispatched` → `ready_to_dispatch`),
- preserves the full original dispatch header + lines as immutable history.

This is the smallest capability that is **genuinely required** rather than invented: as soon as real dispatches exist (they now do — DISP-2026-0001/0002), the business will hit a mis-dispatch (wrong quantity, wrong order, picked but not shipped, damaged in the bay). Today there is **no path** to undo one without violating the inventory-ledger rules, because `record_dispatch` only ever moves stock *out*.

### What P2M-4 is NOT
It is not delivery confirmation, proof of delivery, documentation, or customer delivery status (review question items 2–5). Those are evaluated and rejected (for now) in §2.

---

## 2. Why this is the correct next phase (evaluation of the options)

Each candidate from the review questions, judged against the existing architecture:

| # | Candidate | Verdict | Reasoning |
|---|-----------|---------|-----------|
| 1 | **Dispatch correction / void / reversal** | **SELECT — P2M-4** | The only candidate that is (a) a *physical dispatch* capability P2M genuinely owns, (b) already anticipated by the schema (`'voided'` exists in `dispatch_status_check` but no code path sets it — a direct hand-off marker, exactly like the `fulfilled`/`partially_dispatched` markers P2L left for P2M-2), and (c) currently *impossible* to do correctly. Without it, the only "fix" a user has is a manual stock adjustment (migration 043), which breaks traceability (the correction would not be linked to the dispatch) and corrupts allocation fulfilment accounting. High necessity, squarely in P2M's lane. |
| 2 | Delivery confirmation | Defer (likely P2M-5 or P2N-adjacent) | "Delivered" is a logistics/fulfilment-outcome state, not a *physical stock* event — stock already left the building at dispatch. It adds a lifecycle state but changes no inventory. Useful, but lower necessity than being able to fix a wrong dispatch, and arguably couples to P2N (export proof) and Finance (revenue recognition on delivery vs dispatch). Build after correction exists. |
| 3 | Dispatch documentation (delivery note / packing slip PDF) | Defer | Pure presentation over P2M-3 data; no new truth, no stock impact. Valuable but not architecturally urgent, and partly overlaps future P2N export documentation. A P2M-3.x/P2M-5 UI concern. |
| 4 | Proof of delivery | Defer | A sub-capability of (2); meaningless until delivery confirmation exists. |
| 5 | Customer delivery status | Defer | Depends on (2). Reporting/visibility layer, read-only — a P2M-3 extension, not a new backend phase. |
| 6 | Dispatch lifecycle extension | **Partially SELECTED, as a consequence of (1)** | Reversal *forces* a minimal lifecycle extension: `recorded → voided` on the dispatch, and the downward sales-order recompute. We should implement exactly that much lifecycle and no more. A broader lifecycle (picking → packed → shipped → delivered) is deferred with (2). |
| 7 | Dispatch notes/events/history | **Partially SELECTED, as a thin dependency of (1)** | A reversal needs an auditable reason and a durable link from the void back to the original dispatch. The existing `audit_log` already captures the *what/when/who* of the status change and the compensating movements. A dedicated `dispatch_events` table is **not** required for P2M-4 (the audit log + the reversal's own movement rows + the `reason` suffice). Revisit a first-class events table only if/when full lifecycle (2) lands. |
| 8 | Other | — | No other physical-dispatch capability is both necessary and unbuilt. |

**Conclusion:** reversal/correction (1) is the next required capability; (6) and (7) are only pulled in to the minimum degree reversal demands.

---

## 3. What problem it solves

- **Operational:** a user dispatches 60 bottles against the wrong order, or ships the wrong quantity/location, or the order is cancelled after picking. Today that cannot be undone without an out-of-band stock adjustment that is **not** linked to the dispatch and **does not** reverse allocation fulfilment — leaving `stock_allocations.fulfilled_qty` and the sales order status permanently wrong.
- **Inventory integrity:** restores physical stock through the *same* ledger (`stock_movements`), using compensating entries, so `stock_items.qty_bottles` is corrected without a parallel truth and without rewriting history.
- **Commercial integrity:** walks the sales order back from `completed`/`partially_dispatched` to the correct state so it can be re-dispatched or cancelled cleanly.
- **Auditability:** the void is a first-class, attributable, reason-bearing event, not a silent edit.

---

## 4. Proposed data model changes (if any)

**Preference: no new tables. Reuse what P2M-2 built.** The reversal is expressible entirely with existing structures:

- The dispatch header's `status` moves `recorded → voided` (value already in the CHECK — **no constraint change needed**).
- Compensating rows are inserted into the existing `stock_movements` ledger.
- Allocation fulfilment is walked back on the existing `stock_allocations` columns (`fulfilled_qty`, `status`, `fulfilled_at`).
- The existing `audit_log` + `audit_log_row_change()` wiring already audits `dispatches`, `dispatch_lines`, `stock_movements`, and `stock_allocations`.

**Two small, optional additive columns on `dispatches`** are the only data-model change worth considering, and only if the team wants void metadata queryable without parsing the audit log:

| Column | Type | Purpose |
|--------|------|---------|
| `voided_at` | `TIMESTAMPTZ NULL` | When the dispatch was reversed (mirrors the `fulfilled_at` idiom on allocations). |
| `void_reason` | `TEXT NULL` | Why (append-only; set once by the reversal RPC). |

These are **additive, nullable, and backward-compatible** — existing rows stay valid, and they do not duplicate lineage. If the team prefers zero schema change, both can be derived from `audit_log` instead; recommendation is to add them for query ergonomics and to keep the `recorded`/`voided` + timestamp idiom consistent with the rest of the schema. **No change to `dispatch_lines`** (its rows remain immutable historical facts).

### Compensating-movement model (the critical accounting rule)
- Original dispatch line → `stock_movements` row: `movement_type='dispatch'`, `qty_bottles_delta = -60`, `reference_type='dispatch_line'`, `reference_id = <line id>`. **This row is never touched.**
- Reversal → **new** `stock_movements` row(s): a positive delta that returns the bottles, linked back to the same dispatch/line. Two viable options for `movement_type`:
  - **Option A (recommended): reuse `'receipt'`** — it already means "bottles added at a location" and is in the vocabulary, with `reference_type='dispatch_reversal'` (new reference_type string, which needs **no** CHECK change — `reference_type` is free TEXT) and `reference_id = <original dispatch_line id>` to preserve the link. Minimises surface area.
  - **Option B: add a new `movement_type='dispatch_reversal'`** — most *explicit* and self-documenting in the ledger, but requires a CHECK-constraint change on `stock_movements` (the kind of surgery P2M-2 did carefully). Cleaner semantics at the cost of a constraint migration.
  - **Recommendation:** decide at implementation time; lean to **Option B** if downstream reporting/Finance will distinguish reversals from genuine receipts (it likely will — a reversal is not new production stock), otherwise Option A. Flagged as a locked decision to make before P2M-5. Either way, the delta is **positive**, one movement per line/location, never aggregated.

---

## 5. Proposed tables / columns / indexes

- **New tables:** none required.
- **Columns:** optional `dispatches.voided_at`, `dispatches.void_reason` (see §4).
- **Indexes:** none new strictly required. `idx_stock_movements_reference_id` (already exists, 040) covers reversal-movement lookups by original line. If `voided_at` is added and voided dispatches are queried frequently, a partial index `… ON dispatches(org_id) WHERE status='voided'` is a nice-to-have, not a requirement.
- **CHECK changes:** none, unless Option B (new `movement_type`) is chosen — then one careful `stock_movements_type_check` replacement preserving all existing values.

---

## 6. Proposed RPCs / functions

One new atomic operation, mirroring `record_dispatch`'s house style exactly:

**`reverse_dispatch(p_dispatch_id uuid, p_reason text)` → table/row result.**

Ordered steps (all one transaction; any failure RAISEs and rolls everything back):

1. `auth.uid()` not null (fail closed).
2. Lock the `dispatches` row `FOR UPDATE`; derive `org_id` from it (never trust client).
3. `assert_dispatch_actor(org_id)` — same guard as record_dispatch (role check in §8).
4. Validate dispatch `status = 'recorded'` (reject already-`voided` → idempotency/duplicate guard).
5. Validate the parent sales order is in a reversible state (`partially_dispatched` or `completed`); lock the sales order `FOR UPDATE`.
6. Load the dispatch's lines in deterministic order (`ORDER BY id`), locking each referenced `stock_allocation` `FOR UPDATE`, then the matching `stock_items` row `FOR UPDATE` — **same lock order as record_dispatch: sales_orders → stock_allocations → stock_items** (prevents deadlocks and over/under-counting).
7. Per line: **increment** `stock_items.qty_bottles` by the line qty (restore physical stock); insert the compensating `stock_movements` row (positive delta, linked to the original line).
8. Per line: **decrement** `stock_allocations.fulfilled_qty` by the line qty; set status back to `partially_fulfilled` (if still >0) or `open` (if now 0), clearing `fulfilled_at` when returning below full. Guard: fulfilled_qty must not go negative (it can't if the dispatch line math is consistent, but assert it).
9. Set dispatch `status='voided'` (+ `voided_at`, `void_reason` if columns added).
10. Recompute the sales order status via the existing `recompute_sales_order_dispatch_status()` (which already walks `completed`/`partially_dispatched`/`ready_to_dispatch` from fulfilled quantities — **no new recompute function needed**).
11. Let the existing audit triggers record everything; do **not** hand-insert audit rows.
12. Return the voided dispatch + per-line reversal result.

**Design decision — one RPC, not two:** consistent with P2M-2's single-atomic-call precedent. No "draft reversal" concept; a reversal is a complete, immediate event.

**Explicitly NOT built in P2M-4:** partial reversal (reversing *some* bottles of a dispatch line). A dispatch is reversed in full. Partial correction is achieved by voiding the whole dispatch and re-dispatching the correct quantity — simpler, safer, and avoids a second fulfilment-math surface. Flagged as deferred (§12).

---

## 7. RLS / security model

Unchanged from P2M-2 and not weakened:

- `dispatches` / `dispatch_lines` keep **SELECT-only** RLS (`is_org_member(org_id)`); **no** client INSERT/UPDATE/DELETE policies. The status flip to `voided` happens **only** inside the SECURITY DEFINER RPC, never via a client UPDATE.
- `reverse_dispatch`: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO authenticated`.
- Org derived from the locked dispatch row; cross-org integrity triggers (`validate_dispatch_org_integrity`, `validate_dispatch_line_org_integrity`) continue to apply to any row the RPC touches.
- The compensating `stock_movements` inserts flow through the same ledger with the same org/owner derivation.

---

## 8. Role permissions

Reversal is a physical-stock-mutating, correction-grade operation — treat it at least as strictly as dispatch, arguably stricter:

- **Recommendation:** `assert_dispatch_actor` roles (OWNER/ADMIN/CELLAR/SALES) *may* be acceptable, but because a reversal unwinds completed physical + commercial state, prefer restricting it to **OWNER/ADMIN/CELLAR** (drop SALES), aligning with the stricter `assert_stock_admin_actor` posture used for adjustments/damage (043). Final call to confirm at implementation.
- FARM / VIEWER: no access (read-only, as today).
- P2M-3 UI remains read-only for everyone; a "Reverse dispatch" action would be gated to the permitted roles and call the RPC.

---

## 9. Transaction / concurrency behaviour

- Fully atomic single transaction; ROLLBACK on any failure (no partial reversal).
- Lock order identical to record_dispatch (`sales_orders → stock_allocations → stock_items`), deterministic line ordering — no deadlocks, no double-processing.
- **Duplicate/idempotency guard:** the `status='recorded'` precondition means a second concurrent reverse of the same dispatch finds it already `voided` (committed under the lock) and fails safely — stock is never added back twice.
- **No negative stock** on reversal (reversal only *adds* stock); the allocation decrement is asserted non-negative.
- Physical stock stays authoritative in `stock_items`; history stays append-only in `stock_movements` (compensating entries, never deletes/edits).

---

## 10. Audit requirements

- Reuse the single `audit_log_row_change()` writer — it already audits `dispatches` (INSERT+UPDATE), `stock_movements` (INSERT), and `stock_allocations` (INSERT+UPDATE). The void status change, the compensating movements, and the fulfilment decrements are therefore **already auditable** with no new audit system.
- No second audit system. No manual audit inserts in the RPC.
- `void_reason` (if added) + the audit trail give the full who/when/why.

---

## 11. Relationship to existing entities

| Entity | Relationship under P2M-4 |
|--------|--------------------------|
| **Sales Orders** | Status walked back down (`completed`/`partially_dispatched` → `partially_dispatched`/`ready_to_dispatch`) via the existing recompute function. P2L still owns `draft…cancelled`; P2M owns the dispatch-derived states and now their reversal. No duplicate/conflicting states introduced. |
| **Stock Allocations** | `fulfilled_qty` decremented; status returns to `partially_fulfilled`/`open`; `fulfilled_at` cleared when dropping below full. Original reservation `qty_bottles` never touched; rows never deleted. P2L-6 release path untouched. |
| **Dispatches** | Header preserved as immutable history; only `status` (→ `voided`) and optional `voided_at`/`void_reason` change. |
| **Dispatch Lines** | Fully immutable. Not edited, not deleted. The CASCADE from dispatch is irrelevant (we never delete the dispatch). |
| **Stock Items** | `qty_bottles` incremented back by the reversal, through the RPC only — never a direct client write. |
| **Stock Movements** | New compensating positive-delta rows, linked to the original dispatch line via `reference_id`. Original negative rows preserved. One ledger, no aggregation. |
| **Finance** | **Not implemented.** But P2M-4 clarifies a dependency: if Finance recognises revenue at dispatch/completion (per the P2M-1 recommendation), a reversal is the event that must later trigger a compensating Finance entry (credit note/reversal), traceable to Customer → Sales Order → Dispatch. Documented as a boundary, not built (§12). |
| **Future P2N compliance** | A voided dispatch must be visible to export/excise reporting so reversed shipments are not counted as exported. P2M-4 preserves the traceability chain intact, so P2N can filter on dispatch status. No P2N work in this phase. |

Traceability chain **Customer → Sales Order → Sales Order Line → Stock Allocation → Dispatch → Dispatch Line → Stock Movement** is fully preserved; the reversal adds compensating movements *within* the same chain rather than creating a parallel one.

---

## 12. What remains explicitly deferred

- **Partial-quantity reversal** of a single dispatch line (full-dispatch void only in P2M-4).
- **Delivery confirmation / proof of delivery / customer delivery status** (candidates 2, 4, 5) — a later phase, likely coupled to P2N and Finance.
- **Dispatch documentation / delivery notes / packing slips** (candidate 3).
- **A first-class `dispatch_events` lifecycle table** (candidate 7 beyond the reason/audit minimum).
- **Finance integration** (credit note / revenue reversal on void) — boundary documented, not built.
- **P2N export/excise/compliance** — out of scope entirely.
- **Any redesign** of stock_items / stock_movements / allocations / sales_orders / Finance.

---

## 13. Proposed implementation sequence for P2M-4

1. **Decide the two locked questions first** (see §15 verdict notes): (a) `movement_type` for reversals — reuse `'receipt'` vs new `'dispatch_reversal'`; (b) role set — OWNER/ADMIN/CELLAR vs include SALES.
2. **Migration 053** (single, transactional, house-style): optional additive `dispatches.voided_at`/`void_reason`; (if Option B) the `stock_movements_type_check` replacement preserving all values; `reverse_dispatch` RPC (SECURITY DEFINER, pinned search_path, REVOKE PUBLIC / GRANT authenticated); `assert_*` guard reuse; post-validation `DO $$` block; **no** change to record_dispatch, 051, or 052.
3. **Consolidated verification query** (one row per check, PASS/FAIL) in the same style as P2M-2.
4. **Manual DB test** against real data (reverse DISP-2026-0002, confirm stock/allocation/order walk back; §15).
5. **P2M-4 UI** (small, after backend proven): a gated "Reverse dispatch" action on the Dispatch Profile (P2M-3), a confirm dialog with mandatory reason, and a `voided` status badge + voided-reason display. Read-only everywhere else. (Could be a separate P2M-4.2 commit.)
6. Build, browser-test, report. No commit/push without explicit instruction.

---

## 14. Risks and edge cases

- **Re-dispatch after void:** once voided, the allocation is back to `open`/`partially_fulfilled` and the order to `ready_to_dispatch`/`partially_dispatched`, so `record_dispatch` can run again normally. Verify the dispatch *number* is not reused (it isn't — a new `DISP-YYYY-NNNN` is minted; the voided one keeps its number as history).
- **Allocation already released/cancelled:** if a reversal would restore fulfilment to an allocation that is somehow `released`/`cancelled`, the RPC must reject (can't un-fulfil into a terminal non-open state). Edge case to assert.
- **Stock moved since dispatch:** reversal only *adds* stock, so it can't cause negative stock; but the restored bottles land at the original location — if that location was deactivated, decide whether to allow (recommend: allow, since it's historical correction) and document.
- **Order already cancelled:** a `completed` order shouldn't be `cancelled` (P2L blocks that), but if business rules later allow cancel-after-complete, reversal ordering vs cancellation must be defined. For P2M-4: only reverse orders in `partially_dispatched`/`completed`; cancellation remains P2L and still requires zero open allocations.
- **Finance drift (future):** if Finance posts on completion before P2M-4 ships, a void with no compensating Finance entry would leave revenue overstated. Document the dependency now so Finance (whenever built) handles void.
- **Double-click / retry:** handled by the `status='recorded'` precondition under row lock.
- **Movement_type choice regret:** if `'receipt'` is reused and Finance/P2N later need to distinguish reversals, a backfill is painful — this is the argument for Option B up front.

---

## 15. Recommended browser / database test scenarios

Using existing real data (SO-2026-0002, fully `completed`, DISP-2026-0001 = 60, DISP-2026-0002 = 40, physical stock currently 4,875 at FG-STORE-01):

1. **Reverse the final dispatch (DISP-2026-0002, 40):** physical stock 4,875 → 4,915; allocation `fulfilled_qty` 100 → 60, status `fulfilled` → `partially_fulfilled`, `fulfilled_at` cleared; order `completed` → `partially_dispatched`; dispatch status `recorded` → `voided` with reason; one compensating positive movement (+40) linked to the original line; original −40 movement untouched.
2. **Reverse the first dispatch (DISP-2026-0001, 60) too:** stock 4,915 → 4,975; allocation 60 → 0, status → `open`, `fulfilled_at` null; order `partially_dispatched` → `ready_to_dispatch`; back to the pre-dispatch baseline, with full history of 2 dispatches + 2 reversals preserved.
3. **Re-dispatch after void:** `record_dispatch` 100 again succeeds, mints a new DISP number, order → `completed`.
4. **Idempotency:** reverse an already-`voided` dispatch → rejected, no stock change, no new movement.
5. **Concurrency:** two simultaneous reversals of the same dispatch → one succeeds, the other fails on the `recorded` precondition under lock; stock added back exactly once.
6. **Authz:** VIEWER/FARM denied; a SALES user denied (if the stricter role set is adopted); OWNER/ADMIN/CELLAR permitted.
7. **No negative/duplicate:** confirm no negative stock, no duplicate compensating movement, no duplicate fulfilment decrement.
8. **Audit:** `audit_log` shows the dispatch UPDATE (→voided), the compensating `stock_movements` INSERTs, and the `stock_allocations` UPDATEs.
9. **UI (P2M-3 extension):** voided dispatch shows a `Voided` badge + reason; traceability still renders; reversal action hidden for read-only roles.

---

## 16. Confirmation: P2M-2 and P2M-3 remain unchanged

This review changed **no** files, migrations, or data. `record_dispatch`, `dispatches`, `dispatch_lines`, `stock_allocations`, `stock_items`, `stock_movements`, `sales_orders`, Finance, migrations 051 and 052, and the entire P2M-3 UI/service are **unchanged**. All recommendations above are for a *future* migration 053 and a *future* UI increment, not implemented here.

---

## P2M-4 ARCHITECTURE VERDICT: **PASS WITH NOTES**

**Pass:** Dispatch Correction / Reversal is the correct, genuinely-required next capability. It fits P2M's ownership, reuses the proven P2M-2 security/concurrency/audit model, honours the compensating-movement rule (preserve history, never delete/mutate), preserves the full traceability chain, and introduces no new truth or parallel ledger.

**Notes to resolve before implementation (P2M-4 migration 053):**
1. **Movement type for reversals** — reuse `'receipt'` (no CHECK change) vs add explicit `'dispatch_reversal'` (one careful CHECK migration). Recommend `'dispatch_reversal'` if Finance/P2N will distinguish reversals from genuine receipts.
2. **Role set** — confirm OWNER/ADMIN/CELLAR (recommended, stricter) vs including SALES.
3. **Void metadata columns** — add `voided_at`/`void_reason` to `dispatches` (recommended for ergonomics) vs derive from `audit_log`.
4. **Partial reversal is deferred** — full-dispatch void only; correct quantity errors by void + re-dispatch.
5. **Finance dependency documented, not built** — a void must later trigger a compensating Finance entry; ensure whoever builds Finance handles voided dispatches.
