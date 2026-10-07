# P2M-1 — Physical Dispatch, Shipment & Stock Fulfilment: Architecture Review

**Status:** Architecture / design output only. No code, migrations, UI, or data were changed. Nothing in this document has been implemented.

**Scope confirmation:** This report answers the 20 architecture questions and provides schema sketches, lifecycle diagrams, and locked decisions for a *future* implementation phase (P2M-2+). It does not implement Finance, invoices, customer payments, export/excise compliance, or shipping integrations, and it does not touch any P2L file, the database, or the UI.

---

## 1. Summary Answer

WineRix should introduce exactly two new tables — `dispatches` (header) and `dispatch_lines` (detail) — as the P2M physical-fulfilment record, sitting between the existing soft-reservation ledger (`stock_allocations`, P2L-6) and the existing physical-inventory ledger (`stock_movements`, P2K). No second stock ledger, no logistics platform, no new wine-lineage copy.

The recommended shape, confirmed against the actual schema read in this repo:

- One dispatch belongs to exactly **one** sales order (`dispatches.sales_order_id`, NOT NULL, RESTRICT). Multiple dispatches per order are allowed (supports partial shipment). A dispatch never spans multiple sales orders.
- `dispatch_lines` reference **both** `sales_order_line_id` and `stock_allocation_id` (not one or the other) — this is the only relationship that preserves full lineage (Q3) without inventing a redundant join, because `stock_allocations` already carries the order/line/product/location, and the allocation is the thing being *consumed*.
- Partial dispatch is represented by **multiple dispatch_lines rows against the same order line over time** — never by rewriting `sales_order_lines.quantity_bottles` or mutating `stock_allocations` history (Q4). "Remaining to dispatch" is always a derived value: `ordered − SUM(fulfilled allocation qty)`.
- Physical stock movement reuses the existing `stock_movements` ledger with a **new, more specific movement_type: `'dispatch'`** is already present in the current CHECK constraint vocabulary found in `040_stock_foundation.sql` (`receipt, transfer_in, transfer_out, adjustment, damage, sale, dispatch`) — so **no new value is needed**, and `'dispatch'` (not `'sale'`) is the correct one to use, because `'sale'` is ambiguous with a future POS/cellar-door walk-in sale concept that WineRix does not have yet, while `'dispatch'` already exists in the vocabulary specifically for this purpose and was evidently reserved for it.
- Allocation fulfilment uses **Option C** from Q10: add `fulfilled_qty` (and keep `qty_bottles` as the original reserved amount) directly on the existing `stock_allocations` row, transitioning `open → fulfilled` only when `fulfilled_qty = qty_bottles`, and introducing a new intermediate status `partially_fulfilled` for when it is not. This preserves the append-only *history* principle (no deletion, no duplication of rows) while avoiding a parallel "split the allocation into two rows" bookkeeping model that would complicate the existing `recompute_sales_order_allocation_status` logic.
- The dispatch operation is **ONE SECURITY DEFINER RPC** per dispatch action (`record_dispatch`), not a two-step create+complete pair — justified in Q6/RPC boundary section. WineRix's scale (small/mid producer, SALES/CELLAR staff physically walking to the warehouse and dispatching what's in front of them) does not need an editable "draft dispatch" concept; the existing codebase's pattern (`transfer_finished_stock`, `receive_bottling_output`) is consistently single-RPC-atomic, and P2M should match that pattern rather than introduce a new one.
- Order lifecycle adds exactly two new statuses to the existing `sales_orders.status` CHECK: `partially_dispatched` and `completed` (the frontend in `SalesOrderProfile.jsx` and `salesOrderService.js` already *anticipates* these two values today, see Evidence §2.9).
- Finance boundary: do **not** build Finance now. When built, Finance should be recognised **per completed dispatch** (not only at full order completion) — detailed justification in §16.

---

## 2. Evidence (grounded in the actual codebase)

