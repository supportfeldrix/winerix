# P2M-5 — Architecture Review: Dispatch Documents / Delivery Confirmation (Review Only)

**Status:** Architecture review only. No code, migrations, UI, or data were changed. Nothing here is implemented. P2M-1…P2M-4 remain untouched.

**Grounding:** This review is built on the actual Winerix schema delivered through P2M-4 — `dispatches`/`dispatch_lines` (051, SELECT-only RLS, RPC-only writes), `stock_items`/`stock_movements` (040, with movement vocabulary `receipt/transfer_in/transfer_out/adjustment/damage/sale/dispatch/dispatch_reversal`), `stock_allocations` (048 + fulfilment columns), the single `audit_log_row_change()` writer, the `assert_*_actor` role-guard pattern, the per-org `*_sequences` + `next_*_number` numbering pattern (046/051), the JSONB `*_snapshot` historical-immutability pattern (047/051), and `reverse_dispatch` (053/054).

---

## 1. Executive Summary

P2M-5 adds the **business/document layer** on top of the physical dispatch records: it records *what the customer actually received* and the *proof* of that receipt, **without** creating a second inventory truth. The core recommendation:

- **One new header table `delivery_confirmations`** (a delivery event against **exactly one** dispatch) **+ one child `delivery_confirmation_lines`** (delivered/variance quantities per dispatch line) **+ one `delivery_sequences`** counter for POD-YYYY-NNNN numbering. Mirrors the dispatches/dispatch_lines/dispatch_sequences shape exactly.
- **Delivery is a separate lifecycle from dispatch.** Dispatch status (`recorded`/`voided`) stays purely physical. Order completion stays tied to **physical dispatch fulfilment** (unchanged). Delivery confirmation is **informational/attestational** — it records receipt but **does not move stock** and **does not change `stock_items`/`stock_movements`/`stock_allocations`/`sales_orders.status`**.
- **Delivered quantities are recorded, not authoritative over inventory.** The authoritative physical truth remains `dispatch_lines.qty_bottles` (what left the building) and `stock_items`/`stock_movements` (physical balance/ledger). A short/damaged delivery records a **variance** on the delivery line; it does **not** silently alter stock. Any *actual stock return* is explicitly **deferred to a future P2M-6 Returns phase** and must flow through a compensating RPC + movement, never through delivery confirmation.
- **Proof of delivery = metadata now, Storage-reference-ready.** Store recipient/time/notes/signature-metadata as columns + an optional `pod_document_ref` (a Supabase Storage object path, nullable). No Storage upload, no PDF generation, no signed-URL plumbing built in P2M-5 — the schema is shaped so those slot in later without migration churn.
- **Finance stays out.** Documented dependency: Finance should eventually recognise on **delivery acceptance** (not dispatch), traceable Customer → Sales Order → Dispatch → Delivery Confirmation. Not implemented.

**Verdict: PASS WITH NOTES** (notes in §21/§22).

---

## 2. Recommended Delivery Model

**One `delivery_confirmations` per dispatch (0..1), one `delivery_confirmation_lines` per delivered dispatch line.**

Evaluation of the modelling options (review question 1):

| Option | Verdict | Reasoning |
|--------|---------|-----------|
| One delivery per **dispatch** | **SELECTED** | A dispatch is already "one physical shipment event against one sales order" (051). A delivery is the *receipt* of exactly that shipment. 1 dispatch → 0..1 delivery confirmation is the cleanest, most traceable mapping and reuses the dispatch's single-order invariant for free. |
| One delivery per **order** | Rejected | The order can have *multiple* dispatches (partial dispatch is a first-class P2M-2 feature). A single per-order delivery can't represent "dispatch 1 delivered, dispatch 2 still in transit." |
| One delivery covering **multiple dispatches** | Rejected (for now) | Consolidated multi-dispatch deliveries are real logistics but reintroduce the many-to-many complexity P2M deliberately avoided (same reasoning as "one dispatch never spans multiple orders"). If ever needed, model as several delivery confirmations sharing a `delivery_group_id`, not one row with multiple dispatch FKs. Deferred. |
| Multiple deliveries per **dispatch** | Rejected as the *default*; see failed-delivery note | A single dispatch delivered in two drops is rare for a wine producer. **However**, failed delivery + re-attempt needs *a second attempt record*. Resolved by: a delivery confirmation that **fails** is terminal for that attempt; a re-attempt creates a **new** `delivery_confirmations` row for the same dispatch, with at most **one** confirmation in a non-terminal/`delivered` state at a time (enforced by a partial unique index — see §12/§19). So "0..1 *active/delivered* per dispatch, N historical attempts" is the precise rule. |

