-- ============================================================
-- WINERIX — P2O-Finance (059): Auto-post triggers (Option A)
-- Attaches AFTER-UPDATE triggers that auto-post finance entries when real
-- economic events occur, WITHOUT modifying any existing RPC. This is the safe
-- alternative to re-creating confirm_delivery_confirmation / reverse_dispatch /
-- restock_return_line / writeoff_return_line: those hardened RPCs are left
-- untouched; the triggers fire in the SAME transaction as the RPC that changed
-- the row (atomic), and idempotency is guaranteed by the 058 unique index
-- (uq_finance_autopost_source) + ON CONFLICT inside post_finance_entry.
--
-- Depends on: 046/047 (sales_orders / sales_order_lines.unit_price),
--             051 (dispatch_lines.sales_order_line_id), 055 (delivery_confirmations
--             + lines), 056 (returns + return_lines), 057 (finance source cols),
--             058 (post_finance_entry).
--
-- POSTING RULES (P2O-Finance locked decisions):
--   * Income on delivery confirmed: when a delivery_confirmations row transitions
--     to 'delivered' or 'delivered_with_variance', post ONE income entry per
--     delivery line = delivered_qty * sales_order_line.unit_price (net), source
--     ('sales_delivery', delivery_confirmation_line.id).
--   * Income reversal on dispatch void: when a dispatches row transitions to
--     'voided', post a compensating EXPENSE-direction entry for each previously
--     posted delivery income on that dispatch, source ('dispatch_reversal',
--     the original delivery_confirmation_line.id), reverses_finance_id = original.
--   * Return credit on disposition: when a return_lines row transitions to
--     'restocked' or 'written_off', post ONE return-credit entry (expense
--     direction, reduces net revenue) = returned_qty * unit_price, source
--     ('return_credit', return_line.id).
--   * Zero amounts (unpriced lines) post nothing (post_finance_entry returns NULL).
--   * All idempotent: the unique index means re-firing posts at most once per
--     (source_type, source_id, type).
--
-- THIS MIGRATION DOES NOT: modify any existing RPC, change RLS, touch org_id/
--   owner_id, or seed data. Triggers are SECURITY DEFINER via the function they
--   call (post_finance_entry); the trigger functions themselves are owned by the
--   migration role and run with its rights.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public.post_finance_entry(uuid, uuid, text, text, text, numeric, date, text, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: post_finance_entry missing — run 058 first.' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.delivery_confirmations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_confirmations missing (055).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.return_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: return_lines missing (056).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.dispatches') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatches missing (051).' USING ERRCODE='undefined_table'; END IF;
END $$;

