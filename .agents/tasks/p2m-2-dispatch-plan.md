# WineRix P2M-2 — Core Physical Dispatch Backend: Implementation Plan

**Mode:** Plan from the approved P2M-1 architecture (`.agents/tasks/p2m-1-dispatch-architecture-review.md`). All decisions below are the architecture's locked decisions (§23); this plan only sequences them and pins them to the exact existing code patterns found in migrations 006/022/040/042/046/048/050.

**Deliverable:** ONE new migration file:
`c:\Users\F5151422\WineRix\.worktrees\p2m-2-dispatch\supabase\migrations\051_dispatch_core.sql`
(`051` is confirmed free — the highest existing migration is `050_sales_order_lifecycle.sql`.)

**Hard constraints from the user request (must hold for every item):** backend/DB only; no frontend; no void/correction RPC (the `voided` status VALUE may exist in the CHECK for forward-compat, but NO void logic); no Finance/invoices/payments/export-excise; do not modify unrelated P2L/P2K functionality or redesign existing architecture; no seed/test data; no commit/add/push; keep existing functionality intact. Modify no file except this plan during planning.

---

## Verification reality (RECORDED during exploration)

- There is **no local Supabase CLI / local Postgres** in the WineRix workspace. `supabase/config.toml` exists only in the unrelated `FarmHand-PRO` workspace, not in WineRix. There is **no `package.json`** at the WineRix root and no migration-apply script.
- Migrations are applied manually in the Supabase SQL Editor (every migration header says "Run this in Supabase SQL Editor"). The migration is self-verifying: it runs inside `BEGIN; ... COMMIT;` and ends with post-validation `DO $$` blocks that `RAISE EXCEPTION` (rolling back the whole transaction) if any object is missing or malformed.
- **Therefore the only verification available in this environment is STATIC REVIEW** plus a SQL syntax sanity check. Each item's "Verify" line reflects that. True execution verification happens when a human runs the file in the Supabase SQL Editor against the live schema (lines 040–050 already present).
- Syntax sanity check command (no DB needed), run from the worktree root:
  `Get-Content supabase/migrations/051_dispatch_core.sql` and confirm `BEGIN;`/`COMMIT;` balance, every `CREATE OR REPLACE FUNCTION ... AS $$ ... $$;` is dollar-quote balanced, and every `DO $$ ... END $$;` closes. If a Postgres client (`psql`) is ever available, `psql --single-transaction -f` against a scratch DB with 006–050 applied is the real test.

---

## Exact existing names / patterns to reuse (RECORDED — do NOT invent)