**Consequences:**
- One Sales Order **can** have multiple delivery confirmations (because it can have multiple dispatches) — one per dispatch.
- A delivery confirmation references its dispatch (`dispatch_id`) **and** denormalises `sales_order_id` (immutable copy, matching the dispatch_lines convention) for query convenience.
- Partial *delivery* (fewer bottles received than dispatched) is a **line-level variance**, not a separate header — see §4.

---

## 3. Lifecycle / Status Model

**Delivery status is separate from dispatch status. Dispatch status and order status are unchanged by P2M-5.**

Recommended `delivery_confirmations.status` lifecycle:

```
pending ──(confirm, all lines received in full)──────────▶ delivered
pending ──(confirm, some lines short/damaged/rejected)──▶ delivered_with_variance
pending ──(mark failed: customer unavailable, rejected, wrong address, vehicle)──▶ failed
pending ──(cancel before any confirmation)──────────────▶ cancelled
delivered / delivered_with_variance / failed / cancelled  ──▶ TERMINAL
```

- `pending` — a delivery confirmation has been created for a dispatch (goods are "out for delivery") but receipt is not yet attested.
- `delivered` — fully received; every line delivered_qty = dispatched qty, zero variance.
- `delivered_with_variance` — received, but at least one line has a short/damaged/missing/rejected quantity. (A single `delivered` state with a variance flag is an acceptable alternative — see §21 locked-decision note; this review recommends the explicit status for reporting clarity.)
- `failed` — the delivery attempt did not succeed; nothing received. Terminal for *this attempt*; a re-attempt is a **new** row.
- `cancelled` — the pending confirmation was abandoned before any receipt (e.g. created in error).