### 2.1 Current stock model (P2K, migrations 038–043)
- `finished_products` (038): catalogue SKU, org-scoped, no lineage FK, `is_active` soft-retirement, no DELETE.
- `stock_locations` (039): `location_type` CHECK includes `dispatch_area` as an existing enum value — i.e. the schema already anticipated a dispatch concept at the location level.
- `stock_items` (040): one row per `(org_id, product_id, location_id)`, `qty_bottles INTEGER NOT NULL DEFAULT 0`, `CHECK (qty_bottles >= 0)`. This is confirmed as the **sole materialised physical balance**. No `reserved_qty`/`allocated_qty` column exists (verified — migration 049's post-validation explicitly checks `stock_items` has NO such column, confirming availability is always computed, never stored).
- `stock_movements` (040): append-only, `movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','transfer_in','transfer_out','adjustment','damage','sale','dispatch'))`. **This CHECK constraint is the authoritative vocabulary** and it already contains `'dispatch'` as an unused value — no migration since 040 has used it. `reference_type`/`reference_id` columns exist for anchoring a movement to its originating business event (used today for `'bottling_output'` in 041's receipt RPC, via a **partial unique index** `uq_stock_movements_receipt_bottling_output` for idempotency).
- `transfer_finished_stock` (042), `adjust_finished_stock`/`record_finished_stock_damage` (043): all follow the identical pattern — SECURITY DEFINER, pinned `search_path`, `FOR UPDATE` row locks on `stock_items`, upsert-then-lock for a possibly-new destination row, single ledger INSERT, `REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE ... TO authenticated`, extensive post-validation `DO $$` blocks. **This is the house style P2M must follow exactly.**

### 2.2 Current allocation model (P2L-6, migrations 048–049)
- `stock_allocations`: append-only ledger, one row per `(sales_order_line_id, location_id, qty_bottles)` reservation. Columns: `id, org_id, owner_id, sales_order_id, sales_order_line_id, finished_product_id, location_id, qty_bottles, status, allocated_at, released_at, fulfilled_at, notes, created_at, updated_at`.
- `status` CHECK: `('open','released','fulfilled','cancelled')`. **`fulfilled` and `fulfilled_at` already exist in the schema** — the migration's own comment states: *"open->fulfilled is set later by P2M dispatch — NOT in this migration"* and *"(open->fulfilled is P2M; the shape is supported here.)"* This is a direct, explicit hand-off instruction from P2L-6 to P2M-1 found in the code comments.
- Lifecycle timestamp CHECKs already enforce: an `open` allocation has neither `released_at` nor `fulfilled_at`; `released`/`cancelled` requires `released_at`; `fulfilled` requires `fulfilled_at`. **These CHECKs currently do not anticipate partial fulfilment** (there's no `fulfilled_qty` column yet) — this is a real gap P2M-1 must close (see §10).
- No client write policy exists on `stock_allocations` (SELECT only); all writes are via `allocate_stock_for_sales_order_line` / `release_stock_allocation`, both SECURITY DEFINER, enforced by `assert_sales_actor` (OWNER/ADMIN/SALES).
- `recompute_sales_order_allocation_status(p_sales_order_id)` is an internal SECURITY DEFINER helper that derives the order status from lines + OPEN allocations, and explicitly early-returns for any status outside `('confirmed','partially_allocated','ready_to_dispatch')` — meaning **it already defers to a later phase (P2M) for anything past `ready_to_dispatch`**, confirming P2M owns the next transition.

### 2.3 Current sales order lifecycle (P2L-4/5/6/7, migrations 046–050)
- `sales_orders.status` CHECK (046): `('draft','confirmed','allocated','partially_allocated','ready_to_dispatch','cancelled')`. Note: `'allocated'` exists in the CHECK but is **never produced** by any RPC read in this review (`recompute_sales_order_allocation_status` only ever sets `confirmed`, `partially_allocated`, or `ready_to_dispatch`) — it appears to be a reserved/vestigial value. **`'dispatched'`, `'partially_dispatched'`, and `'completed'` are NOT yet in the CHECK constraint.**
- However, `cancel_sales_order` (050) **already contains defensive code referencing these three not-yet-added values**: `IF v_order.status IN ('dispatched','partially_dispatched','completed') THEN RAISE EXCEPTION ...`. And the frontend (`salesOrderService.js`, `SalesOrderProfile.jsx`) already has `const inP2mState = ['dispatched', 'partially_dispatched', 'completed'].includes(order?.status);`. **This is strong, direct evidence of the intended P2M status vocabulary**, written in advance by the P2L authors. P2M-1 should adopt `partially_dispatched` and `completed` (dropping the standalone `dispatched` value — see §9 rationale) and extend the `so_status_check` CHECK constraint accordingly in the eventual P2M-2 migration.
- `confirm_sales_order` (047) is the only place billing/shipping addresses are snapshotted today, into `sales_orders.billing_address_snapshot` / `shipping_address_snapshot` JSONB columns, captured from `customer_addresses` at confirmation time. This is the **existing historical-snapshot pattern** P2M should reuse (§14).
- `sales_order_lines` carries its own commercial snapshots (`sku_code_snapshot`, `product_name_snapshot`, `bottle_volume_ml_snapshot`) taken at line-creation time, independent of the live `finished_products` row — confirming the established "snapshot at the moment of commitment" convention.

### 2.4 Role model (006_tenancy_foundation.sql)
`organisation_members.role` CHECK: `('OWNER','ADMIN','FARM','CELLAR','SALES','VIEWER')`. Confirmed — the brief's assumed role set is correct. Role write-permission patterns observed:
- `assert_cellar_actor` (022, reused by 041/042): OWNER/ADMIN/CELLAR.
- `assert_sales_actor` (048): OWNER/ADMIN/SALES.
- `assert_stock_admin_actor` (043): OWNER/ADMIN only (stricter, for destructive-adjacent ops like damage/adjustment).

### 2.5 Audit pattern (021 + every subsequent migration)
A **single audit writer function** `public.audit_log_row_change()` with one big `CASE TG_TABLE_NAME ... END` mapping table name → `entity_type` string, fail-closed (`RAISE EXCEPTION` on an unmapped table), `SECURITY DEFINER`, pinned `search_path`. Every new table gets exactly one more `WHEN` branch added via `CREATE OR REPLACE`, and a trigger attached (`AFTER INSERT [OR UPDATE] ...`). INSERT-only ledgers (e.g. `stock_movements`) are audited INSERT-only; mutable rows (e.g. `stock_items`, `stock_allocations`) are audited INSERT+UPDATE. **P2M must extend this exact same function/trigger**, not create a second audit system.

### 2.6 Cross-org integrity pattern
Every table with FKs to other org-scoped tables gets a dedicated `validate_<table>_org_integrity()` BEFORE INSERT/UPDATE trigger function (SECURITY DEFINER, pinned search_path) that re-derives the org from each referenced row and raises if any mismatch. This is distinct from (and in addition to) RLS. P2M must follow this for `dispatches`/`dispatch_lines`.

### 2.7 Idempotency pattern already in the codebase
`receive_bottling_output` (041) uses a **partial unique index** on `stock_movements(org_id, reference_id) WHERE movement_type='receipt' AND reference_type='bottling_output'` as the race-safe idempotency guard, *plus* a defensive `IF EXISTS (...) THEN RAISE EXCEPTION` check inside the function for a friendlier error message before the index would catch it. This is the house idempotency pattern (§12).

### 2.8 Concurrency pattern already in the codebase
Every mutating RPC (`transfer_finished_stock`, `adjust_finished_stock`, `record_finished_stock_damage`, `allocate_stock_for_sales_order_line`, `release_stock_allocation`, `confirm_sales_order`, `cancel_sales_order`) locks the relevant parent row(s) with `SELECT ... FOR UPDATE` before reading/writing balances, in a fixed order (order row, then line, then stock_items). This is the house concurrency pattern (§13).

### 2.9 Wine lineage chain (confirmed present)
`vineyards → plantings → harvest → grape_intakes → wine_batches → wine_lots → bottling_run_lots (wine_lot_id FK) → bottling_outputs (bottling_run_id FK) → ` then a **manual, service-layer link** into `finished_products` (there is no DB FK from `bottling_outputs` to `finished_products` — `receive_bottling_output(p_bottling_output_id, p_product_id, p_location_id)` takes the product as a *parameter*, chosen by the cellar user at receipt time, and the only durable link from stock back to lineage is via `stock_movements.reference_type='bottling_output' / reference_id=<bottling_output.id>` on the **receipt** movement). `lot_lineage` (022) records split/merge/blend edges between `wine_lots`. This confirms: **traceability from a dispatch all the way back to vineyard/cultivar is possible but requires walking stock_movements → bottling_outputs → bottling_run_lots → wine_lots → lot_lineage/wine_batches → grape_intakes → harvest → plantings/blocks/vineyards**, and critically **it is not a 1:1 chain** — one `finished_products` SKU can be fed by many receipt movements from many bottling outputs/lots over time, so a dispatch's lineage is "the finished product's possible source lots as of now," not a guaranteed single-lot pedigree, unless WineRix later adopts lot-level stock tracking (it currently does not — stock is tracked per `(product, location)`, not per `(product, lot, location)`). **This is an important edge case to flag (§ Risks).**

### 2.10 Finance module is currently unrelated to Sales
`src/pages/Finance.jsx` / `src/services/financeService.js` is a generic farm P&L tool scoped to `vineyard`/`block`, with `FINANCE_TYPES`/`FINANCE_CATEGORIES` and no `customer_id`, `sales_order_id`, or `dispatch_id` reference anywhere. **Finance and Sales are completely disconnected today.** Any future Finance-from-dispatch feature is a net-new integration, not an extension of an existing link.

---

## 3. Architecture Question Answers

### Q1 — Dispatch entity model
Introduce `dispatches` (header) + `dispatch_lines` (detail). Confirmed design:
- **One dispatch ↔ exactly one sales order.** `dispatches.sales_order_id UUID NOT NULL`, FK `ON DELETE RESTRICT` (matches the `fk_so_customer` RESTRICT pattern — history is never cascaded away).
- **One order can have multiple dispatches** (this is how partial shipment is represented at the header level — e.g. dispatch #1 ships 60 of 100, dispatch #2 ships the remaining 40 later).
- **One dispatch can span multiple order lines** (a single truck/delivery note commonly carries several SKUs from the same order) — enforced by `dispatch_lines.dispatch_id` FK, many lines per dispatch.
- **One dispatch must NOT fulfil multiple orders.** Recommend against — WineRix's `sales_orders` already snapshot a single customer + single address pair at confirmation; multi-order consolidated shipments would require a new concept (a "shipment" grouping multiple dispatches) that is pure logistics-platform territory and explicitly out of scope ("do not introduce a logistics platform"). If multi-order consolidation is ever needed, it should be modeled as *several dispatches that share a `transfer_group_id`-style correlation id*, not as one dispatch with a multi-order FK — this preserves the simple 1-order-per-dispatch invariant everywhere else in the schema.
- **Partial shipment**: represented by the existence of >1 dispatch rows against the same order, each with its own `dispatch_lines`. There is no "partial" flag on a dispatch — a dispatch is a complete, immutable record of what *was* physically shipped on that occasion. "Partial" is a property of the *order* (`partially_dispatched` status), not of a dispatch.
- **Backorder**: represented implicitly as the remaining undispatched quantity on a line = `sales_order_lines.quantity_bottles − SUM(fulfilled stock_allocations.fulfilled_qty for that line)`. No separate `backorders` table — this matches the existing "derive, don't store" philosophy visible in `recompute_sales_order_allocation_status` and the service-layer `getAvailableStockForProductLocation`.
- **Customer delivery address**: `dispatches` snapshots the shipping address **at the moment of dispatch**, as JSONB, mirroring `sales_orders.shipping_address_snapshot`. Recommend copying from `sales_orders.shipping_address_snapshot` by default (already immutable since confirmation) but allowing an override snapshot per dispatch — because a customer may change their delivery address between order confirmation and a later partial dispatch (e.g. order confirmed in January, dispatch #2 goes to a different branch in March). Each dispatch keeps its own historical snapshot; never a live FK to `customer_addresses`.
- **Immutable after dispatch**: `dispatch_lines.qty_bottles`, `product_id`, `location_id`, `stock_allocation_id`, `sales_order_line_id`, and the parent `dispatches.dispatched_at`, `address_snapshot`, `sales_order_id` are all immutable once created — the row is a historical fact, matching the `stock_movements` append-only philosophy. Only `dispatches.status` (e.g. `recorded` → `voided`, see Risks) and free-text `notes` may ever change, and only via a narrow RPC, never a direct UPDATE grant.

### Q2 — Dispatch lines
`dispatch_lines` columns and their purpose (answering the brief's checklist):
| Need | Column |
|---|---|
| What customer order was fulfilled? | `sales_order_id` (denormalised copy for query convenience, redundant with the line's order but avoids a join on every report — acceptable because it is immutable) |
| What order line was fulfilled? | `sales_order_line_id` FK |
| Which product was shipped? | `finished_product_id` FK (never duplicate SKU/name — read live or via the line's existing `sku_code_snapshot`) |
| How many bottles were shipped? | `qty_bottles` |
| From which stock location? | `location_id` FK |
| Which allocation(s) were consumed? | `stock_allocation_id` FK — **one dispatch_line per allocation consumed** (if an order line's 100 bottles were allocated as 60@FG-STORE-01 + 40@EXPORT-STORE-01, dispatching all of it produces **two** `dispatch_lines` rows, one per allocation, even though it is "one order line") |
| When was it shipped? | inherited from parent `dispatches.dispatched_at` (no per-line timestamp needed — a dispatch is a single atomic event) |

No product master data is duplicated: `dispatch_lines` carries only FKs (`finished_product_id`, `location_id`) plus the transactional facts (`qty_bottles`). Reporting joins to `finished_products`/`stock_locations` for display names, exactly as `stock_allocations` already does.

### Q3 — Allocation fulfilment
Recommend `dispatch_lines.stock_allocation_id` as a **direct FK to `stock_allocations`**, NOT `sales_order_line_id + allocation` as a composite, and NOT a new join table. Rationale: `stock_allocations` already carries `sales_order_id`, `sales_order_line_id`, `finished_product_id`, and `location_id` — every one of those is derivable by joining through the allocation. Adding a redundant `sales_order_line_id` directly on `dispatch_lines` would create two sources of truth for "which line does this fulfil" that could drift if an allocation were ever administratively reassigned (it currently isn't, but the FK-through-allocation keeps that door shut structurally rather than by convention). The brief's example (100 bottles via Allocation A @ 60 + Allocation B @ 40) is modeled as:
- `dispatch_lines` row 1: `stock_allocation_id = A`, `qty_bottles = 60`, `location_id = FG-STORE-01`
- `dispatch_lines` row 2: `stock_allocation_id = B`, `qty_bottles = 40`, `location_id = EXPORT-STORE-01`

Each dispatch_line's `qty_bottles` must be `<=` the referenced allocation's remaining `(qty_bottles − fulfilled_qty)` — enforced inside the RPC, not a static CHECK (the same approach `bottling_run_lots` uses for volume availability, per its own comment: *"not enforced by a static CHECK here — the future atomic completion RPC does that with row locking"*).

### Q4 — Partial dispatch
Represented purely via multiple `dispatch_lines` rows accumulating against the same `stock_allocations` row(s) over time (and multiple `dispatches` headers over time against the same order). `sales_order_lines.quantity_bottles` is **never** touched by P2M (no RPC in P2M should `UPDATE sales_order_lines`). `stock_allocations` rows are never deleted or had their original `qty_bottles` altered — only the new `fulfilled_qty` column increases (monotonically, never decreases) and `status` transitions `open → partially_fulfilled → fulfilled`. The remaining-to-dispatch figure for a line is always: `line.quantity_bottles − SUM(allocation.fulfilled_qty WHERE allocation.sales_order_line_id = line.id)`, computed live, the same way `recompute_sales_order_allocation_status` already computes "remaining" today for the allocation step.

### Q5 — Physical stock movement
On dispatch: `stock_items.qty_bottles` decreases by the dispatched quantity, at the specific `(product, location)` row, and exactly one `stock_movements` row is written per `(product, location)` touched — **never aggregated**. The existing CHECK vocabulary already contains `'dispatch'` as an allowed `movement_type` and no other migration has ever used it; this review recommends using it exactly as reserved: `movement_type = 'dispatch'`, `qty_bottles_delta = -qty`, `reference_type = 'dispatch_line'`, `reference_id = dispatch_lines.id`. No second ledger is created. No frontend code may touch `stock_items`/`stock_movements` directly (none does today — confirmed, every stock-mutating call in `stockService.js`/`stockAllocationService.js` goes through `supabase.rpc(...)`, never a raw `.update()`/`.insert()` on those two tables). The operation must be a new SECURITY DEFINER RPC following the exact pattern of `transfer_finished_stock`/`adjust_finished_stock`.

### Q6 — Atomic dispatch RPC: one RPC, not two
**Recommendation: ONE RPC** — `record_dispatch(p_sales_order_id, p_lines JSONB, p_notes TEXT DEFAULT NULL)` where `p_lines` is a JSONB array of `{ stock_allocation_id, qty_bottles }` (mirroring the JSONB-array-of-children pattern already used by `split_wine_lot`/`combine_wine_lots` in 022). It performs, in one transaction:
1. Authenticate (`auth.uid()` not null).
2. Resolve `v_order` by locking `sales_orders FOR UPDATE` — this derives `org_id` (never trust the client) and gives validate-the-org for free.
3. Authorise via a new `assert_dispatch_actor(target_org)` guard (mirrors `assert_sales_actor`/`assert_cellar_actor` — see §19 for exact role recommendation).
4. Validate order status is `ready_to_dispatch` or `partially_dispatched` (reject `draft`, `confirmed`, `partially_allocated`, `cancelled`, `completed`).
5. For each line in `p_lines`: lock the referenced `stock_allocations` row `FOR UPDATE`, verify it belongs to this order and is `open`/`partially_fulfilled`, verify `qty_bottles <= (allocation.qty_bottles - allocation.fulfilled_qty)`.
6. Lock the corresponding `stock_items` row `FOR UPDATE`, verify `qty_bottles >= requested` (physical sufficiency — a second, independent check from the allocation check, since in theory a damage/adjustment could have reduced physical stock below what was allocated, which is exactly the scenario the brief's atomicity rules are protecting against).
7. Decrement `stock_items.qty_bottles`.
8. Insert one `stock_movements` row (`movement_type='dispatch'`) per line.
9. Increment `stock_allocations.fulfilled_qty`; flip `status` to `fulfilled` (sets `fulfilled_at`) if fully consumed, else `partially_fulfilled`.
10. Insert the `dispatches` header row (if this is the first line of a new dispatch event) and `dispatch_lines` rows.
11. Recompute and set `sales_orders.status` (`partially_dispatched` or `completed`) via a new `recompute_sales_order_dispatch_status()` helper mirroring `recompute_sales_order_allocation_status`.
12. The `trg_audit_*` triggers on `stock_items`, `stock_movements`, `stock_allocations`, `dispatches`, `dispatch_lines`, and `sales_orders` fire automatically (reusing the single audit writer — no manual audit INSERT needed, exactly as every other RPC in the codebase relies on triggers rather than hand-written audit calls).
13. Return the created `dispatches` row + per-line results (table-returning function, as `allocate_stock_for_sales_order_line` does).

**Why one RPC and not two (create-draft + complete):** every existing P2K/P2L mutating RPC in this codebase (`transfer_finished_stock`, `receive_bottling_output`, `adjust_finished_stock`, `confirm_sales_order`, `allocate_stock_for_sales_order_line`) is single-call-atomic; none of them has a "draft then confirm" two-step pattern anywhere in the schema. Introducing a two-RPC pattern uniquely for dispatch would be an architectural outlier with no precedent, and it would require a `dispatches.status IN ('draft','recorded')` concept purely to support an edit window that WineRix's actual workflow (a CELLAR/SALES user physically confirming what just left the warehouse) does not need — the physical dispatch *has already happened* by the time anyone opens the dashboard to record it; there is nothing to "complete" later. A two-RPC design would also reopen exactly the "stock deducted but allocation remains open" / "allocation fulfilled but stock not deducted" split-transaction risk the brief explicitly warns against, since the two RPCs would run in two separate transactions. Keeping it as one atomic call is strictly safer and matches the house style.

### Q7 — Stock movement vocabulary
`'sale'` is **not** the correct value for this. It already exists in the CHECK constraint but, from the evidence, was never used by any RPC built so far (receipt/transfer/adjustment/damage cover 038-043; nothing in 044-050 touches `stock_movements`). `'sale'` most likely was reserved for a hypothetical point-of-sale / cellar-door retail concept distinct from a B2B sales-order dispatch. **`'dispatch'`** is the correct, already-present value for customer shipment and should be used as-is — no new value needs to be added to the CHECK constraint, which keeps the eventual P2M-2 migration smaller (no `ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT` on `stock_movements` needed at all). Inventory remains strictly bottle-based (`qty_bottles_delta INTEGER`), consistent with every other movement type.

### Q8 — Stock location
Each location touched by a dispatch produces its **own** `stock_movements` row (never aggregated across locations), exactly mirroring how `transfer_finished_stock` already writes two separate movements (`transfer_out` + `transfer_in`) rather than one netted row. For the brief's example (FG-STORE-01 −60, EXPORT-STORE-01 −40), dispatch produces two `dispatch_lines` rows (per Q3) and therefore two `stock_movements` rows, each correctly scoped to its own `(product_id, location_id)` and its own `stock_items` row.

### Q9 — Order lifecycle state machine
Add exactly two statuses to the existing `so_status_check` CHECK (which already lists `draft, confirmed, allocated, partially_allocated, ready_to_dispatch, cancelled`): **`partially_dispatched`** and **`completed`**. Do **not** add a separate `dispatched` status — a single dispatch that fully satisfies every line should go straight to `completed`, and a dispatch that satisfies some-but-not-all should go to `partially_dispatched`; there is no useful third state between "some" and "all" for a single-order view. (Note: the pre-existing defensive code in `cancel_sales_order` lists `'dispatched'` as a third value defensively, in case a future author adds it — this review recommends *not* adding it, and treating `partially_dispatched`/`completed` as sufficient; the `cancel_sales_order` guard clause is harmless either way since it's an `IN (...)` check that simply never matches an unused value.)

State diagram (new portion only — the `draft → … → ready_to_dispatch` portion is P2L and already implemented/unchanged):

```
ready_to_dispatch ──(record_dispatch, partial)──▶ partially_dispatched
ready_to_dispatch ──(record_dispatch, full)─────▶ completed
partially_dispatched ──(record_dispatch, more, still partial)──▶ partially_dispatched
partially_dispatched ──(record_dispatch, remainder)─────────────▶ completed
completed  ──(record_dispatch)──▶  REJECTED (RPC raises; no further dispatch ever allowed)
completed  ──(any stock deduction)──▶ REJECTED (RPC checks order status before touching stock_items)
cancelled  ──(record_dispatch)──▶  REJECTED (RPC checks order status; cancelled is a terminal, non-dispatchable state)
```

`ready_to_dispatch` can be partially dispatched immediately — confirmed yes, since `ready_to_dispatch` already means every line is *fully allocated* (per `recompute_sales_order_allocation_status`), so there is always enough open allocation to dispatch some or all of it right away.

### Q10 — Allocation status for partial consumption
Recommend **Option C**: add two columns to the existing `stock_allocations` table — `fulfilled_qty INTEGER NOT NULL DEFAULT 0` and extend the `status` CHECK to add `'partially_fulfilled'`, giving the final vocabulary `('open','released','partially_fulfilled','fulfilled','cancelled')`. Reasoning against the alternatives:
- **Option A (open allocation with remaining qty)** is actually what Option C *is* — "remaining" is just `qty_bottles - fulfilled_qty`, so A and C converge; this review treats them as the same recommendation.
- **Option B (split into fulfilled+remaining records)** would mean a single original reservation becomes two or more rows over multiple partial dispatches, breaking the 1 row = 1 reservation-event invariant that the append-only ledger design relies on everywhere else (`stock_movements`, `lot_volume_movements` all keep one row per *event*, not one row per *current remaining balance*). It would also require inventing a parent/child link between the split rows, which is unnecessary complexity P2M does not need.
- Option C requires one small, additive schema change to `stock_allocations` (two new nullable-safe columns, one CHECK extension) and **no new timestamp-consistency CHECK changes beyond adding `partially_fulfilled` to the existing "released/cancelled requires released_at" style guards** (a `partially_fulfilled` row has `fulfilled_at IS NULL` still, since it isn't *done* yet — only the final `fulfilled` transition sets `fulfilled_at`).

### Q11 — Append-only ledgers / audit
`dispatches` and `dispatch_lines` must be wired into the **existing single audit writer** (`audit_log_row_change()`), adding two more `WHEN` branches (`'dispatches' THEN 'dispatch'`, `'dispatch_lines' THEN 'dispatch_line'`) — the same `CREATE OR REPLACE FUNCTION` + preserve-every-existing-mapping pattern used by every migration from 038 onward. `stock_allocations`'s existing `trg_audit_stock_allocations` (already AFTER INSERT OR UPDATE) will automatically audit the `fulfilled_qty`/`status` changes with no modification needed — it already captures `old_data`/`new_data` diffs on every UPDATE. `stock_movements`'s existing `trg_audit_stock_movements` (AFTER INSERT only) automatically audits the new `'dispatch'` movements with no change. **No duplicate/parallel audit system should be created.**

### Q12 — Duplicate dispatch protection / idempotency
Two layers, matching the house pattern from `receive_bottling_output`:
1. **Row-level guard inside the RPC**: before dispatching, re-verify (under the `FOR UPDATE` lock from step 5/6 of Q6) that the allocation is still `open`/`partially_fulfilled` with sufficient remaining quantity — a second click that races in after the first commits will simply see `fulfilled_qty` already raised and fail the "sufficient remaining allocation" check, the same way `allocate_stock_for_sales_order_line` naturally prevents double-allocation via its own availability recomputation under lock.
2. **No separate client-supplied idempotency key is needed** for this operation (unlike `receive_bottling_output`, which anchors to an external, retryable event — a bottling output someone might click twice). A dispatch is not naturally idempotent/retryable in the same sense: each call to `record_dispatch` represents a *new physical shipment event* chosen by the user (which allocations, how many bottles, right now). The correct DB-level protection against a double-click is the row lock + remaining-quantity recheck described above, which is sufficient and matches `transfer_finished_stock`'s own protection against double-transfer (it has no idempotency key either — it relies purely on the `FOR UPDATE` lock + balance recheck).
3. As defence in depth, recommend the frontend disable the submit button while the RPC call is in flight (standard practice already used elsewhere in this codebase, e.g. `StockAllocationPanel`), but per the brief this is explicitly *not* the DB-level control — the DB-level control is the lock + recheck above.

### Q13 — Concurrency
Lock order, matching the established pattern (sales order → line → stock_items), extended by one more level for allocations:
1. `SELECT ... FROM sales_orders WHERE id = ... FOR UPDATE` (serialises all status transitions on this order, exactly as `allocate_stock_for_sales_order_line`/`cancel_sales_order` already do).
2. For each dispatch line: `SELECT ... FROM stock_allocations WHERE id = ... FOR UPDATE` (serialises concurrent dispatch/release against the *same allocation*).
3. `SELECT ... FROM stock_items WHERE org_id=... AND product_id=... AND location_id=... FOR UPDATE` (serialises concurrent dispatch/transfer/adjustment/damage against the *same physical balance* — this is the exact same row that `transfer_finished_stock`/`adjust_finished_stock`/`allocate_stock_for_sales_order_line` already lock, so dispatch naturally queues behind any other in-flight stock-mutating operation on that product/location).

Locking the order first and allocations/stock_items in a **consistent order** (sorted by UUID or by the order lines array order, same as the client submitted them) avoids a lock-order deadlock when two dispatches on different orders happen to touch overlapping `stock_items` rows in different sequences — this mirrors how `transfer_finished_stock` always locks source-then-destination in a fixed order rather than letting caller order vary.

### Q14 — Dispatch address
Recommend: **copy the sales order's existing `shipping_address_snapshot` into `dispatches.address_snapshot` by default, with the option for the user to pick a different (still-live) `customer_addresses` row to re-snapshot** at the moment of recording the dispatch. Never a live FK from `dispatches` to `customer_addresses` — matches the confirmed historical-immutability pattern already used by `sales_orders.shipping_address_snapshot` (populated once, at `confirm_sales_order`, and never re-read live afterward). This correctly handles the realistic scenario of a customer's delivery address changing between order confirmation and a later partial dispatch weeks/months after.

### Q15 — Finance boundary
**Do not implement Finance in P2M-1 or P2M-2.** Explicit boundary, validated against the actual confirmed rule in the brief ("Finance should be created when shipment is actually completed rather than at order confirmation") and the actual codebase (Finance today, per §2.10, has zero connection to Sales/Customers):
- `confirmed` / `partially_allocated` / `ready_to_dispatch`: **no Finance entry**, confirmed correct — these states represent commitment and reservation, not revenue-recognition events, and the current `Finance.jsx` module could not even represent them (no customer/order linkage exists).
- **Validated recommendation**: a Finance entry should be created **per completed dispatch** (i.e., at the point `record_dispatch` fulfils some or all of an order), not only when the *order* reaches `completed`. See §16 for the justification — this is the opposite of "wait for full order completion," and the brief's own phrasing ("per completed dispatch") supports recognising income as each dispatch event completes, not gating on the full order.
- When eventually built, the Finance entry must be traceable to `sales_order_id + dispatch_id + customer_id` (three FKs, not a denormalised copy of amounts) and must be idempotent against the same `dispatches.id` being re-processed (a partial unique index on `(org_id, reference_id) WHERE reference_type='dispatch'`, exactly mirroring the `uq_stock_movements_receipt_bottling_output` pattern from 041).

### Q16 — Finance amount (future-only) recognition recommendation
`sales_orders` already has `subtotal`, `discount_total`, `tax_total`, `total` (046) computed from `sales_order_lines` at confirmation and frozen (`sales_orders`'s UPDATE policy is draft-only — confirmed orders' totals are immutable in the normal path). **Recommendation: recognise income per completed dispatch (Option B)**, not per full order completion (Option A), for a small/mid wine producer like WineRix. Rationale:
- WineRix's own order model already supports multi-month partial fulfilment (allocate now, dispatch some now, dispatch the rest later) — waiting for 100% completion before any revenue is recognised would misstate the books for exactly the partial-shipment scenarios P2M-1 is designed to handle, potentially leaving revenue unrecognised for months on orders that are mostly fulfilled.
- The per-dispatch amount should be computed proportionally from the dispatched line quantities against each line's already-fixed `unit_price`/`tax_rate`/discount, using the same per-line money calculation already implemented by `compute_sales_order_line_money()` (047) — i.e. `dispatch_value = Σ (dispatch_line.qty_bottles / order_line.quantity_bottles) × order_line.line_total` per line touched. This reuses existing, tested money logic rather than inventing a new tax/discount computation.
- This is a recommendation only for the *future* Finance phase; no Finance code, table, or RPC should be touched now.

### Q17 — Cancellation
Once a dispatch exists against an order (any `dispatch_lines` row for that order), the order can **never return to `cancelled`** for the dispatched portion — but the *remaining undispatched balance* of a `partially_dispatched` order should still be cancellable, with a new, narrower rule than today's `cancel_sales_order`. Recommended clean lifecycle: extend `cancel_sales_order`'s existing guard (`v_order.status IN ('dispatched','partially_dispatched','completed') THEN RAISE EXCEPTION`) — this review recommends **replacing** that blanket block for `partially_dispatched` with a conditional one: allow cancellation of a `partially_dispatched` order's **open/partially_fulfilled allocations only** (the same "release open allocations first" rule already enforced today), while the `fulfilled` allocations and their `dispatch_lines`/`stock_movements` remain forever as historical fact. The order's final status after such a cancellation becomes a state this review recommends calling `completed` with a note (since whatever *did* ship is a done, invoiceable fact) rather than `cancelled` (since "cancelled" implies nothing happened) — avoiding the accounting ambiguity the brief flags. In short: **you cannot cancel what has already been dispatched; you can cancel what has not been, provided its allocations are released first, exactly as today's rule already requires.** `completed` (fully dispatched) orders can never be cancelled, matching the existing defensive check verbatim.

### Q18 — South African wine traceability
Confirmed chain exists end-to-end in the schema (§2.9): `vineyards → plantings → harvest (via `harvest_planting_link`, 013) → grape_intakes (014) → wine_batches (017)/batch_grape_intakes → wine_lots (018) [+ lot_lineage split/merge/blend, 022] → bottling_run_lots (034, wine_lot_id FK) → bottling_outputs (034) → [service-chosen link at receipt time] → stock_movements.reference_id (receipt, 041) → stock_items (per product+location, no lot granularity)`. **Dispatch must NOT duplicate any lineage field.** `dispatch_lines` carries only `finished_product_id` (already present) — tracing further back to a specific wine lot/vineyard requires walking the `stock_movements` history for that `(product_id, location_id)` back to its `'receipt'` rows and their `reference_id → bottling_outputs → bottling_run_lots → wine_lots`. Flagged limitation: because WineRix's stock is tracked **per product+location, not per product+location+lot**, a dispatch of 60 bottles cannot deterministically say *which* lot(s) contributed those exact 60 bottles if the same product/location received stock from multiple bottling runs/lots over time (first-in-first-out is not tracked). This is an accurate statement of current traceability precision, not a gap P2M should silently paper over — flagged in Risks.

### Q19 — Roles
| Role | Dispatch permission |
|---|---|
| OWNER | Full — record dispatch, view all, manage |
| ADMIN | Full — record dispatch, view all, manage |
| CELLAR | **Record dispatch** — matches `assert_cellar_actor`'s existing OWNER/ADMIN/CELLAR grouping used for all physical stock mutation (receive/transfer/damage); dispatch is a physical stock mutation, so CELLAR should be included exactly like those other operations |
| SALES | **View + initiate/request** — SALES already allocates stock (`assert_sales_actor`) and manages the order; recommend SALES can also *record* a dispatch (many small producers have the same person doing sales and walking the shipment to the courier), but this is a judgement call — if WineRix wants a stricter separation of duties (sales commits, cellar fulfils), SALES should be view-only on dispatch and CELLAR/OWNER/ADMIN record it. **Recommend: allow SALES to record dispatch too** (union of `assert_sales_actor` and `assert_cellar_actor` roles — i.e. a new `assert_dispatch_actor` guard permitting OWNER/ADMIN/CELLAR/SALES), since the existing allocation step already trusts SALES with stock-adjacent decisions and WineRix is a small producer where rigid separation of duties is unlikely to be the priority. |
| FARM | Read-only (no change — FARM has never had write access to any P2K/P2L/stock concept) |
| VIEWER | Read-only |

### Q20 — Reporting (minimum fields, not built now)
- Ordered qty (`sales_order_lines.quantity_bottles`)
- Allocated qty (open `stock_allocations.qty_bottles` sum)
- Dispatched/fulfilled qty (`stock_allocations.fulfilled_qty`, or `SUM(dispatch_lines.qty_bottles)`)
- Remaining qty (derived: ordered − fulfilled)
- Dispatch date (`dispatches.dispatched_at`)
- Customer (`sales_orders.customer_id` → `customers.legal_name`)
- Product (`dispatch_lines.finished_product_id` → `finished_products.sku_code`/`name`)
- Location (`dispatch_lines.location_id` → `stock_locations.location_code`)
- Stock movement reference (`stock_movements.id` / `reference_id` linking back to the `dispatch_line`)
- Dispatch status / order status (`dispatches.status`, `sales_orders.status`)

---

## 4. Recommended Schema Sketches (prose only — no DDL to run)

### 4.1 `dispatches` (header)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID NOT NULL | FK → organisations, RESTRICT |
| owner_id | UUID NOT NULL | FK → auth.users, RESTRICT, immutable (reuse `prevent_owner_id_change`) |
| sales_order_id | UUID NOT NULL | FK → sales_orders, RESTRICT (never cascade away dispatch history) |
| dispatch_number | TEXT NOT NULL | org-scoped unique, e.g. `DISP-YYYY-NNNN`, generated the same way as `next_sales_order_number` |
| dispatched_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | immutable once set |
| status | TEXT NOT NULL DEFAULT 'recorded' | CHECK IN ('recorded','voided') — see Risks for void handling |
| address_snapshot | JSONB | immutable, copied from the order's shipping snapshot or re-snapshotted at dispatch time |
| notes | TEXT | mutable (only free text) |
| created_at / updated_at | TIMESTAMPTZ | standard |

### 4.2 `dispatch_lines` (detail)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| org_id | UUID NOT NULL | FK → organisations, RESTRICT |
| owner_id | UUID NOT NULL | FK → auth.users, RESTRICT |
| dispatch_id | UUID NOT NULL | FK → dispatches, CASCADE (lines have no meaning without their header) |
| sales_order_id | UUID NOT NULL | denormalised for reporting convenience, FK RESTRICT |
| sales_order_line_id | UUID NOT NULL | FK → sales_order_lines, RESTRICT (derivable via allocation but kept for query simplicity, same denormalisation style as `sales_order_lines.sales_order_id` on an already-FK'd child) |
| stock_allocation_id | UUID NOT NULL | FK → stock_allocations, RESTRICT — the authoritative "what was consumed" link |
| finished_product_id | UUID NOT NULL | FK → finished_products, RESTRICT |
| location_id | UUID NOT NULL | FK → stock_locations, RESTRICT |
| qty_bottles | INTEGER NOT NULL | CHECK > 0 |
| stock_movement_id | UUID | FK → stock_movements, RESTRICT, nullable only transiently inside the transaction (set in the same statement) |
| created_at / updated_at | TIMESTAMPTZ | standard |

### 4.3 `stock_allocations` additive columns (not a new table)
| Column | Type | Notes |
|---|---|---|
| fulfilled_qty | INTEGER NOT NULL DEFAULT 0 | CHECK `fulfilled_qty <= qty_bottles`, monotonically increasing |
| status (extend CHECK) | TEXT | add `'partially_fulfilled'` to existing `('open','released','fulfilled','cancelled')` |

### 4.4 `sales_orders` additive status values (not a new table)
Extend `so_status_check` to add `'partially_dispatched'` and `'completed'` to the existing six values.

---

## 5. Relationship Summary

```
sales_orders (1) ──< dispatches (N)
sales_orders (1) ──< sales_order_lines (N) ──< stock_allocations (N) ──< dispatch_lines (N) >── dispatches (1)
stock_allocations (1) ──< dispatch_lines (N) [one allocation can be dispatched across multiple dispatch events over time]
dispatch_lines (1) ──> finished_products (1)   [no duplicated master data]
dispatch_lines (1) ──> stock_locations (1)
dispatch_lines (1) ──> stock_movements (1)      [one movement per line, never aggregated]
```

---

## 6. Physical Stock Movement Model
Reuses `stock_movements` exactly as-is: `movement_type='dispatch'`, `qty_bottles_delta = -qty`, `reference_type='dispatch_line'`, `reference_id=dispatch_lines.id`. One row per `(product, location)` touched. No new ledger, no new vocabulary value needed (`'dispatch'` already exists unused).

## 7. Allocation Fulfilment Model
`stock_allocations.fulfilled_qty` increases per dispatch event; `status` transitions `open → partially_fulfilled → fulfilled`. Original `qty_bottles` (the reservation) is never altered. `released_at`/`fulfilled_at` semantics preserved; `fulfilled_at` is set only on the final transition into `fulfilled`.

## 8. Partial Dispatch Model
Multiple `dispatches`/`dispatch_lines` rows accumulate against the same order/line/allocation over time. "Remaining" is always derived, never stored, matching the existing "available = physical − reserved" derived-value philosophy.

## 9. Order Lifecycle (state diagram)
See §Q9 above — `ready_to_dispatch → {partially_dispatched ⇄ partially_dispatched → completed}`, with `completed`/`cancelled` as terminal, non-dispatchable states.

## 10. Cancellation Behaviour
See §Q17 — dispatched portions are permanent; undispatched portions remain cancellable after releasing their open allocations, exactly as today's rule.

## 11. Idempotency Strategy
Row lock + remaining-quantity recheck under `FOR UPDATE` (no separate idempotency key needed — see §Q12 for why this operation differs from `receive_bottling_output`'s external-event idempotency need).

## 12. Concurrency Strategy
Fixed lock order: `sales_orders` → `stock_allocations` (per line) → `stock_items` (per product/location), all `FOR UPDATE`, matching the house pattern. See §Q13.

## 13. RPC Boundary
One RPC, `record_dispatch(...)`, atomic, SECURITY DEFINER. See §Q6 for full justification against a two-RPC split.

## 14. RLS / Security Model
- `dispatches`/`dispatch_lines`: RLS enabled, **SELECT-only policy** for org members (`is_org_member(org_id)`), **no client INSERT/UPDATE/DELETE policy** — all writes via the SECURITY DEFINER RPC, exactly mirroring `stock_items`/`stock_movements`/`stock_allocations`.
- Grants: `GRANT SELECT ON dispatches, dispatch_lines TO authenticated` only.
- `record_dispatch` RPC: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO authenticated`.
- A new `assert_dispatch_actor(target_org)` guard function (OWNER/ADMIN/CELLAR/SALES per §Q19), SECURITY DEFINER, not granted to PUBLIC, mirroring `assert_sales_actor`/`assert_cellar_actor`/`assert_stock_admin_actor`.
- Cross-org integrity trigger `validate_dispatch_org_integrity()` / `validate_dispatch_line_org_integrity()`, SECURITY DEFINER, pinned search_path, mirroring every prior migration's pattern.

## 15. Role Permissions Table
See §Q19.

## 16. Audit Strategy
Extend the single `audit_log_row_change()` writer with two new `CASE` branches; attach `AFTER INSERT [OR UPDATE]` triggers to `dispatches` and `dispatch_lines`; rely on the already-existing `trg_audit_stock_allocations` and `trg_audit_stock_movements` triggers to automatically pick up the new activity with zero changes. See §Q11.

## 17. Historical Address Strategy
Copy-on-dispatch snapshot into `dispatches.address_snapshot` (JSONB), defaulting to the order's existing `shipping_address_snapshot`, with the option to re-snapshot a different live address at dispatch time. See §Q14.

## 18. Finance Boundary (explicitly NOT built yet)
No Finance table, column, RPC, or UI changes in P2M-1/P2M-2. See §Q15.

## 19. Future Finance Recognition Recommendation
Per-completed-dispatch recognition (not per-order-completion), computed proportionally from each dispatched line against its already-frozen `sales_order_lines` pricing. See §Q16. This is a recommendation for a future phase only.

## 20. South African Wine Traceability Implications
Chain is traceable but not lot-precise once stock from multiple bottling runs mixes at the same `(product, location)` — see §Q18 and Risks below.

---

## 21. Future P2M Implementation Phases

- **P2M-2 (schema + core RPC)**: Add `dispatches`/`dispatch_lines` tables, extend `stock_allocations` with `fulfilled_qty`/`partially_fulfilled`, extend `sales_orders.status` CHECK with `partially_dispatched`/`completed`, implement `record_dispatch` RPC, `assert_dispatch_actor` guard, `recompute_sales_order_dispatch_status` helper, cross-org integrity triggers, audit wiring, RLS/grants, dispatch numbering RPC (`next_dispatch_number`, mirroring `next_sales_order_number`). Full post-validation `DO $$` blocks matching house style.
- **P2M-3 (frontend)**: `dispatchService.js` (mirroring `stockAllocationService.js`'s structure/error-friendly-messages pattern), a "Record Dispatch" panel on `SalesOrderProfile.jsx` (visible when `ready_to_dispatch`/`partially_dispatched`), a Dispatch History view, extend `StockLocations`/reporting pages to show dispatch activity.
- **P2M-4 (reporting)**: dedicated Dispatch Report page using the minimum fields from §Q20, plus a "Backorder" view (lines with `remaining > 0`).
- **P2M-5 (optional, only if WineRix needs it)**: void/correction workflow for a dispatch recorded in error (see Risks — this review deliberately does not design it in detail now since it is a correction/compensating-transaction concern, not core P2M-1 scope).
- **Finance phase (separate, later, explicitly out of scope here)**: build the Sales↔Finance link described in §Q15/Q16 only after P2M-2/3 are stable and in production use.

---

## 22. Risks / Edge Cases

1. **Void/correction of a mis-recorded dispatch.** Because `stock_movements` is append-only and dispatch lines are immutable, correcting an erroneous dispatch (e.g. wrong quantity typed in) requires a **compensating movement** (a reversing `stock_movements`/`stock_allocations` adjustment), not an UPDATE/DELETE of the original dispatch. This review recommends `dispatches.status` include a `'voided'` value for exactly this, with a future `void_dispatch` RPC that writes reversing entries rather than mutating history — but the detailed design of that RPC is deferred to P2M-5, since it is materially a different (and riskier) operation than the forward-dispatch path and deserves its own focused review.
2. **Lot-level traceability precision.** As flagged in §Q18, WineRix's stock model tracks balances per `(product, location)`, not per `(product, location, lot)`. A dispatch cannot deterministically identify which specific wine lot(s) contributed to a given shipped bottle once multiple receipts from different lots have landed in the same stock_items row. If SA wine traceability/compliance ever requires lot-precise outbound tracing (e.g. for a recall), WineRix would need a FIFO/lot-tracked stock model — a substantially larger change than P2M-1, flagged here but explicitly out of scope.
3. **Multi-location single order-line dispatch complexity for the UI.** The data model correctly supports splitting one order line's dispatch across two allocations/locations (§Q3), but this creates real UX complexity (the user must know to dispatch "60 from FG-STORE-01" and "40 from EXPORT-STORE-01" as two separate line entries) — a future UI should default to pre-filling the user's `dispatch_lines` input from each line's currently-open allocations, not expect manual re-entry.
4. **`'allocated'` status value is vestigial.** The existing `so_status_check` CHECK includes `'allocated'` but no RPC produces it (§2.3). P2M-2 should leave it as-is (removing it is out of scope and risks breaking any as-yet-unseen caller) but should not use it either.
5. **SALES role dispatching physical stock is a judgement call**, not a hard technical constraint — if WineRix later wants stricter segregation of duties (common in larger orgs, less common for a small producer), the `assert_dispatch_actor` role list is a single array literal to change; flagged as a locked-but-revisable decision, not an immutable one.
6. **Partial dispatch across multiple dispatches touching the same allocation concurrently** is protected by the lock order in §Q13, but if two different staff members simultaneously try to dispatch from the *same* order's *different* lines, they will serialise on the `sales_orders FOR UPDATE` lock at the header level even though their line-level work doesn't actually conflict — an acceptable, deliberate trade-off (safety over throughput) consistent with how `allocate_stock_for_sales_order_line` already serialises on the same order lock today.
7. **Dispatch address override UX**: allowing a per-dispatch address override (§Q14) means two dispatches on the same order could legitimately go to two different addresses — correct for real-world multi-site customers, but reporting/UI must clearly surface the per-dispatch address rather than assuming the order's snapshot always applies.

---

## 23. Explicit Locked Decisions

- [ ] New tables: `dispatches` (header) + `dispatch_lines` (detail). No logistics platform, no third table.
- [ ] One dispatch → exactly one sales order (RESTRICT FK). Multiple dispatches per order allowed. One dispatch may span multiple order lines. One dispatch may never span multiple orders.
- [ ] `dispatch_lines.stock_allocation_id` is a direct FK to `stock_allocations` — the sole "what was consumed" link (plus a denormalised `sales_order_line_id` for query convenience only).
- [ ] `stock_allocations` gets two additive columns: `fulfilled_qty INTEGER NOT NULL DEFAULT 0`, and `status` CHECK extended with `'partially_fulfilled'`. No new allocation table, no row-splitting.
- [ ] `sales_order_lines.quantity_bottles` and allocation `qty_bottles`/history rows are never rewritten or deleted by P2M.
- [ ] Stock movement vocabulary: reuse the existing, already-present, previously-unused `'dispatch'` value. Do **not** use `'sale'`. No CHECK constraint change needed on `stock_movements`.
- [ ] One `stock_movements` row per `(product, location)` touched by a dispatch — never aggregated across locations.
- [ ] Physical dispatch is performed by exactly **ONE** SECURITY DEFINER RPC (`record_dispatch`) per dispatch event — not a two-step create+complete pair.
- [ ] Lock order: `sales_orders` → `stock_allocations` (per line) → `stock_items` (per product/location), all `FOR UPDATE`.
- [ ] Idempotency: row lock + remaining-quantity recheck under lock; no separate client idempotency key required for this operation.
- [ ] `sales_orders.status` CHECK extended with exactly two new values: `partially_dispatched`, `completed`. No standalone `dispatched` value added.
- [ ] `ready_to_dispatch` can transition directly to either `partially_dispatched` or `completed` on the very first dispatch.
- [ ] `completed` orders can never be dispatched again or have stock deducted again; `cancelled` orders can never be dispatched. Dispatched quantities, once recorded, can never be cancelled (only voided via a future compensating RPC, out of scope now).
- [ ] Dispatch address: snapshot (JSONB) on `dispatches`, defaulting from the order's existing `shipping_address_snapshot`, never a live FK.
- [ ] No Finance table/column/RPC/UI work in this phase. When built later: per-completed-dispatch recognition (not per-order-completion), traceable to `sales_order_id + dispatch_id + customer_id`.
- [ ] No wine-lineage fields duplicated into `dispatches`/`dispatch_lines` — lineage is derived by walking `stock_movements → bottling_outputs → bottling_run_lots → wine_lots` from the `finished_product_id`/`location_id` already present.
- [ ] Audit: extend the existing single `audit_log_row_change()` writer with two new entity mappings; no second audit system.
- [ ] Roles permitted to record dispatch: OWNER, ADMIN, CELLAR, SALES (new `assert_dispatch_actor` guard). FARM and VIEWER remain read-only.
- [ ] No P2N compliance (export/excise) work in this phase.

---

### Sources reviewed
All conclusions above are grounded in direct reading of: `supabase/migrations/001` through `050` (with 001–037 skimmed for the lineage chain and audit-wiring pattern, and 038–050 read in full), plus `src/services/stockService.js`, `stockAllocationService.js`, `salesOrderService.js`, and `src/pages/SalesOrderProfile.jsx`, `src/pages/Finance.jsx`, `src/services/financeService.js`. No external web sources were used — this is a pure internal-codebase architecture review.
