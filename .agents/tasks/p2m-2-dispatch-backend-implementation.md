# WineRix P2M-2 — Core Physical Dispatch Backend: Implementation Report

## 1. Implementation summary

P2M-2 introduces **physical fulfilment** to the WineRix sales pipeline as a single
Supabase SQL migration. It adds the dispatch header/line tables, a per-org/year
dispatch-number sequence, allocation fulfilment tracking, the two new sales-order
dispatch statuses, and the atomic `record_dispatch` RPC that physically removes
stock, writes a stock movement, advances allocation fulfilment, and recomputes
the order dispatch status — all in one transaction.

The authoritative model from the approved P2M-1 architecture is honoured exactly:

```
sales_orders -> sales_order_lines -> stock_allocations -> dispatches
  -> dispatch_lines -> stock_movements
```

- Physical stock stays authoritative in `stock_items.qty_bottles`.
- Reservations stay authoritative in `stock_allocations` (`qty_bottles` **never**
  modified; a new monotonic `fulfilled_qty` tracks progress).
- Physical history stays append-only in `stock_movements` (`movement_type='dispatch'`).

Backend/DB only. **No** frontend, dispatch UI, reports, Finance, invoices,
payments, export/excise, or void/correction logic was built. The `'voided'`
dispatch status exists as a forward-compat value with **no** code path that sets
it. No seed/test data. Nothing committed, added, or pushed.

## 2. Exact migration filename

`supabase/migrations/051_dispatch_core.sql`
(051 confirmed free; prior latest was `050_sales_order_lifecycle.sql`.)

## 3. Objects created / modified

### Tables created
| Object | Notes |
|--------|-------|
| `dispatch_sequences` | Per `(org_id, order_year)` counter for DISP-YYYY-NNNN; RLS SELECT-only; mirrors `sales_order_sequences`. |
| `dispatches` | Header. 11 columns; 3 FKs all RESTRICT; `uq_dispatch_number_per_org` org-scoped unique; `dispatch_status_check IN ('recorded','voided')`; 4 indexes. |
| `dispatch_lines` | Detail. 13 columns; 9 FKs (`dispatch_id` CASCADE, the other 8 RESTRICT); `dline_qty_positive CHECK (>0)`; 9 indexes. `stock_movement_id` nullable at table level only (see §6). |

### Tables altered
| Object | Change |
|--------|--------|
| `stock_allocations` | `ADD COLUMN fulfilled_qty INTEGER NOT NULL DEFAULT 0`; new CHECKs `salloc_fulfilled_qty_non_negative`, `salloc_fulfilled_qty_le_qty`, `salloc_open_qty_zero`, `salloc_partial_qty_consistent`, `salloc_fulfilled_qty_full`; status vocabulary extended with `partially_fulfilled`; terminal-timestamp CHECK extended to cover `partially_fulfilled`. `qty_bottles` untouched; no rows deleted/recreated; `released`/`cancelled` CHECKs unchanged (P2L-6 preserved). |
| `sales_orders` | `so_status_check` dropped and re-added adding `partially_dispatched` + `completed`, preserving all six originals (incl. vestigial `allocated`). `dispatched` NOT added. |

### Functions created
| Function | Security |
|----------|----------|
| `validate_dispatch_org_integrity()` | SECURITY DEFINER, pinned path; BEFORE INSERT/UPDATE trigger `dispatch_org_integrity`. |
| `validate_dispatch_line_org_integrity()` | SECURITY DEFINER, pinned path; BEFORE INSERT/UPDATE trigger `dline_org_integrity`; enforces the four allocation-identity invariants independently of the RPC. |
| `assert_dispatch_actor(uuid)` | SECURITY DEFINER, pinned path; PUBLIC revoked; NOT granted to authenticated (internal guard). Allows OWNER/ADMIN/CELLAR/SALES. |
| `next_dispatch_number(uuid)` | SECURITY DEFINER, pinned path; PUBLIC revoked; authenticated granted. DISP-YYYY-NNNN; sequence-row FOR UPDATE lock (copies `next_sales_order_number`). |
| `recompute_sales_order_dispatch_status(uuid)` | SECURITY DEFINER, pinned path; PUBLIC revoked; NOT granted to authenticated. Derives status from fulfilled quantities. |
| `record_dispatch(uuid, jsonb, text)` | SECURITY DEFINER, pinned path; PUBLIC revoked; authenticated granted. The single atomic dispatch RPC. |