**Critical boundaries (answering review question 2):**
- **Dispatch status stays physical** (`recorded`/`voided`). P2M-5 never writes `dispatches.status` except nothing — it's untouched.
- **Order completion stays tied to physical dispatch**, computed by the existing `recompute_sales_order_dispatch_status()` from allocation fulfilment. P2M-5 does **not** change `sales_orders.status`. An order is `completed` when physically dispatched in full, regardless of delivery outcome. (Rationale: the goods have physically left; delivery is a downstream attestation. If the business later wants "completed only when delivered," that's a deliberate future lifecycle change, flagged in §21, not a silent P2M-5 behaviour.)
- **Delivery confirmation does NOT affect stock.** No `stock_items`/`stock_movements`/`stock_allocations` write. A short/damaged delivery is recorded as variance metadata only.
- **Delivery confirmation does NOT affect Finance** (not implemented; boundary in §11).

---

## 4. Quantity / Partial Delivery Model

**`delivery_confirmation_lines`, one per `dispatch_line`, records delivered + variance quantities. The dispatched quantity remains authoritative; delivered quantity is an attestation, never an inventory mutation.**

Each delivery line carries (per dispatch line):
- `dispatched_qty` — **copied** from `dispatch_lines.qty_bottles` at confirmation time (immutable snapshot; the source of truth stays the dispatch line).
- `delivered_qty` — bottles the customer actually received (0 ≤ delivered_qty ≤ dispatched_qty).
- `variance_qty` — derived/stored = dispatched_qty − delivered_qty (the shortfall).
- `variance_reason` — enum-ish TEXT: `none`, `damaged`, `missing`, `rejected`, `short` (free-but-constrained; final set a locked decision).

**Which quantity is authoritative for what:**
- **Physical stock** → `stock_items` / `stock_movements` (unchanged). What was dispatched already left; a variance does **not** add stock back.
- **What was shipped** → `dispatch_lines.qty_bottles` (unchanged, immutable).
- **What was received** → `delivery_confirmation_lines.delivered_qty` (new; attestation only).
- **Discrepancy** → `variance_qty` + reason (new; *flags* a problem; the physical correction, if any, is a **Returns** action in a later phase, not here).

**Worked examples (review question 6):**

- *Order 100; Dispatch 1 = 60, Delivery 1 = 50; Dispatch 2 = 40, Delivery 2 = 40:*
  - Delivery 1 → `delivered_with_variance`, line delivered_qty 50, variance 10.
  - Delivery 2 → `delivered`, line delivered_qty 40, variance 0.
  - **Final state:** order `completed` (100 physically dispatched — unchanged); 100 dispatched; 90 delivered across two confirmations; 10 recorded as variance. Physical stock reflects −100 (both dispatches). The 10-bottle shortfall is *visible* but has **not** been returned to stock — resolving it (credit, re-ship, write-off, physical return) is Returns/Finance work in a later phase.
- *Dispatch 1 = 60, Delivery 1 = 55, 5 missing/damaged/rejected:* delivery `delivered_with_variance`, delivered_qty 55, variance_qty 5, variance_reason `damaged` (or split across reasons if per-reason granularity is wanted — deferred; one reason per line in P2M-5). **No historical dispatch quantity changes**; `dispatch_lines.qty_bottles` stays 60. No stock movement.

This cleanly satisfies "represent short/damaged without changing historical dispatch quantities."

---

## 5. Proof of Delivery Model

**Metadata-first, Storage-reference-ready. No Storage/upload/PDF built in P2M-5.**

On `delivery_confirmations` (header), nullable POD fields:
- `recipient_name` TEXT — who signed/received.
- `recipient_role` TEXT — e.g. "Receiving clerk", "Owner" (free text).
- `delivered_at` TIMESTAMPTZ — when the customer received it (distinct from `created_at`).
- `delivery_notes` TEXT — free text.
- `signature_ref` TEXT NULL — a Supabase Storage object path for a captured signature image (path only; nothing uploaded in P2M-5).
- `pod_document_ref` TEXT NULL — Storage object path for a POD photo/scanned document.
- `customer_acknowledged` BOOLEAN DEFAULT false — explicit acknowledgement flag.

**Why path-references not Storage plumbing now:** storing a nullable Storage *path* costs nothing and avoids a future migration; the actual upload, bucket policy, signed-URL generation, and PDF rendering are a later increment (§12). P2M-5 persists *metadata* + *references*; it does not read/write Storage.

---

## 6. Document Numbering

**Yes — delivery confirmations get their own org-scoped number, `POD-YYYY-NNNN`, via an RPC + sequence table, exactly mirroring `next_dispatch_number`/`dispatch_sequences`.**

- `delivery_sequences (org_id, order_year, last_number, …)` — per `(org, year)` counter, PK `(org_id, order_year)`, SELECT-only RLS, RPC-only writes.
- `next_delivery_number(p_org_id uuid)` — SECURITY DEFINER, pinned search_path, PUBLIC revoked / authenticated granted, locks the sequence row `FOR UPDATE`, format `POD-YYYY-NNNN` (e.g. `POD-2026-0001`). Gaps acceptable (consistent with DISP/SO numbering).
- Number assigned at confirmation creation inside the create RPC.

---

## 7. Failed Delivery Handling

A `failed` delivery confirmation records that an attempt did not succeed. Explicit answers:

- **Change dispatch status?** No. The dispatch physically happened; `recorded` stays.
- **Change Sales Order status?** No. Order completion is physical-dispatch-driven and unchanged.
- **Return stock?** **No** — a failed delivery does **not** move stock. The bottles are physically somewhere (truck, depot, customer floor). Reconciling that is a **Returns** action (deferred) if goods physically come back, or a dispatch **reversal** (existing P2M-4) if the whole dispatch is being unwound. Delivery confirmation never touches `stock_items`.
- **Create another attempt?** Yes — a re-attempt is a **new** `delivery_confirmations` row against the same `dispatch_id`. The failed row is terminal and preserved as history. The partial unique index (§19) ensures only one non-terminal/`delivered` confirmation exists per dispatch at a time, so re-attempts are clean.
- **Require future reversal/return?** Only if goods physically return → that's P2M-6 Returns (compensating movement, like P2M-4's model). P2M-5 just records the failed attempt + reason.

`failure_reason` TEXT on the header captures `customer_unavailable` / `customer_rejected` / `wrong_address` / `vehicle_issue` / `damaged_in_transit` / `other`.