-- ============================================================
-- 1. INCOME ON DELIVERY CONFIRMED
-- AFTER UPDATE ON delivery_confirmations, only when status transitions INTO a
-- confirmed state. Posts one income entry per delivery line.
-- ============================================================
CREATE OR REPLACE FUNCTION public.autopost_delivery_income()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_line  RECORD;
BEGIN
  -- Fire only on the transition into a confirmed status.
  IF NEW.status NOT IN ('delivered','delivered_with_variance') THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  FOR v_line IN
    SELECT dcl.id AS delivery_line_id,
           dcl.delivered_qty,
           sol.unit_price,
           fp.name AS product_name
    FROM public.delivery_confirmation_lines dcl
    JOIN public.dispatch_lines dl       ON dl.id = dcl.dispatch_line_id
    JOIN public.sales_order_lines sol   ON sol.id = dl.sales_order_line_id
    LEFT JOIN public.finished_products fp ON fp.id = dl.finished_product_id
    WHERE dcl.delivery_confirmation_id = NEW.id
      AND dcl.delivered_qty > 0
  LOOP
    PERFORM public.post_finance_entry(
      NEW.org_id, v_actor, 'income', 'sales',
      format('Wine sale: %s (%s bottles)', COALESCE(v_line.product_name,'product'), v_line.delivered_qty),
      round((v_line.delivered_qty::numeric * COALESCE(v_line.unit_price,0))::numeric, 2),
      COALESCE(NEW.delivered_at::date, CURRENT_DATE),
      'sales_delivery', v_line.delivery_line_id, NULL
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopost_delivery_income ON public.delivery_confirmations;
CREATE TRIGGER trg_autopost_delivery_income
  AFTER UPDATE ON public.delivery_confirmations
  FOR EACH ROW
  WHEN (NEW.status IN ('delivered','delivered_with_variance') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.autopost_delivery_income();

-- ============================================================
-- 2. INCOME REVERSAL ON DISPATCH VOID
-- AFTER UPDATE ON dispatches, only on transition to 'voided'. For every income
-- entry previously posted for that dispatch's deliveries, post a compensating
-- entry (expense direction) linked via reverses_finance_id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.autopost_dispatch_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_inc   RECORD;
BEGIN
  IF NEW.status <> 'voided' THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  -- Find income rows posted from delivery lines belonging to THIS dispatch.
  FOR v_inc IN
    SELECT f.id AS income_id, f.amount, f.source_id AS delivery_line_id
    FROM public.finance f
    WHERE f.auto_generated
      AND f.source_type = 'sales_delivery'
      AND f.type = 'income'
      AND f.source_id IN (
        SELECT dcl.id
        FROM public.delivery_confirmation_lines dcl
        JOIN public.dispatch_lines dl ON dl.id = dcl.dispatch_line_id
        WHERE dl.dispatch_id = NEW.id
      )
  LOOP
    PERFORM public.post_finance_entry(
      NEW.org_id, v_actor, 'expense', 'sales_return',
      format('Dispatch %s reversed — sales income reversed', NEW.dispatch_number),
      v_inc.amount, CURRENT_DATE,
      'dispatch_reversal', v_inc.delivery_line_id, v_inc.income_id
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopost_dispatch_reversal ON public.dispatches;
CREATE TRIGGER trg_autopost_dispatch_reversal
  AFTER UPDATE ON public.dispatches
  FOR EACH ROW
  WHEN (NEW.status = 'voided' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.autopost_dispatch_reversal();

-- ============================================================
-- 3. RETURN CREDIT ON LINE DISPOSITION
-- AFTER UPDATE ON return_lines, only on transition INTO a terminal disposition
-- (restocked / written_off). Posts one credit (expense direction) = returned_qty
-- * unit_price, reducing recognised revenue.
-- ============================================================
CREATE OR REPLACE FUNCTION public.autopost_return_credit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_price NUMERIC;
  v_amount NUMERIC;
BEGIN
  IF NEW.disposition NOT IN ('restocked','written_off') THEN RETURN NEW; END IF;
  IF OLD.disposition = NEW.disposition THEN RETURN NEW; END IF;

  -- unit_price via the dispatch line -> sales order line.
  SELECT sol.unit_price INTO v_price
  FROM public.dispatch_lines dl
  JOIN public.sales_order_lines sol ON sol.id = dl.sales_order_line_id
  WHERE dl.id = NEW.dispatch_line_id;

  v_amount := round((NEW.returned_qty::numeric * COALESCE(v_price,0))::numeric, 2);

  PERFORM public.post_finance_entry(
    NEW.org_id, v_actor, 'expense', 'sales_return',
    format('Return credit: %s bottle(s) returned', NEW.returned_qty),
    v_amount, CURRENT_DATE,
    'return_credit', NEW.id, NULL
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopost_return_credit ON public.return_lines;
CREATE TRIGGER trg_autopost_return_credit
  AFTER UPDATE ON public.return_lines
  FOR EACH ROW
  WHEN (NEW.disposition IN ('restocked','written_off') AND OLD.disposition IS DISTINCT FROM NEW.disposition)
  EXECUTE FUNCTION public.autopost_return_credit();

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE v_oid OID; v_secdef BOOLEAN; v_cfg TEXT[]; v_path BOOLEAN; n INTEGER;
BEGIN
  -- The three trigger functions: exist, SECURITY DEFINER, pinned path.
  FOR v_oid IN SELECT unnest(ARRAY[
      to_regprocedure('public.autopost_delivery_income()'),
      to_regprocedure('public.autopost_dispatch_reversal()'),
      to_regprocedure('public.autopost_return_credit()')])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: an autopost trigger function is missing.' USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
    IF NOT v_secdef THEN RAISE EXCEPTION 'Post: % must be SECURITY DEFINER.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
    v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
    IF NOT v_path THEN RAISE EXCEPTION 'Post: % must pin search_path.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- The three triggers are attached.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
    ('trg_autopost_delivery_income','trg_autopost_dispatch_reversal','trg_autopost_return_credit');
  IF n <> 3 THEN RAISE EXCEPTION 'Post: expected 3 autopost triggers, found %.', n USING ERRCODE='raise_exception'; END IF;

  -- Confirm the four hardened RPCs were NOT modified by this migration: they
  -- still exist with their expected signatures (we never dropped/recreated them).
  IF to_regprocedure('public.confirm_delivery_confirmation(uuid, text, text, text, text, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'Post: confirm_delivery_confirmation signature changed/missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.reverse_dispatch(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Post: reverse_dispatch signature changed/missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.restock_return_line(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Post: restock_return_line signature changed/missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.writeoff_return_line(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Post: writeoff_return_line signature changed/missing.' USING ERRCODE='raise_exception'; END IF;

  RAISE NOTICE 'Post: P2O-Finance 059 auto-post triggers installed — delivery income, dispatch-reversal, and return-credit posting active; hardened RPCs untouched.';
END $$;

COMMIT;