### Function replaced (preserving behaviour)
| Function | Change |
|----------|--------|
| `audit_log_row_change()` | `CREATE OR REPLACE` adding `WHEN 'dispatches' THEN 'dispatch'` and `WHEN 'dispatch_lines' THEN 'dispatch_line'`; all 26 prior mappings preserved verbatim; fail-closed `ELSE NULL -> RAISE` kept. 26 -> 28 mappings. |

### Triggers created
`dispatch_owner_id_immutable`, `dispatch_updated_at`, `dispatch_org_integrity`,
`trg_audit_dispatches` (AFTER INSERT OR UPDATE); `dline_owner_id_immutable`,
`dline_updated_at`, `dline_org_integrity`, `trg_audit_dispatch_lines`
(AFTER INSERT only); `dispatch_seq_updated_at`.

## 4. Security summary

- **RLS**: enabled on `dispatches`, `dispatch_lines`, `dispatch_sequences`. Exactly
  one `SELECT` policy per table using `public.is_org_member(org_id)`. **No**
  INSERT/UPDATE/DELETE policy on any of them.
- **Grants**: `SELECT` only to `authenticated` on all three tables; no write grants.
- **RPC execution**: `record_dispatch` and `next_dispatch_number` are REVOKEd from
  PUBLIC and GRANTed to `authenticated`. `assert_dispatch_actor` and
  `recompute_sales_order_dispatch_status` are internal — REVOKEd from PUBLIC and
  **not** granted to authenticated.
- **search_path**: every function pins `SET search_path = public, pg_temp`.
- **Role gate**: `assert_dispatch_actor` admits OWNER/ADMIN/CELLAR/SALES; rejects
  FARM/VIEWER and non-members.
- **No client trust**: the client sends only `{stock_allocation_id, qty_bottles}`
  per line. Org, order line, product, and location are all **derived** from the
  locked allocation. The `dline_org_integrity` trigger independently re-validates
  the four allocation-identity equalities.
- All writes to the dispatch tables flow exclusively through the SECURITY DEFINER
  RPC (same append-only, RPC-controlled posture as `stock_items`/`stock_movements`/
  `stock_allocations`).

## 5. Audit summary

- The single shared writer `audit_log_row_change()` gains `dispatch` and
  `dispatch_line` entity-type mappings (28 total), preserving every prior branch
  and the fail-closed behaviour.
- `dispatches` is audited AFTER INSERT **and** UPDATE (status/notes are mutable).
- `dispatch_lines` is audited AFTER INSERT only (append-only facts; the transient
  `stock_movement_id` back-fill happens inside the creating transaction — same
  posture as `stock_movements`).
- The RPC never inserts audit rows manually; triggers do it. New `stock_movements`
  rows are audited by the pre-existing `trg_audit_stock_movements`, and
  `stock_allocations` fulfilment updates by the pre-existing
  `trg_audit_stock_allocations`.

## 6. Concurrency / idempotency summary

- **Lock order**: `sales_orders` (FOR UPDATE) -> `stock_allocations` (FOR UPDATE,
  processed in deterministic `ORDER BY stock_allocation_id`) -> `stock_items`
  (FOR UPDATE). The fixed order avoids deadlocks between concurrent dispatches.
- **Oversale / duplicate-fulfilment guard**: for each allocation,
  `remaining = qty_bottles - fulfilled_qty` is computed under the row lock and the
  request is rejected if it exceeds `remaining`. A concurrent 60+60 against a
  100-bottle allocation serialises on the allocation lock; the second transaction
  sees the committed `fulfilled_qty=60`, computes `remaining=40`, and fails.
- **No negative stock**: an independent check on the locked `stock_items` row
  rejects any request where `qty_bottles < requested` before decrementing. The
  table's own `qty_bottles >= 0` CHECK is a backstop.
- **Atomicity**: the whole RPC runs in one transaction; any `RAISE` rolls back the
  header, lines, movements, stock decrements, and allocation updates together.
- **Idempotency (this phase)**: provided solely by locking + the remaining-quantity
  validation. There is **no** client idempotency key (out of scope for P2M-2) —
  re-calling with the same payload records a second, distinct dispatch, bounded by
  the remaining-quantity check.