---

## 8. Returns Boundary

**Returns are OUT of scope for P2M-5 and must be a separate future phase (recommend P2M-6).** Delivery confirmation and Goods Returned are **distinct concepts**:

- *Delivery confirmation* = attestation of receipt (no stock effect).
- *Returns* = physical goods coming back into a stock location → **must** create compensating `stock_movements` (a `return` / `receipt`-style positive movement through an RPC), re-open/adjust allocations or create new stock, and potentially trigger Finance credits.

Conflating them would reintroduce the "delivery changes stock" anti-pattern the brief forbids. P2M-5 records the *signal* (variance, failed, rejected); P2M-6 Returns performs the *physical correction*. A `delivery_confirmation_lines.variance_qty > 0` is the natural hand-off marker for a future return — exactly the way `dispatch_status='voided'` was the P2M-4 marker.

---

## 9. Audit Model

**Reuse the single `audit_log_row_change()` writer — add two `WHEN` branches, no second audit system.**

- Add mappings: `delivery_confirmations → 'delivery_confirmation'`, `delivery_confirmation_lines → 'delivery_confirmation_line'`, preserving all existing branches and fail-closed behaviour (same pattern as 051 added `dispatch`/`dispatch_line`).
- Triggers: `delivery_confirmations` AFTER INSERT **and** UPDATE (status, POD metadata, delivered_at, notes are mutable over the pending→terminal lifecycle); `delivery_confirmation_lines` AFTER INSERT (and UPDATE if delivered_qty can be edited while `pending`).
- Audited actions: creation, confirmation (status→delivered/variance), failure, cancellation, POD metadata attach, and any correction/void. The audit log captures who/when/old/new for each — sufficient; no bespoke events table.

---

## 10. Security / RLS

**SELECT-only RLS on the new tables; all writes via SECURITY DEFINER RPCs. Role model is deliberately NOT a copy of P2M-4's reversal roles.**

Recommended role matrix (answering review question 10 — delivery is a commercial/customer-facing act, so SALES is central, unlike reversal):

| Action | OWNER | ADMIN | SALES | CELLAR | FARM/VIEWER |
|--------|:---:|:---:|:---:|:---:|:---:|
| Create delivery confirmation | ✅ | ✅ | ✅ | ✅ | ❌ |
| Confirm delivery / attach POD / edit notes | ✅ | ✅ | ✅ | ✅ | ❌ |
| Mark failed | ✅ | ✅ | ✅ | ✅ | ❌ |
| Void / correct a confirmed delivery | ✅ | ✅ | ❌ | ❌ | ❌ |
| View deliveries | ✅ | ✅ | ✅ | ✅ | ✅ (read-only) |

- Create/confirm = OWNER/ADMIN/SALES/CELLAR (SALES **included** — they own the customer relationship; CELLAR included as they often do the physical handover). A new guard `assert_delivery_actor` (OWNER/ADMIN/SALES/CELLAR).
- Correction/void of a *confirmed* delivery = **OWNER/ADMIN only** (stricter — it unwinds an attestation), a second guard `assert_delivery_admin_actor`. This is why the P2M-4 reversal role set (OWNER/ADMIN/CELLAR, no SALES) is **not** blindly reused — delivery creation needs SALES; delivery correction is stricter than CELLAR.
- RLS: `is_org_member(org_id)` SELECT policy only on all three tables; no client INSERT/UPDATE/DELETE policies; `GRANT SELECT … TO authenticated` only. Cross-org integrity triggers (verifying dispatch/order belong to the same org) mirror `validate_dispatch_*_org_integrity`.

---

## 11. Finance Boundary

**Not implemented. Documented dependency:**

- Finance should ultimately recognise revenue on **delivery acceptance** (`delivered` / `delivered_with_variance`), **not** on dispatch — because delivery is when the customer accepts the goods, and variances (short/damaged) adjust the recognisable amount. This refines the earlier P2M-1 "recognise at completion" note: *completion = full delivery acceptance*, which P2M-5 is the first phase to actually capture.
- The eventual Finance entry must be traceable **Customer → Sales Order → Dispatch → Delivery Confirmation**, and idempotent (one entry per delivery confirmation, keyed to its id).
- Variance handling: a `delivered_with_variance` delivery implies the invoiced quantity may differ from the dispatched quantity — Finance (future) consumes `delivery_confirmation_lines.delivered_qty`, not `dispatch_lines.qty_bottles`, for billing. Documented so whoever builds Finance uses the right quantity.
- **No Finance tables/columns/RPCs/triggers in P2M-5.**

