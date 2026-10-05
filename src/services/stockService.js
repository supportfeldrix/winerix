import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Service (P2K-5, Receive Finished Goods)
//
// Reads finished-goods inventory (stock_items, stock_movements — SELECT only,
// append-only ledger) and performs the controlled receipt of a completed
// bottling output into stock via the SECURITY DEFINER RPC
// public.receive_bottling_output(uuid, uuid, uuid). This service performs NO
// client-side inventory mutation: all balance/ledger changes happen inside the
// atomic RPC transaction (one 'receipt' movement + stock_items upsert, keeping
// stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta)).
//
// Bottles are the only unit; litres are never stored (derive when needed).
// Reads are scoped to the active organisation on top of org-based RLS.
// Schema: migrations 040 (stock_items/stock_movements) + 041 (receipt RPC).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyStockError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The stock database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('already been received') || msg.includes('duplicate') || msg.includes('unique')) {
    return 'This bottling output has already been received into stock.';
  }
  if (msg.includes('completed bottling run')) {
    return 'Finished goods can only be received from a completed bottling run.';
  }
  if (msg.includes('inactive') && msg.includes('product')) {
    return 'The selected finished product is inactive and cannot receive stock.';
  }
  if (msg.includes('inactive') && msg.includes('location')) {
    return 'The selected stock location is inactive and cannot receive stock.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected product or location belongs to a different organisation.';
  }
  if (msg.includes('no bottles to receive')) {
    return 'This bottling output has no bottles to receive.';
  }
  if (msg.includes('source and destination')) {
    return 'The source and destination locations must be different.';
  }
  if (msg.includes('insufficient stock')) {
    return 'There is not enough stock at the source location for this transfer. The quantity may have changed — please refresh and try again.';
  }
  if (msg.includes('no stock of this product at the source')) {
    return 'There is no stock of this product at the source location.';
  }
  if (msg.includes('transfer quantity')) {
    return 'Transfer quantity must be a positive number of bottles.';
  }
  if (msg.includes('inactive') && msg.includes('transfer')) {
    return 'The selected finished product is inactive and cannot be transferred.';
  }
  if (msg.includes('reason is required')) {
    return 'A reason is required for this operation.';
  }
  if (msg.includes('below zero')) {
    return 'This would take stock below zero. The quantity may have changed — please refresh and try again.';
  }
  if (msg.includes('insufficient stock to record damage')) {
    return 'There is not enough stock at this location to record that much damage. Please refresh and try again.';
  }
  if (msg.includes('no stock of this product at the selected location')) {
    return 'There is no stock of this product at the selected location.';
  }
  if (msg.includes('adjustment quantity')) {
    return 'Adjustment quantity must be a non-zero number of bottles.';
  }
  if (msg.includes('damage quantity')) {
    return 'Damage quantity must be a positive number of bottles.';
  }
  if (msg.includes('owner or admin')) {
    return 'You do not have permission to adjust or damage stock. This requires an Owner or Admin role.';
  }
  if (msg.includes('not found')) {
    return 'The bottling output, product or location could not be found.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('owner, admin or cellar')) {
    return 'You do not have permission to receive finished goods. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normaliseItem(i) {
  if (!i) return null;
  const product = i.finished_product || null;
  const location = i.stock_location || null;
  return {
    id: i.id,
    productId: i.product_id,
    locationId: i.location_id,
    qtyBottles: i.qty_bottles,
    ownerId: i.owner_id,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    // Derived context (read-only).
    productSkuCode: product ? product.sku_code : null,
    productName: product ? product.name : null,
    productBottleVolumeMl: product ? product.bottle_volume_ml : null,
    productBottlesPerCase: product ? product.bottles_per_case : null, // packaging presentation only (P2K-8)
    locationCode: location ? location.location_code : null,
    locationName: location ? location.name : null,
  };
}

function normaliseOutput(o) {
  if (!o) return null;
  const run = o.bottling_run || null;
  return {
    id: o.id,
    bottlingRunId: o.bottling_run_id,
    bottleVolumeMl: o.bottle_volume_ml,
    bottleCount: o.bottle_count,
    bottledLitres: o.bottled_litres,
    packagingFormat: o.packaging_format,
    productName: o.product_name,
    vintage: o.vintage,
    notes: o.notes,
    createdAt: o.created_at,
    // Derived run context (read-only).
    bottlingCode: run ? run.bottling_code : null,
    bottlingDate: run ? run.bottling_date : null,
    runStatus: run ? run.status : null,
  };
}