- **`stock_movement_id` nullability**: nullable at the column level only because the
  dispatch line must be inserted first to provide its id as the movement's
  `reference_id`. `record_dispatch` always back-fills it via UPDATE in the same
  transaction (insert header -> insert line -> insert movement -> set id). A SQL
  comment on the table documents this.

## 7. Post-validation results

The migration ends with a `DO $$` block (RAISE => rollback on a real apply) that
asserts: both dispatch tables + the sequence table exist; column counts
(dispatches 11, dispatch_lines 13); FK counts and delete behaviours (dispatches
3× RESTRICT; dispatch_lines 1× CASCADE on `dispatch_id` + 8× RESTRICT);
`dispatch_status_check` allows recorded/voided; `uq_dispatch_number_per_org`
present; `dline_qty_positive` present; RLS enabled with exactly one SELECT policy
and no write policy per table; no write grants to authenticated; the four + two +
two triggers exist; integrity functions are SECURITY DEFINER; audit writer retains
prior mappings and has both new ones; `stock_allocations.fulfilled_qty` + its five
CHECKs exist and `salloc_status_check` now contains `partially_fulfilled` (plus the
four originals); `so_status_check` contains `partially_dispatched` + `completed`
plus all six originals; `stock_movements_type_check` still contains `dispatch`;
`assert_dispatch_actor`/`recompute_sales_order_dispatch_status` are SECURITY DEFINER
and not PUBLIC/not authenticated; `next_dispatch_number`/`record_dispatch` are
SECURITY DEFINER, pin search_path, PUBLIC revoked, authenticated granted, anon
denied; `stock_items` has no reserved/allocated column; all three new tables empty.

**Static review**: the file is a single balanced `BEGIN; ... COMMIT;` with nine
balanced `$$`-quoted blocks. The patterns are copied field-for-field from the
in-repo precedents (sequence/numbering from 046, table/FK/RLS/audit/integrity/
recompute from 048, actor guard from 022). The structure matches 046/048/050.

## 8. Build result

- **Frontend build**: `npm run build` (vite) in `c:\Users\F5151422\WineRix`
  succeeded — `✓ 11955 modules transformed`, `✓ built in ~1m 10s`, exit code 0. The
  pre-existing "chunks larger than 500 kB" warning is unrelated to this change (the
  change is SQL-only and touches no JS).
- **Migration apply**: there is **no local Postgres / Supabase CLI** in this
  environment to actually apply the migration. Apply results are **not** fabricated.
  SQL correctness was verified by **static review against migrations 040–050**
  (exact pattern reuse) plus a dollar-quote / `BEGIN`-`COMMIT` balance check. The
  migration's own post-validation `DO $$` blocks are the executable safety net when
  a human runs it in the Supabase SQL Editor against the live schema.

## 9. Consolidated Supabase SQL verification query

Run this in the Supabase SQL Editor **after** applying `051_dispatch_core.sql`. It
returns one row per check with `check_name`, `result`, and `verdict`.