---

## 12. PDF / Document Generation

**P2M-5 creates the delivery *record* only. No PDF, no Storage upload, no signed URLs.**

- The schema is shaped to accept them later: `signature_ref` / `pod_document_ref` are nullable Storage *paths*; a future "document service" phase uploads to a Supabase Storage bucket, writes the path back, and renders a POD/delivery-note PDF.
- Recommended future sequence (out of scope now): (a) Storage bucket + RLS policy, (b) client-side or edge-function PDF generation from the delivery record, (c) store the generated PDF path in `pod_document_ref`.
- Cleanest architecture: **record now, documents later** — avoids coupling the data model to a rendering choice and keeps P2M-5 migration-stable.

---

## 13. Future South African Wine Context

The model stays compatible without adding compliance now:
- Delivery confirmation links to the dispatch, which links (via dispatch_lines → finished_product / allocation) to the existing wine lineage — so a future export/compliance phase can trace Customer → … → Wine Lot without P2M-5 duplicating lineage.
- `pod_document_ref` and the numbering scheme generalise to future export/delivery documentation.
- **No SAWIS/SARS/DALRRD, no excise, no export docs in P2M-5.** Deferred to P2N.

---

## 14. Proposed Database Model

Three new tables (prose only, no SQL). All org-scoped with the standard `id, org_id, owner_id, created_at, updated_at`, owner-immutable + updated_at triggers, cross-org integrity triggers, SELECT-only RLS, audit triggers.