const ITEM_SELECT =
  'id, org_id, owner_id, product_id, location_id, qty_bottles, created_at, updated_at, ' +
  'finished_product:finished_products(id, sku_code, name, bottle_volume_ml, bottles_per_case), ' +
  'stock_location:stock_locations(id, location_code, name)';

const OUTPUT_SELECT =
  'id, org_id, bottling_run_id, bottle_volume_ml, bottle_count, bottled_litres, packaging_format, product_name, vintage, notes, created_at, ' +
  'bottling_run:bottling_runs(id, bottling_code, bottling_date, status)';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's stock items (balances), newest-updated first,
 * with product + location context. Optional filters by product/location.
 * @param {{ productId?: string, locationId?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getStockItems(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('stock_items')
    .select(ITEM_SELECT)
    .eq('org_id', orgId);

  if (options.productId) query = query.eq('product_id', options.productId);
  if (options.locationId) query = query.eq('location_id', options.locationId);

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseItem), error: null };
}

/**
 * Fetch a single stock item for a (product, location) pair in the active org,
 * with context. Returns { data: null } (no error) when none exists yet.
 * @param {string} productId
 * @param {string} locationId
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getStockItem(productId, locationId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!productId || !locationId) return { data: null, error: null };

  const { data, error } = await supabase
    .from('stock_items')
    .select(ITEM_SELECT)
    .eq('org_id', orgId)
    .eq('product_id', productId)
    .eq('location_id', locationId)
    .maybeSingle();

  if (error) return { data: null, error };
  return { data: normaliseItem(data), error: null };
}

/**
 * Fetch bottling outputs that are RECEIVABLE: belong to a completed bottling run
 * in the active organisation AND have not yet been received into stock (no
 * 'receipt' stock movement references them). Includes run context for display.
 * Does two scoped reads (receipts list + outputs) and filters client-side — the
 * DB partial unique index + RPC remain the authoritative single-receipt guard.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getReceivableBottlingOutputs() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  // 1. Completed-run outputs (filter on the joined run status).
  const { data: outputs, error: outErr } = await supabase
    .from('bottling_outputs')
    .select(OUTPUT_SELECT)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (outErr) return { data: null, error: outErr };

  // 2. Already-received output ids (receipt movements in this org).
  const { data: receipts, error: recErr } = await supabase
    .from('stock_movements')
    .select('reference_id')
    .eq('org_id', orgId)
    .eq('movement_type', 'receipt')
    .eq('reference_type', 'bottling_output');
  if (recErr) return { data: null, error: recErr };

  const receivedIds = new Set((receipts || []).map((r) => r.reference_id));

  const rows = (outputs || [])
    .map(normaliseOutput)
    .filter((o) => o.runStatus === 'completed' && (o.bottleCount || 0) > 0 && !receivedIds.has(o.id));

  return { data: rows, error: null };
}

// ── Controlled receipt (RPC wrapper) ─────────────────────────────────────────

/**
 * Receive a completed bottling output into finished-goods stock via the atomic
 * SECURITY DEFINER RPC public.receive_bottling_output. Receives the FULL output
 * bottle_count once (idempotent — a second attempt is rejected by the DB partial
 * unique index and surfaced as a friendly "already received" error). Performs NO
 * client-side mutation; the RPC owns the stock_items upsert + the single receipt
 * movement in one transaction and returns the resulting stock_items row.
 * @param {{ bottlingOutputId: string, productId: string, locationId: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function receiveBottlingOutput(input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input?.bottlingOutputId) return { data: null, error: { message: 'A bottling output is required.' } };
  if (!input?.productId) return { data: null, error: { message: 'A finished product is required.' } };
  if (!input?.locationId) return { data: null, error: { message: 'A destination stock location is required.' } };

  const { data, error } = await supabase.rpc('receive_bottling_output', {
    p_bottling_output_id: input.bottlingOutputId,
    p_product_id: input.productId,
    p_location_id: input.locationId,
  });
  if (error) return { data: null, error };
  // The RPC returns the resulting public.stock_items row (single composite).
  const row = Array.isArray(data) ? data[0] : data;
  return { data: normaliseItem(row), error: null };
}

// ── Transfers (P2K-6) ────────────────────────────────────────────────────────

/**
 * Stock items for a given product that currently hold a POSITIVE balance, with
 * location context — the valid SOURCE locations for a transfer of that product.
 * Active-org scoped. Read-only.
 * @param {string} productId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getStockItemsWithStockForProduct(productId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  if (!productId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('stock_items')
    .select(ITEM_SELECT)
    .eq('org_id', orgId)
    .eq('product_id', productId)
    .gt('qty_bottles', 0)
    .order('qty_bottles', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseItem), error: null };
}

/**
 * Transfer finished goods between two active stock locations in the active
 * organisation via the atomic SECURITY DEFINER RPC
 * public.transfer_finished_stock. Receives the full requested bottle count once;
 * partial transfers are allowed. Performs NO client-side mutation — the RPC owns
 * both signed movements (one transfer_group_id) and both stock_items balance
 * updates in a single transaction, preserving
 * stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta).
 * @param {{ productId: string, fromLocationId: string, toLocationId: string, bottles: number }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function transferFinishedStock(input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input?.productId) return { data: null, error: { message: 'A finished product is required.' } };
  if (!input?.fromLocationId) return { data: null, error: { message: 'A source location is required.' } };
  if (!input?.toLocationId) return { data: null, error: { message: 'A destination location is required.' } };
  if (input.fromLocationId === input.toLocationId) {
    return { data: null, error: { message: 'The source and destination locations must be different.' } };
  }
  const bottles = Number(input.bottles);
  if (!Number.isInteger(bottles) || bottles <= 0) {
    return { data: null, error: { message: 'Transfer quantity must be a positive whole number of bottles.' } };
  }

  const { data, error } = await supabase.rpc('transfer_finished_stock', {
    p_product_id: input.productId,
    p_from_location_id: input.fromLocationId,
    p_to_location_id: input.toLocationId,
    p_bottles: bottles,
  });
  if (error) return { data: null, error };

  // The RPC returns a single row (set-returning table with one row).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };
  return {
    data: {
      fromStockItemId: row.from_stock_item_id,
      fromQtyBottles: row.from_qty_bottles,
      toStockItemId: row.to_stock_item_id,
      toQtyBottles: row.to_qty_bottles,
      transferGroupId: row.transfer_group_id,
      bottles: row.bottles,
    },
    error: null,
  };
}

// ── Adjustments & damage (P2K-7) ─────────────────────────────────────────────

/**
 * Adjust a (product, location) finished-goods balance by a SIGNED bottle count
 * via the atomic SECURITY DEFINER RPC public.adjust_finished_stock. Positive
 * increases, negative decreases; zero rejected; reason mandatory. Performs NO
 * client-side mutation — the RPC owns the stock_items balance update + the
 * single 'adjustment' movement in one transaction (never negative stock).
 * OWNER/ADMIN only (enforced by the RPC). Returns the resulting stock item.
 * @param {{ productId: string, locationId: string, qtyBottles: number, reason: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function adjustFinishedStock(input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input?.productId) return { data: null, error: { message: 'A finished product is required.' } };
  if (!input?.locationId) return { data: null, error: { message: 'A stock location is required.' } };
  const qty = Number(input.qtyBottles);
  if (!Number.isInteger(qty) || qty === 0) {
    return { data: null, error: { message: 'Adjustment quantity must be a non-zero whole number of bottles.' } };
  }
  const reason = (input.reason || '').trim();
  if (!reason) return { data: null, error: { message: 'A reason is required for a stock adjustment.' } };

  const { data, error } = await supabase.rpc('adjust_finished_stock', {
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_qty_bottles: qty,
    p_reason: reason,
    p_notes: input.notes ? input.notes.trim() : null,
  });
  if (error) return { data: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: normaliseItem(row), error: null };
}

/**
 * Record damage against a (product, location) finished-goods balance via the
 * atomic SECURITY DEFINER RPC public.record_finished_stock_damage. Quantity must
 * be positive; always decreases; reason mandatory; never negative stock.
 * Performs NO client-side mutation — the RPC owns the balance update + the single
 * 'damage' movement (-qty) in one transaction. OWNER/ADMIN only (RPC-enforced).
 * Returns the resulting stock item.
 * @param {{ productId: string, locationId: string, qtyBottles: number, reason: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function recordFinishedStockDamage(input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input?.productId) return { data: null, error: { message: 'A finished product is required.' } };
  if (!input?.locationId) return { data: null, error: { message: 'A stock location is required.' } };
  const qty = Number(input.qtyBottles);
  if (!Number.isInteger(qty) || qty <= 0) {
    return { data: null, error: { message: 'Damage quantity must be a positive whole number of bottles.' } };
  }
  const reason = (input.reason || '').trim();
  if (!reason) return { data: null, error: { message: 'A reason is required to record damage.' } };

  const { data, error } = await supabase.rpc('record_finished_stock_damage', {
    p_product_id: input.productId,
    p_location_id: input.locationId,
    p_qty_bottles: qty,
    p_reason: reason,
    p_notes: input.notes ? input.notes.trim() : null,
  });
  if (error) return { data: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: normaliseItem(row), error: null };
}