```sql
WITH checks AS (
  SELECT 'dispatches table exists' AS check_name,
         (to_regclass('public.dispatches') IS NOT NULL)::text AS result,
         CASE WHEN to_regclass('public.dispatches') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
  UNION ALL SELECT 'dispatch_lines table exists',
         (to_regclass('public.dispatch_lines') IS NOT NULL)::text,
         CASE WHEN to_regclass('public.dispatch_lines') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'RLS enabled on dispatches',
         (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatches'::regclass)::text,
         CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatches'::regclass) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'RLS enabled on dispatch_lines',
         (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatch_lines'::regclass)::text,
         CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid='public.dispatch_lines'::regclass) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'exactly 1 SELECT-only policy on dispatches',
         (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='dispatches')::text,
         CASE WHEN (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='dispatches')=1
               AND (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='dispatches' AND cmd IN ('INSERT','UPDATE','DELETE'))=0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'no write grant to authenticated on dispatch tables',
         (SELECT COUNT(*) FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name IN ('dispatches','dispatch_lines')
              AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE'))::text,
         CASE WHEN (SELECT COUNT(*) FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name IN ('dispatches','dispatch_lines')
              AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE'))=0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'org-scoped unique dispatch number',
         (EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_dispatch_number_per_org' AND contype='u'))::text,
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_dispatch_number_per_org' AND contype='u') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'dispatch_lines exactly 1 CASCADE FK (dispatch_id)',
         (SELECT COUNT(*) FROM pg_constraint WHERE conrelid='public.dispatch_lines'::regclass AND contype='f' AND confdeltype='c')::text,
         CASE WHEN (SELECT COUNT(*) FROM pg_constraint WHERE conrelid='public.dispatch_lines'::regclass AND contype='f' AND confdeltype='c')=1
               AND (SELECT COUNT(*) FROM pg_constraint WHERE conrelid='public.dispatch_lines'::regclass AND contype='f' AND confdeltype='r')=8
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'stock_allocations.fulfilled_qty exists',
         (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_allocations' AND column_name='fulfilled_qty'))::text,
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_allocations' AND column_name='fulfilled_qty') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'salloc_status_check allows partially_fulfilled',
         (EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salloc_status_check' AND pg_get_constraintdef(oid) ILIKE '%partially_fulfilled%'))::text,
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salloc_status_check' AND pg_get_constraintdef(oid) ILIKE '%partially_fulfilled%') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'so_status_check allows partially_dispatched + completed',
         (EXISTS (SELECT 1 FROM pg_constraint WHERE conname='so_status_check'
            AND pg_get_constraintdef(oid) ILIKE '%partially_dispatched%' AND pg_get_constraintdef(oid) ILIKE '%completed%'))::text,
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='so_status_check'
            AND pg_get_constraintdef(oid) ILIKE '%partially_dispatched%' AND pg_get_constraintdef(oid) ILIKE '%completed%') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'audit writer has dispatch + dispatch_line mappings',
         (EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
            AND pg_get_functiondef(oid) ILIKE '%''dispatch''%' AND pg_get_functiondef(oid) ILIKE '%''dispatch_line''%'))::text,
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
            AND pg_get_functiondef(oid) ILIKE '%''dispatch''%' AND pg_get_functiondef(oid) ILIKE '%''dispatch_line''%') THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'next_dispatch_number SECURITY DEFINER + search_path + authenticated + PUBLIC revoked',
         'secdef/path/auth/public',
         CASE WHEN (SELECT prosecdef FROM pg_proc WHERE oid='public.next_dispatch_number(uuid)'::regprocedure)
               AND EXISTS (SELECT 1 FROM unnest((SELECT proconfig FROM pg_proc WHERE oid='public.next_dispatch_number(uuid)'::regprocedure)) c
                           WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0)
               AND has_function_privilege('authenticated','public.next_dispatch_number(uuid)','EXECUTE')
               AND NOT has_function_privilege('public','public.next_dispatch_number(uuid)','EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'record_dispatch SECURITY DEFINER + search_path + authenticated + PUBLIC revoked',
         'secdef/path/auth/public',
         CASE WHEN (SELECT prosecdef FROM pg_proc WHERE oid='public.record_dispatch(uuid, jsonb, text)'::regprocedure)
               AND EXISTS (SELECT 1 FROM unnest((SELECT proconfig FROM pg_proc WHERE oid='public.record_dispatch(uuid, jsonb, text)'::regprocedure)) c
                           WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0)
               AND has_function_privilege('authenticated','public.record_dispatch(uuid, jsonb, text)','EXECUTE')
               AND NOT has_function_privilege('public','public.record_dispatch(uuid, jsonb, text)','EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'assert_dispatch_actor internal (not authenticated, not PUBLIC)',
         'internal',
         CASE WHEN (SELECT prosecdef FROM pg_proc WHERE oid='public.assert_dispatch_actor(uuid)'::regprocedure)
               AND NOT has_function_privilege('public','public.assert_dispatch_actor(uuid)','EXECUTE')
               AND NOT has_function_privilege('authenticated','public.assert_dispatch_actor(uuid)','EXECUTE')
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 'stock_items has NO reserved/allocated column',
         (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
            AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')))::text,
         CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
            AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN 'PASS' ELSE 'FAIL' END
)
SELECT check_name, result, verdict FROM checks ORDER BY verdict DESC, check_name;
```

## 10. Manual test plan (DO NOT execute — no data created here)

> I could **not** confirm from this environment whether `SO-2026-0001` exists in
> `ready_to_dispatch` with allocations (no DB access; migrations only create empty
> tables with no seed data). The plan below is written against **whatever** order
> meets the required characteristics.