### `delivery_confirmations` (header)
- **Purpose:** one delivery attempt/outcome for one dispatch.
- **Key fields:** `delivery_number` (org-unique, `POD-YYYY-NNNN`), `dispatch_id` (FK → dispatches, **RESTRICT**, NOT NULL), `sales_order_id` (FK → sales_orders, RESTRICT, denormalised immutable copy), `status` (`pending`/`delivered`/`delivered_with_variance`/`failed`/`cancelled`), `delivered_at` TIMESTAMPTZ NULL, `recipient_name` TEXT NULL, `recipient_role` TEXT NULL, `delivery_notes` TEXT NULL, `signature_ref` TEXT NULL, `pod_document_ref` TEXT NULL, `customer_acknowledged` BOOLEAN DEFAULT false, `failure_reason` TEXT NULL, `address_snapshot` JSONB NULL (copied from the dispatch's `address_snapshot` — historical immutability, matching 051).
- **Immutable after terminal status:** `delivery_number`, `dispatch_id`, `sales_order_id`, `address_snapshot`; terminal `status` and its outcome fields.
- **Indexes:** `org_id`, `dispatch_id`, `sales_order_id`, `status`; **partial unique** `(dispatch_id) WHERE status IN ('pending','delivered','delivered_with_variance')` to enforce "one active/successful delivery per dispatch" while allowing multiple `failed`/`cancelled` historical attempts.
- **RLS:** member SELECT only; writes via RPC. **Audit:** INSERT + UPDATE.

### `delivery_confirmation_lines` (detail)
- **Purpose:** delivered/variance quantities per dispatch line.
- **Key fields:** `delivery_confirmation_id` (FK → delivery_confirmations, **CASCADE** — the only cascade, lines meaningless without header), `dispatch_line_id` (FK → dispatch_lines, RESTRICT, the authoritative link), `dispatched_qty` INTEGER (immutable snapshot of dispatch_lines.qty_bottles), `delivered_qty` INTEGER (0..dispatched_qty), `variance_qty` INTEGER (dispatched − delivered), `variance_reason` TEXT (`none`/`damaged`/`missing`/`rejected`/`short`). Denormalised `finished_product_id`, `location_id` (immutable copies for query convenience, matching dispatch_lines).
- **CHECKs:** `delivered_qty >= 0`, `delivered_qty <= dispatched_qty`, `variance_qty = dispatched_qty - delivered_qty`, `variance_reason = 'none'` iff `variance_qty = 0`.
- **Immutable:** `dispatch_line_id`, `dispatched_qty`; `delivered_qty`/`variance_*` editable only while header `pending`.
- **Indexes:** `org_id`, `delivery_confirmation_id`, `dispatch_line_id`. **RLS:** member SELECT only. **Audit:** INSERT (+ UPDATE if editable while pending).

### `delivery_sequences`
- **Purpose:** per-(org, year) `POD-YYYY-NNNN` counter. **Fields:** `(org_id, order_year)` PK, `last_number`. SELECT-only RLS; written only by `next_delivery_number`. Mirrors `dispatch_sequences`.

**Explicitly NOT added:** no `delivered_stock`/`delivered_qty` column on `stock_items`; no new inventory balance; no second dispatch table; no stock-mutating column anywhere.

---

## 15. RPC / Transaction Model

All writes RPC-controlled, SECURITY DEFINER, pinned search_path, PUBLIC revoked / authenticated granted, org derived from the locked parent row (never trusted). Atomic where multiple rows change.

| RPC | Atomic? | Purpose |
|-----|:---:|---------|
| `next_delivery_number(org)` | n/a (seq lock) | Allocate `POD-YYYY-NNNN`. Internal-ish; same posture as `next_dispatch_number`. |
| `create_delivery_confirmation(p_dispatch_id, p_lines?, p_notes?)` | ✅ | Lock dispatch `FOR UPDATE`; verify it is `recorded` (not `voided`) and has no active/delivered confirmation; `assert_delivery_actor`; mint number; snapshot address from dispatch; create header `pending` + lines seeded from dispatch_lines (`delivered_qty` default = dispatched or 0 — locked decision §21). |
| `confirm_delivery(p_delivery_id, p_lines, p_pod)` | ✅ | Lock header `FOR UPDATE`; require `pending`; set per-line `delivered_qty`/variance; set `delivered`/`delivered_with_variance`; set `delivered_at`, recipient, notes, acknowledgement, refs. Idempotency guard: must be `pending` (committed under lock). **No stock writes.** |
| `fail_delivery(p_delivery_id, p_reason)` | ✅ | Require `pending`; set `failed` + `failure_reason`. No stock writes. |
| `cancel_delivery(p_delivery_id, p_reason)` | ✅ | Require `pending`; set `cancelled`. No stock writes. |
| `void_delivery_confirmation(p_delivery_id, p_reason)` | ✅ | OWNER/ADMIN only; unwind a *confirmed* delivery back to a corrected state **as an attestation correction** (compensating/append model like P2M-4 — e.g. a `voided` delivery status + reason, preserving history). **No stock effect.** |

**Transaction notes:** header + its lines are created/confirmed in one transaction. Lock order within P2M-5: `delivery_confirmations` → `delivery_confirmation_lines`; where a dispatch is referenced, lock the dispatch first (`dispatches` → delivery tables) to stay consistent with the global ordering and avoid deadlocks with reversal. **P2M-5 RPCs never lock or write `stock_items`/`stock_movements`/`stock_allocations`** — a hard rule that keeps the "no second stock truth" guarantee.

---

## 16. Existing P2M Integration

```
Customer
  → Sales Order                 (sales_orders — commercial truth)
    → Sales Order Line          (sales_order_lines)
      → Stock Allocation        (stock_allocations — reservation truth; fulfilled_qty)
        → Dispatch              (dispatches — physical dispatch event; status recorded/voided)
          → Dispatch Line       (dispatch_lines.qty_bottles — AUTHORITATIVE "what shipped"; immutable)
            → Delivery Confirmation      (delivery_confirmations — NEW; attestation of receipt; no stock effect)
              → Delivery Confirmation Line (delivery_confirmation_lines.delivered_qty — NEW; "what was received")
                → Proof of Delivery       (POD metadata/refs on the header — NEW)
```

**Authoritative-quantity map:**
- Physical balance → `stock_items.qty_bottles`.
- Physical ledger → `stock_movements` (incl. `dispatch` / `dispatch_reversal`).
- Reserved → `stock_allocations` (`qty_bottles` / `fulfilled_qty`).
- Shipped → `dispatch_lines.qty_bottles`.
- Received → `delivery_confirmation_lines.delivered_qty` (**new; attestation, not inventory**).
- Discrepancy → `delivery_confirmation_lines.variance_qty` (**new; a signal, resolved by future Returns**).

P2M-5 **reads** dispatch/order data and **adds** the delivery layer; it writes none of the existing P2M-1…P2M-4 tables.

---

## 17. UI Scope (recommended minimum, not implemented)

- **Deliveries list** (`/deliveries`) — list + search + status/date filter (mirrors Dispatches.jsx).
- **Delivery profile** (`/deliveries/:id`) — header, POD metadata, lines (dispatched vs delivered vs variance), traceability to the dispatch/order/customer.
- **Create/confirm delivery** — from a dispatch's profile (a "Record delivery" action on `DispatchProfile.jsx`) and/or the deliveries list. Confirm dialog captures recipient/notes/delivered quantities.
- **Delivery section on the Dispatch profile** — show the linked delivery confirmation + status.
- **Customer delivery history** — a tab/section on the customer profile (read-only), lower priority.
- POD *capture* (signature/photo upload) UI is **deferred** with Storage.

---

## 18. IN SCOPE (P2M-5)

- `delivery_confirmations`, `delivery_confirmation_lines`, `delivery_sequences` tables (+ triggers, RLS, audit wiring, cross-org integrity).
- `next_delivery_number` + create/confirm/fail/cancel/void RPCs (SECURITY DEFINER, atomic, no stock writes).
- Delivery lifecycle (`pending`/`delivered`/`delivered_with_variance`/`failed`/`cancelled`).
- Delivered + variance quantities (attestation only).
- POD **metadata** + nullable Storage **path** references.
- `POD-YYYY-NNNN` numbering.
- Read-only deliveries UI + dispatch-profile delivery section.
- Audit via the existing writer; Finance dependency **documented**.

## 19. OUT OF SCOPE (P2M-5)

- Any stock mutation from delivery (no `stock_items`/`stock_movements`/`stock_allocations` writes).
- Returns / goods-returned processing (→ P2M-6).
- Finance entries/tables/triggers (boundary documented only).
- Storage upload, signed URLs, PDF/document generation.
- Consolidated multi-dispatch deliveries (one-delivery-covers-many-dispatches).
- Per-reason variance splitting on a single line.
- SAWIS/SARS/DALRRD/export/excise compliance (→ P2N).
- Changing dispatch status or order-completion semantics.

## 20. Deferred Items

- **P2M-6 Returns:** physical goods return → compensating movement RPC, allocation/stock restore, keyed off delivery variance.
- **Document service:** Storage bucket + POD/delivery-note PDF generation + signed URLs.
- **Finance integration:** revenue recognition on delivery acceptance, idempotent, consuming `delivered_qty`.
- **Multi-dispatch consolidated delivery** (`delivery_group_id` pattern) if ever needed.
- **"Order completed only when delivered"** lifecycle option (deliberate future decision).

---

## 19/21-adjacent: Risks / Edge Cases

- **Delivery against a voided dispatch:** `create_delivery_confirmation` must reject when `dispatches.status = 'voided'`.
- **Reversal after delivery:** if a dispatch with a `delivered` confirmation is later reversed (P2M-4), the delivery confirmation becomes historically inconsistent. Recommend: `reverse_dispatch` should be **blocked** (or warn) when an active/`delivered` confirmation exists — a cross-phase guard to design in P2M-5 (reversal RPC checks for a non-terminal/delivered confirmation). Flag as a locked decision (§21).
- **Double-confirm / double-click:** `pending`-precondition under row lock is the idempotency guard (same pattern as record/reverse_dispatch).
- **Variance implies missing physical reconciliation:** a `variance_qty > 0` leaves bottles unaccounted physically until Returns exists — acceptable as a *recorded signal*, but must be clearly surfaced in UI so it's not mistaken for an inventory correction.
- **Partial unique index** must allow many `failed`/`cancelled` but only one active/`delivered` per dispatch.
- **Delivered_qty default seeding:** defaulting to dispatched_qty risks "rubber-stamp" full deliveries; defaulting to 0 forces explicit entry. Locked decision §21.
- **Address snapshot drift:** snapshot from the dispatch (not live customer address) — matches historical-immutability rule.

---

## 20. Recommended Implementation Sequence (for the future build phase)

1. **P2M-5.1 backend migration (single, transactional):** three tables + triggers + RLS + audit-writer extension + cross-org integrity + numbering RPC + create/confirm/fail/cancel/void RPCs + post-validation `DO $$`. Plus the `reverse_dispatch` cross-phase guard (reject when active delivery exists) if that locked decision is adopted — note this *does* touch `reverse_dispatch`, so it would be its own carefully-scoped `CREATE OR REPLACE` with full security re-assertion, not a silent edit.
2. **Live DB verification query** (one-row PASS/FAIL), same style as P2M-2/P2M-4.
3. **Authenticated test harness** (isolated, test-only route) to exercise create/confirm/fail against real dispatches — then removed, per the P2M-2/P2M-4 pattern.
4. **P2M-5.2 read-only UI:** deliveries list + profile + dispatch-profile delivery section + create/confirm dialogs.
5. **Deferred:** Storage/PDF, Returns, Finance.

---

## 21. Locked Decisions

1. **One delivery confirmation per dispatch (0..1 active/delivered; N historical failed/cancelled attempts).** Not per order, not multi-dispatch.
2. **Delivery lifecycle is separate** from dispatch status; **dispatch status and order completion are unchanged** by P2M-5.
3. **Delivery confirmation never mutates stock** (`stock_items`/`stock_movements`/`stock_allocations` untouched). Variances are recorded signals only.
4. **Delivered quantity is attestation; `dispatch_lines.qty_bottles` stays authoritative** for "what shipped." Physical balance stays in `stock_items`.
5. **Returns are a separate future phase (P2M-6)** — delivery confirmation only *flags* discrepancies.
6. **POD = metadata + nullable Storage path refs now; no Storage/PDF built.**
7. **`POD-YYYY-NNNN` numbering** via `delivery_sequences` + `next_delivery_number` RPC, org-scoped, gaps acceptable.
8. **Roles:** create/confirm = OWNER/ADMIN/SALES/CELLAR (`assert_delivery_actor`); void/correct = OWNER/ADMIN only (`assert_delivery_admin_actor`). **Not** a copy of P2M-4 reversal roles.
9. **Finance deferred; recognition boundary = delivery acceptance**, consuming `delivered_qty`, traceable to Customer→SO→Dispatch→Delivery, idempotent.
10. **Reusing the existing `audit_log_row_change()`** (two new mappings) — no second audit system.
11. **SELECT-only RLS + RPC-only writes** on all three new tables — no direct browser writes, consistent with every P2M table.
12. **To confirm before build (open notes):** (a) explicit `delivered_with_variance` status vs a `delivered` + variance flag; (b) `delivered_qty` default seed = dispatched vs 0; (c) whether `reverse_dispatch` is guarded against an existing active/delivered confirmation (recommended yes); (d) final `variance_reason` enum set.

---

## 22. Final Verdict

### P2M-5 ARCHITECTURE VERDICT: **PASS WITH NOTES**

**Pass:** Delivery Documents / Delivery Confirmation is a correct, well-bounded next phase. The recommended model (delivery_confirmations + delivery_confirmation_lines + delivery_sequences, delivery lifecycle separate from dispatch, attestation-only quantities, metadata-first POD, reuse of the audit/RLS/numbering/snapshot patterns) sits cleanly **on top of** the existing systems and introduces **no second stock truth**, honouring every hard boundary in the brief. Traceability is preserved end-to-end.

**Notes to resolve before implementation (from §21.12):**
1. `delivered_with_variance` as its own status vs a boolean flag on `delivered`.
2. `delivered_qty` default seed (dispatched vs 0) — affects whether full delivery is explicit or rubber-stamped.
3. Whether `reverse_dispatch` must be guarded against an existing active/`delivered` confirmation (recommended **yes**; this is the one place P2M-5 would deliberately touch a P2M-4 function, via a scoped `CREATE OR REPLACE`).
4. Final `variance_reason` and `failure_reason` enumerations.
5. Confirm order-completion semantics stay dispatch-driven (recommended) rather than delivery-driven.

No code, SQL, migrations, UI, or data were produced or changed. Implementation awaits explicit approval of the locked decisions and open notes.