**`sales_orders` status CHECK (046, worktree + main identical):**
- Constraint name: **`so_status_check`**
- Current definition: `status IN ('draft','confirmed','allocated','partially_allocated','ready_to_dispatch','cancelled')`
- P2M-2 must `DROP CONSTRAINT so_status_check` then `ADD CONSTRAINT so_status_check CHECK (...)` re-listing all six existing values **plus** `'partially_dispatched'` and `'completed'`. Do NOT add `'dispatched'`. Keep `'allocated'` (vestigial but must not be removed — architecture Risk #4). `'cancelled'` stays.

**`stock_allocations` CHECK constraints (048):**
- `salloc_qty_positive` → `CHECK (qty_bottles > 0)`
- `salloc_status_check` → `CHECK (status IN ('open','released','fulfilled','cancelled'))`
- `salloc_open_has_no_terminal_ts` → `CHECK (status <> 'open' OR (released_at IS NULL AND fulfilled_at IS NULL))`
- `salloc_released_has_released_ts` → `CHECK (status NOT IN ('released','cancelled') OR released_at IS NOT NULL)`
- `salloc_fulfilled_has_fulfilled_ts` → `CHECK (status <> 'fulfilled' OR fulfilled_at IS NOT NULL)`
- Table columns (15): `id, org_id, owner_id, sales_order_id, sales_order_line_id, finished_product_id, location_id, qty_bottles, status, allocated_at, released_at, fulfilled_at, notes, created_at, updated_at`.
- Triggers already present: `salloc_owner_id_immutable`, `salloc_updated_at`, `salloc_org_integrity`, `trg_audit_stock_allocations` (AFTER INSERT OR UPDATE). The audit + updated_at triggers automatically capture the new `fulfilled_qty`/`status` changes — no new allocation trigger needed.

**`stock_movements` (040):**
- `stock_movements_type_check` → `CHECK (movement_type IN ('receipt','transfer_in','transfer_out','adjustment','damage','sale','dispatch'))` — **`'dispatch'` already present and unused. NO change to stock_movements CHECK is needed.**
- INSERT column list (from 042): `(org_id, owner_id, stock_item_id, product_id, location_id, movement_type, qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)`.
- For dispatch: `movement_type='dispatch'`, `qty_bottles_delta = -qty`, `reference_type='dispatch_line'`, `reference_id=<dispatch_lines.id>`, `transfer_group_id=NULL`.
- `stock_movements` audit trigger `trg_audit_stock_movements` is AFTER INSERT only — automatically audits new `'dispatch'` rows. No change.
- `stock_items` columns include `qty_bottles` with `CHECK (qty_bottles >= 0)`; locked via `SELECT * FROM public.stock_items WHERE org_id=... AND product_id=... AND location_id=... FOR UPDATE`.

**`next_sales_order_number(uuid)` (046) — COPY this exactly for `next_dispatch_number`:**
- Pattern: `SECURITY DEFINER`, `SET search_path = public, pg_temp`; checks `auth.uid()` and `is_org_member`; `INSERT INTO <sequences>(org_id, order_year, last_number) VALUES (p_org_id, v_year, 0) ON CONFLICT (org_id, order_year) DO NOTHING;` then `SELECT last_number+1 ... FOR UPDATE;` then `UPDATE ... SET last_number = v_next`; returns `format('SO-%s-%s', v_year, lpad(v_next::text,4,'0'))`.
- Backing table `sales_order_sequences`: PK `(org_id, order_year)`, `last_number INTEGER NOT NULL DEFAULT 0`, FK `org_id→organisations RESTRICT`, CHECK `last_number>=0`, CHECK `order_year BETWEEN 2000 AND 2200`, RLS SELECT for org members, `GRANT SELECT ... TO authenticated`.
- `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO authenticated;`

**Actor guards — `assert_cellar_actor` (022) is the template:**
- Body: resolve `uid := auth.uid()`; raise if null; raise if `NOT is_org_member(target_org)`; raise if `NOT has_org_role(target_org, ARRAY[...roles...])`; `RETURN uid`. `SECURITY DEFINER`, pinned path, `REVOKE ALL ... FROM PUBLIC` (NO grant to authenticated — internal guard).
- `assert_cellar_actor` roles = `ARRAY['OWNER','ADMIN','CELLAR']`; `assert_sales_actor` (048) roles = `ARRAY['OWNER','ADMIN','SALES']`.
- `assert_dispatch_actor` roles = **`ARRAY['OWNER','ADMIN','CELLAR','SALES']`** (architecture §Q19 / §14). FARM and VIEWER excluded.
- Role vocabulary (006 `organisation_members.role` CHECK): `OWNER, ADMIN, FARM, CELLAR, SALES, VIEWER`. `is_org_member(uuid)` and `has_org_role(uuid, text[])` exist (006).

**`recompute_sales_order_allocation_status(uuid)` (048) — MIRROR for the dispatch recompute:**
- `SECURITY DEFINER`, pinned path, `REVOKE ALL ... FROM PUBLIC` (internal; not granted to authenticated). Reads order status; early-returns if status is outside its own flow set; counts lines vs covered lines; `UPDATE sales_orders SET status=...` only if changed; `RETURN v_new_status`. Assumes caller holds the order `FOR UPDATE`.

**Cross-org integrity trigger — `validate_stock_allocation_org_integrity()` (048) is the template:** `SECURITY DEFINER`, pinned path, BEFORE INSERT OR UPDATE; re-derives org from each referenced row; raises `foreign_key_violation` if a referenced row is missing and `raise_exception` on any org mismatch or wrong parent linkage.

**Audit writer — `public.audit_log_row_change()` (021, last extended in 048 to 26 mappings):** single function, `CASE TG_TABLE_NAME ... END` → `entity_type`, fail-closed `RAISE EXCEPTION` on unmapped table, `SECURITY DEFINER`, pinned path, `REVOKE ALL ... FROM PUBLIC`. Extend via `CREATE OR REPLACE` **preserving all 26 existing `WHEN` branches** and adding exactly two: `WHEN 'dispatches' THEN 'dispatch'` and `WHEN 'dispatch_lines' THEN 'dispatch_line'` (→ 28 mappings). Attach `trg_audit_dispatches` and `trg_audit_dispatch_lines`.

**Owner immutability / updated_at:** `prevent_owner_id_change()` (010) BEFORE UPDATE; `update_updated_at()` (001) BEFORE UPDATE. Both already exist; just attach triggers.

---

## Object inventory (every object to create/alter, in dependency order, with the migration each mirrors)

1. `dispatch_sequences` table (new) + RLS + grant — mirrors `sales_order_sequences` (046).
2. `dispatches` table (new) + indexes — mirrors `stock_allocations` (048) table shape + `sales_orders` (046) for `*_snapshot` JSONB + numbering.
3. `dispatch_lines` table (new) + indexes — mirrors `stock_allocations` (048) FK/CHECK/index conventions.
4. `ALTER TABLE stock_allocations ADD COLUMN fulfilled_qty` + 2 CHECKs; extend `salloc_status_check` to add `partially_fulfilled`; update the lifecycle timestamp CHECKs — mirrors 048 CHECK style.
5. Extend `sales_orders.so_status_check` to add `partially_dispatched` + `completed` — drop/re-add, mirrors 046 CHECK.
6. Owner-immutability + updated_at triggers on `dispatches` and `dispatch_lines` — mirrors 048 §2.
7. `validate_dispatch_org_integrity()` + `validate_dispatch_line_org_integrity()` functions + BEFORE INSERT/UPDATE triggers — mirrors `validate_stock_allocation_org_integrity()` (048 §3).
8. RLS enable + SELECT-only policies on `dispatches`/`dispatch_lines`; `GRANT SELECT` only — mirrors 048 §4/§5.
9. Extend `audit_log_row_change()` (+2 mappings) + `trg_audit_dispatches` (AFTER INSERT OR UPDATE) + `trg_audit_dispatch_lines` (AFTER INSERT) — mirrors 048 §6.
10. `assert_dispatch_actor(uuid)` guard — mirrors `assert_cellar_actor` (022) / `assert_sales_actor` (048).
11. `next_dispatch_number(uuid)` RPC — copies `next_sales_order_number` (046).
12. `recompute_sales_order_dispatch_status(uuid)` helper — mirrors `recompute_sales_order_allocation_status` (048 §8).
13. `record_dispatch(uuid, jsonb, text)` core RPC — mirrors `allocate_stock_for_sales_order_line` (048/049) + `transfer_finished_stock` (042) locking/movement style.
14. Post-validation `DO $$` blocks — mirrors 046/048/050 post-validation.

The whole file is wrapped in a single `BEGIN; ... COMMIT;` with a pre-flight `DO $$` at the top, exactly like 048/050.

---

# Implementation Plan

- [ ] 1. Create the migration file skeleton: header comment block (purpose, depends-on 001/006/010/021/040/046/047/048/050, explicit "THIS MIGRATION DOES NOT" list copying the user's exclusions — no void logic, no Finance, no frontend, no seed data), opening `BEGIN;`, and a pre-flight `DO $$` block that fails fast if any dependency is missing (`to_regclass`/`to_regprocedure` checks for `sales_orders`, `sales_order_lines`, `stock_allocations`, `stock_items`, `stock_movements`, `finished_products`, `stock_locations`, `organisations`, `audit_log`, `audit_log_row_change()`, `is_org_member(uuid)`, `has_org_role(uuid,text[])`, `prevent_owner_id_change()`, `update_updated_at()`) and asserts `to_regclass('public.dispatches') IS NULL` and `to_regclass('public.dispatch_lines') IS NULL` (duplicate_table guard). Close with a matching `COMMIT;` placeholder at the end.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — pre-flight mirrors the 048 pre-flight block; `BEGIN;`/`COMMIT;` present and balanced.

- [ ] 2. Add the `dispatch_sequences` table (copy `sales_order_sequences` from 046 verbatim, renamed): PK `(org_id, order_year)`, `last_number INTEGER NOT NULL DEFAULT 0`, `created_at`/`updated_at`, FK `org_id → organisations ON DELETE RESTRICT` (`fk_dispatch_seq_org`), CHECK `last_number >= 0`, CHECK `order_year BETWEEN 2000 AND 2200`; `ENABLE ROW LEVEL SECURITY`; SELECT policy `USING (public.is_org_member(org_id))`; `GRANT SELECT ... TO authenticated`. No write policy/grant.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — structurally identical to `sales_order_sequences` (046), only names changed.

- [ ] 3. Create the `dispatches` header table with columns exactly: `id UUID PK DEFAULT gen_random_uuid()`, `org_id`, `owner_id`, `sales_order_id`, `dispatch_number TEXT NOT NULL`, `dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `status TEXT NOT NULL DEFAULT 'recorded'`, `address_snapshot JSONB`, `notes TEXT`, `created_at`, `updated_at`. FKs (all RESTRICT except as noted): `fk_dispatch_org (org_id→organisations)`, `fk_dispatch_owner (owner_id→auth.users)`, `fk_dispatch_order (sales_order_id→sales_orders)` NOT NULL. CHECKs: `dispatch_status_check CHECK (status IN ('recorded','voided'))` (value only — no void logic anywhere), `dispatch_number_not_blank CHECK (length(btrim(dispatch_number)) > 0)`. Org-scoped unique dispatch number: `CONSTRAINT uq_dispatch_number_per_org UNIQUE (org_id, dispatch_number)`. Indexes on `org_id`, `owner_id`, `sales_order_id`, `status`.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — matches 048 table conventions; `sales_order_id` NOT NULL + RESTRICT; `status` default `recorded`; dispatch_number org-unique.

- [ ] 4. Create the `dispatch_lines` detail table with columns exactly: `id UUID PK DEFAULT gen_random_uuid()`, `org_id`, `owner_id`, `dispatch_id`, `sales_order_id`, `sales_order_line_id`, `stock_allocation_id`, `finished_product_id`, `location_id`, `qty_bottles INTEGER NOT NULL`, `stock_movement_id UUID`, `created_at`, `updated_at`. FKs: `fk_dline_org (org_id→organisations RESTRICT)`, `fk_dline_owner (owner_id→auth.users RESTRICT)`, `fk_dline_dispatch (dispatch_id→dispatches ON DELETE CASCADE)`, `fk_dline_order (sales_order_id→sales_orders RESTRICT)`, `fk_dline_line (sales_order_line_id→sales_order_lines RESTRICT)`, `fk_dline_allocation (stock_allocation_id→stock_allocations RESTRICT)`, `fk_dline_product (finished_product_id→finished_products RESTRICT)`, `fk_dline_location (location_id→stock_locations RESTRICT)`, `fk_dline_movement (stock_movement_id→stock_movements RESTRICT)`. CHECK: `dline_qty_positive CHECK (qty_bottles > 0)`. Indexes on `org_id`, `owner_id`, `dispatch_id`, `sales_order_id`, `sales_order_line_id`, `stock_allocation_id`, `finished_product_id`, `location_id`, `stock_movement_id`. Note: `stock_movement_id` is nullable only transiently inside the RPC (set in the same transaction via UPDATE after the movement INSERT); it is NOT enforced NOT NULL at the column level because the dispatch_line row is inserted first to obtain its id for the movement's `reference_id`.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — exactly 9 FKs with the ON DELETE rules from the user request (dispatch_id CASCADE; all others RESTRICT); qty>0 CHECK present.

- [ ] 5. Alter `stock_allocations`: `ADD COLUMN fulfilled_qty INTEGER NOT NULL DEFAULT 0`; add `CONSTRAINT salloc_fulfilled_qty_non_negative CHECK (fulfilled_qty >= 0)` and `CONSTRAINT salloc_fulfilled_qty_le_qty CHECK (fulfilled_qty <= qty_bottles)`. Then migrate the status + lifecycle CHECKs safely (drop then re-add, preserving all existing rows — existing rows have `fulfilled_qty=0` default so remain valid): `DROP CONSTRAINT salloc_status_check` → `ADD CONSTRAINT salloc_status_check CHECK (status IN ('open','partially_fulfilled','released','fulfilled','cancelled'))`; `DROP CONSTRAINT salloc_open_has_no_terminal_ts` → re-add covering `partially_fulfilled` too: `CHECK (status NOT IN ('open','partially_fulfilled') OR (released_at IS NULL AND fulfilled_at IS NULL))`; keep `salloc_released_has_released_ts` as-is; keep `salloc_fulfilled_has_fulfilled_ts` as-is. Add a new `CONSTRAINT salloc_partial_qty_consistent CHECK (status <> 'partially_fulfilled' OR (fulfilled_qty > 0 AND fulfilled_qty < qty_bottles))` and `CONSTRAINT salloc_fulfilled_qty_full CHECK (status <> 'fulfilled' OR fulfilled_qty = qty_bottles)` and `CONSTRAINT salloc_open_qty_zero CHECK (status <> 'open' OR fulfilled_qty = 0)`. Wrap each DROP in `DROP CONSTRAINT IF EXISTS` for idempotency, matching the house `IF EXISTS` migration habit. Do NOT touch `qty_bottles`, do not delete rows, do not alter the P2L-6 release path (`released`/`cancelled` CHECKs unchanged).
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — lifecycle matrix matches the user request: `open`(qty=0, no ts); `partially_fulfilled`(0<qty<total, no ts); `fulfilled`(qty=total, fulfilled_at set); `released`/`cancelled` unchanged. Confirm the status CHECK keeps `open`, `released`, `fulfilled`, `cancelled` so existing P2L-6 behaviour and 050 guards still pass.

- [ ] 6. Alter `sales_orders`: `ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS so_status_check;` then `ADD CONSTRAINT so_status_check CHECK (status IN ('draft','confirmed','allocated','partially_allocated','ready_to_dispatch','partially_dispatched','completed','cancelled'));`. All six original values retained (incl. vestigial `allocated`); add exactly `partially_dispatched` and `completed`; do NOT add `dispatched`. Existing rows all hold values already in the new set, so the re-add never fails on current data.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — new CHECK is a strict superset of the 046 one plus the two P2M values; satisfies the 050 post-validation (`cancel_sales_order` references `partially_dispatched`/`completed`) and the 046/050 CHECK-presence assertions.

- [ ] 7. Attach owner-immutability and updated_at triggers to both new tables: `dispatch_owner_id_immutable`/`dline_owner_id_immutable` (BEFORE UPDATE → `prevent_owner_id_change()`), and `dispatch_updated_at`/`dline_updated_at` (BEFORE UPDATE → `update_updated_at()`). Use `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`, matching 048 §2.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — four triggers created using the two existing shared functions; no new trigger functions invented here.

- [ ] 8. Create `validate_dispatch_org_integrity()` and `validate_dispatch_line_org_integrity()` (SECURITY DEFINER, `SET search_path = public, pg_temp`) mirroring `validate_stock_allocation_org_integrity()` (048 §3). For `dispatches`: re-derive org from `sales_orders` and raise on missing/cross-org. For `dispatch_lines`: re-derive and verify same-org for `dispatches` (and `dispatch.sales_order_id = NEW.sales_order_id`), `sales_order_lines` (and `line.sales_order_id = NEW.sales_order_id`), `stock_allocations`, `finished_products`, `stock_locations`; and verify the allocation-derived identity invariants the user requires: `allocation.sales_order_id = NEW.sales_order_id`, `allocation.sales_order_line_id = NEW.sales_order_line_id`, `allocation.finished_product_id = NEW.finished_product_id`, `allocation.location_id = NEW.location_id`. Attach BEFORE INSERT OR UPDATE triggers `dispatch_org_integrity` and `dline_org_integrity`. (This is defence-in-depth; the RPC in item 12 is the primary enforcer and must not trust client-supplied duplicated values.)
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — both functions SECURITY DEFINER + pinned path; the dispatch_line trigger enforces the four allocation-identity equalities from the user request independently of the RPC.

- [ ] 9. Enable RLS and add SELECT-only policies on both tables (`"Users can view organisation dispatches"` / `"...dispatch lines"` `FOR SELECT USING (public.is_org_member(org_id))`), with NO INSERT/UPDATE/DELETE policy; `GRANT SELECT ON public.dispatches, public.dispatch_lines TO authenticated` only. Mirrors 048 §4/§5 (append-only, RPC-controlled posture identical to `stock_items`/`stock_movements`/`stock_allocations`).
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — exactly one policy per table, SELECT only; no write grants to authenticated.

- [ ] 10. Extend `audit_log_row_change()` via `CREATE OR REPLACE`, preserving ALL 26 existing `WHEN` branches verbatim and adding `WHEN 'dispatches' THEN 'dispatch'` and `WHEN 'dispatch_lines' THEN 'dispatch_line'` (28 total), keeping the fail-closed `ELSE NULL → RAISE EXCEPTION`, SECURITY DEFINER, pinned path, and `REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC`. Attach `trg_audit_dispatches` AFTER INSERT OR UPDATE (status/notes are mutable) and `trg_audit_dispatch_lines` AFTER INSERT only (dispatch_lines are immutable facts aside from the transient `stock_movement_id` set within the creating transaction — architecture §Q11 treats lines as append-only; AFTER INSERT is sufficient and matches `stock_movements`). Use `DROP TRIGGER IF EXISTS` first.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — the replaced function still contains the key prior mappings (`'sales_order'`, `'sales_order_line'`, `'stock_allocation'`, `'stock_movement'`, `'stock_item'`, `'customer'`) plus the two new ones; two audit triggers attached.

- [ ] 11. Create `assert_dispatch_actor(target_org UUID) RETURNS UUID` by copying `assert_cellar_actor` (022) and changing only the role array to `ARRAY['OWNER','ADMIN','CELLAR','SALES']` and the error message to require Owner/Admin/Cellar/Sales. SECURITY DEFINER, `SET search_path = public, pg_temp`, `REVOKE ALL ON FUNCTION public.assert_dispatch_actor(UUID) FROM PUBLIC` (internal guard — NOT granted to authenticated).
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — body identical to `assert_cellar_actor` except role list; PUBLIC revoked; no authenticated grant.

- [ ] 12. Create `next_dispatch_number(p_org_id UUID) RETURNS TEXT` by copying `next_sales_order_number` (046) exactly, changing only: it writes to `dispatch_sequences` (item 2) and returns `format('DISP-%s-%s', v_year, lpad(v_next::text, 4, '0'))`. Keep the auth + `is_org_member` checks, the `INSERT ... ON CONFLICT (org_id, order_year) DO NOTHING`, the `SELECT last_number+1 ... FOR UPDATE`, and the `UPDATE`. `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO authenticated;`
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — produces `DISP-YYYY-NNNN`; sequence-row locking identical to the SO allocator; SECURITY DEFINER + pinned path + authenticated-only.

- [ ] 13. Create `recompute_sales_order_dispatch_status(p_sales_order_id UUID) RETURNS TEXT` (SECURITY DEFINER, pinned path, PUBLIC revoked, internal — mirrors `recompute_sales_order_allocation_status`). Logic driven by **quantities, not dispatch-row counts** (user request §4): read current order status under the assumption the caller holds the order `FOR UPDATE`; only act when status is in `('ready_to_dispatch','partially_dispatched')` (early-return otherwise so draft/confirmed/cancelled/completed are never clobbered); compute per order line `ordered = sales_order_lines.quantity_bottles` and `fulfilled = COALESCE(SUM(stock_allocations.fulfilled_qty WHERE sales_order_line_id = line.id), 0)`; if every line has `fulfilled >= ordered` → `completed`; else if `SUM(fulfilled) > 0` across the order → `partially_dispatched`; else retain `ready_to_dispatch`. `UPDATE sales_orders SET status=...` only if changed; `RETURN` the status.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — derives from `fulfilled_qty` sums (never from COUNT of dispatches); never transitions out of the dispatch flow set; mirrors the 048 recompute helper structure.

- [ ] 14. Create the core `record_dispatch(p_sales_order_id UUID, p_lines JSONB, p_notes TEXT DEFAULT NULL)` RPC (SECURITY DEFINER, `SET search_path = public, pg_temp`), atomic, returning a table (dispatch header fields + per-line results, in the style of `allocate_stock_for_sales_order_line`). Implement the required validation/flow in this exact order, deriving/validating all duplicated values from the DB (never trusting the client beyond `stock_allocation_id` + `qty_bottles` per line):
      (a) `auth.uid()` not null else raise.
      (b) `SELECT * INTO v_order FROM sales_orders WHERE id = p_sales_order_id FOR UPDATE;` raise if not found. Derive `org_id` from `v_order` (never from client).
      (c) `v_owner := assert_dispatch_actor(v_order.org_id);`
      (d) Reject unless `v_order.status IN ('ready_to_dispatch','partially_dispatched')` (explicitly reject draft/confirmed/allocated/partially_allocated/cancelled/completed).
      (e) Validate `p_lines` is a non-empty JSONB array (`jsonb_typeof = 'array'` and `jsonb_array_length > 0`), else raise.
      (f) Generate `v_dispatch_number := next_dispatch_number(v_order.org_id);` and compute `v_address := COALESCE(v_order.shipping_address_snapshot, NULL)` for the header `address_snapshot` (copy-on-dispatch default per architecture §Q14; no per-dispatch override param in this phase — the user request's `dispatches` fields list does not include an override param, so default from the order's shipping snapshot).
      (g) INSERT the `dispatches` header (status `'recorded'`, `dispatched_at = NOW()`, `notes = NULLIF(btrim(p_notes),'')`) → capture `v_dispatch_id`.
      (h) Loop over `p_lines` elements in a deterministic order (ORDER BY the element's `stock_allocation_id` to give a fixed lock order and avoid deadlocks, per architecture §Q13): for each `{stock_allocation_id, qty_bottles}`:
         - validate `qty_bottles` is a positive integer;
         - `SELECT * INTO v_alloc FROM stock_allocations WHERE id = <alloc_id> FOR UPDATE;` raise if not found;
         - verify `v_alloc.sales_order_id = v_order.id` (allocation belongs to this order) else raise;
         - verify `v_alloc.status IN ('open','partially_fulfilled')` else raise;
         - **derive** `sales_order_line_id`, `finished_product_id`, `location_id` from `v_alloc` (do NOT accept them from the client);
         - compute remaining `= v_alloc.qty_bottles - v_alloc.fulfilled_qty`; raise if `qty_bottles > remaining`;
         - `SELECT * INTO v_item FROM stock_items WHERE org_id=v_order.org_id AND product_id=v_alloc.finished_product_id AND location_id=v_alloc.location_id FOR UPDATE;` raise if missing; raise if `v_item.qty_bottles < qty_bottles` (independent physical-sufficiency check);
         - `UPDATE stock_items SET qty_bottles = qty_bottles - <qty> WHERE id = v_item.id;`
         - INSERT the `dispatch_lines` row first (to get its id) with the DB-derived identities and a NULL `stock_movement_id`, capturing `v_line_id`;
         - INSERT one `stock_movements` row: columns `(org_id, owner_id, stock_item_id, product_id, location_id, movement_type, qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)` = `(v_order.org_id, v_owner, v_item.id, v_alloc.finished_product_id, v_alloc.location_id, 'dispatch', -<qty>, 'dispatch_line', v_line_id, NULL, format('Dispatch %s', v_dispatch_number), NOW())`, capturing `v_move_id`;
         - `UPDATE dispatch_lines SET stock_movement_id = v_move_id WHERE id = v_line_id;`
         - update the allocation: `new_fulfilled = v_alloc.fulfilled_qty + <qty>`; if `new_fulfilled = v_alloc.qty_bottles` → `UPDATE stock_allocations SET fulfilled_qty=new_fulfilled, status='fulfilled', fulfilled_at=NOW() WHERE id=v_alloc.id;` else → `SET fulfilled_qty=new_fulfilled, status='partially_fulfilled'` (leave `fulfilled_at` NULL).
      (i) After the loop, `PERFORM recompute_sales_order_dispatch_status(v_order.id);` (order already locked FOR UPDATE).
      (j) Return the created dispatch header plus per-line result rows.
      `REVOKE ALL ON FUNCTION public.record_dispatch(UUID, JSONB, TEXT) FROM PUBLIC; GRANT EXECUTE ... TO authenticated;`
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review against the user request §6/§7 and architecture §Q6/§Q13 — lock order sales_orders→stock_allocations→stock_items; org derived from order; the four allocation identities derived not trusted; physical sufficiency checked independently of allocation remaining; one movement per line; `'dispatch'` movement_type; monotonic `fulfilled_qty`; `qty_bottles` never mutated; atomic (single transaction).

- [ ] 15. Add the post-validation `DO $$` block(s) at the end (before `COMMIT;`), mirroring 046/048/050 style, asserting (RAISE → rollback) at minimum: both new tables exist; `dispatches` has 3 FKs, `dispatch_lines` has 9 FKs with correct `confdeltype` (dispatch_id = `c` CASCADE, the rest `r` RESTRICT); `dispatch_status_check` allows `recorded`/`voided`; `uq_dispatch_number_per_org` unique constraint present; `stock_allocations` now has `fulfilled_qty` and the new CHECKs, and `salloc_status_check` now allows `partially_fulfilled` while still allowing `open`/`released`/`fulfilled`/`cancelled`; `so_status_check` now allows `partially_dispatched` + `completed` and still all six originals (incl. `allocated`) and does NOT contain a standalone `dispatched`-only addition beyond the allowed set; `stock_movements_type_check` is UNCHANGED (still contains `dispatch`); RLS enabled with exactly one SELECT policy and no write policy on each new table; no INSERT/UPDATE/DELETE grant to authenticated on the new tables; the four new triggers + two audit triggers + two integrity triggers exist; `assert_dispatch_actor`, `next_dispatch_number`, `recompute_sales_order_dispatch_status`, `record_dispatch` all exist, are SECURITY DEFINER, pin search_path, with PUBLIC not executable; `record_dispatch`/`next_dispatch_number` executable by authenticated and the two internal helpers NOT granted to authenticated; audit writer retains prior mappings + has the two new ones; both new tables are EMPTY (no seed data); `stock_items` still has no reserved/allocated column (regression guard copied from 048). Then `COMMIT;`.
      Files: supabase/migrations/051_dispatch_core.sql
      Verify: static review — post-validation covers every object from items 2–14 and the key regression guards; on a real Supabase run the whole migration rolls back if any assertion fails.

---

## Assumptions / gaps noted (reasonable defaults taken)

- **No per-dispatch address override param.** The user's `dispatches` field list and the `record_dispatch` signature (`p_sales_order_id, p_lines, p_notes`) contain no override argument, so `address_snapshot` defaults to the order's `shipping_address_snapshot` (architecture §Q14 default path). A future override is out of scope for P2M-2.
- **`dispatch_lines` audited AFTER INSERT only** (immutable facts), while `dispatches` is AFTER INSERT OR UPDATE (status/notes mutable). This matches architecture §Q11 and the `stock_movements` vs `stock_allocations` precedent.
- **`voided` status value exists in the CHECK but no code path can set it** — satisfies "value may exist for future compatibility" while honouring "DO NOT implement void functionality."
- **Verification is static-review only** in this environment (no local Supabase/psql). The migration's own post-validation `DO $$` blocks are the executable safety net when a human applies it in the Supabase SQL Editor.
- **Single file, no file splitting**, matching every prior P2x migration (one `.sql` per phase step).