**Required fixture characteristics** (set up by a human in the app / SQL editor):
- One sales order in status `ready_to_dispatch`.
- One order line for a product with ordered quantity **100** bottles.
- One **open** `stock_allocations` row for that line, `qty_bottles=100`,
  `fulfilled_qty=0`, at a location whose `stock_items.qty_bottles` is **4975**.
- The caller holds OWNER/ADMIN/CELLAR/SALES in the order's org.

**Test — partial then final dispatch**

1. Call `record_dispatch(order_id, '[{"stock_allocation_id":"<alloc>","qty_bottles":60}]')`.
   - Expect: a new `dispatches` row (`DISP-YYYY-0001`, status `recorded`); one
     `dispatch_lines` row (qty 60) with a non-null `stock_movement_id`; one
     `stock_movements` row (`movement_type='dispatch'`, `qty_bottles_delta=-60`,
     `reference_type='dispatch_line'`).
   - Expect: `stock_items.qty_bottles` **4975 -> 4915**.
   - Expect: allocation `fulfilled_qty=60`, status `partially_fulfilled`,
     `fulfilled_at` NULL.
   - Expect: order status `partially_dispatched`.
2. Call `record_dispatch(order_id, '[{"stock_allocation_id":"<alloc>","qty_bottles":40}]')`.
   - Expect: a second dispatch (`DISP-YYYY-0002`); one line (qty 40) + one movement
     (`-40`).
   - Expect: `stock_items.qty_bottles` **4915 -> 4875**.
   - Expect: allocation `fulfilled_qty=100`, status `fulfilled`, `fulfilled_at` set.
   - Expect: order status `completed`.
3. Negative — over-dispatch: with the allocation fulfilled, call with `qty_bottles=1`.
   - Expect: RAISE "cannot be dispatched (status is fulfilled)" (or
     remaining-quantity error if attempted while partially_fulfilled). No stock
     change, no new rows.
4. Negative — no negative stock: on a fresh fixture, request more than
   `stock_items.qty_bottles`.
   - Expect: RAISE "Insufficient physical stock". No decrement, no partial writes.
5. Concurrency — two sessions each dispatch 60 against the same 100-bottle open
   allocation.
   - Expect: one succeeds (fulfilled_qty 60), the other blocks on the allocation
     lock then fails the remaining-quantity check (40 remaining, 60 requested). No
     negative stock, no duplicate movement, no duplicate fulfilment.
6. Audit — after steps 1–2, `audit_log` has `INSERT` rows for `dispatch`,
   `dispatch_line`, and `stock_movement`, plus `UPDATE` rows for `stock_allocation`
   and `sales_order`.

## 11. Files changed

| File | Change |
|------|--------|
| `supabase/migrations/051_dispatch_core.sql` | **New** — the entire P2M-2 migration. |
| `.agents/tasks/p2m-2-dispatch-backend-implementation.md` | **New** — this report. |

No React component, service, page, navigation, `SalesOrderProfile.jsx`, or any
existing migration was touched. Nothing was committed, added, or pushed.

## 12. Risks / deviations

- **No per-dispatch address override param.** The approved `dispatches` field list
  and the `record_dispatch` signature (`p_sales_order_id, p_lines, p_notes`) carry
  no override argument, so `address_snapshot` defaults to a copy of the order's
  `shipping_address_snapshot`. A future override is out of scope. *(No behaviour
  change to existing objects.)*
- **`stock_movement_id` nullable at the table level.** Required by the
  insert-order dependency (line id is the movement's `reference_id`); always set
  within the same transaction by the RPC. Documented in a SQL comment. The
  integrity trigger validates it when present. This is the architecture's approved
  transaction-safe ordering, not a weakening of integrity.
- **No client idempotency key** (per the approved scope for this phase).
  Idempotency is provided only by row locking + remaining-quantity validation; a
  repeated call records a distinct dispatch bounded by remaining quantity.
- **`'voided'` status value with no logic** — intentional forward-compat only; no
  void RPC exists.
- **Verification is static-review + a frontend build only** in this environment:
  there is no local Postgres/Supabase CLI to apply the migration. Apply results are
  not fabricated; the migration self-verifies via its post-validation `DO $$`
  blocks when a human runs it in the Supabase SQL Editor against the live schema
  (040–050 already applied).
- **Plan note correction**: the plan recorded "no `package.json` at the WineRix
  root". There is one (`winerix@0.1.0`, vite). `npm run build` ran successfully, so
  the build result in §8 is a real pass, not a skipped step.
