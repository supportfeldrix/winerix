import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Allocation Service (P2L-6)
//
// Soft reservation of finished-goods stock against CONFIRMED sales orders. The
// reservation lives in an APPEND-ONLY ledger (stock_allocations) and NEVER
// reduces physical stock. Physical stock stays authoritative in
// stock_items.qty_bottles.
//
//   physical  = stock_items.qty_bottles
//   reserved  = SUM(open stock_allocations) for the same product + location
//   available = physical - reserved      (never < 0; enforced server-side)
//
// All writes go through SECURITY DEFINER RPCs — this service NEVER inserts /
// updates / deletes the ledger directly:
//   allocate_stock_for_sales_order_line(line, location, qty, notes)
//   release_stock_allocation(allocation, reason)
// Both require an OWNER/ADMIN/SALES role (enforced in the DB). Reads are
// org-scoped on top of org-based RLS. Availability is always computed from the
// database (physical from stock_items + open reservations from this ledger).
// Schema: supabase/migrations/048_stock_allocations.sql
//         supabase/migrations/049_fix_stock_allocation_rpc.sql (allocate RPC
//         output columns renamed out_* to fix an ambiguous-column error)
// ─────────────────────────────────────────────────────────────────────────────

export function friendlyStockAllocationError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  // Surface the raw Supabase/Postgres error in development so an unexpected
  // database failure (e.g. a function definition problem) is diagnosable in the
  // browser console. Never shown in the production UI — it may contain internals.
  if (import.meta?.env?.DEV) {
    // eslint-disable-next-line no-console
    console.error('[stockAllocation] RPC error:', {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
  }
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The stock allocation database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('insufficient available stock')) {
    return 'There is not enough available stock at that location to allocate this quantity.';
  }
  if (msg.includes('remaining order-line quantity') || msg.includes('exceeds the remaining')) {
    return 'That quantity is more than the order line still needs allocated.';
  }
  if (msg.includes('no stock of this product at the selected location')) {
    return 'There is no stock of this product at the selected location.';
  }
  if (msg.includes('inactive') && msg.includes('location')) {
    return 'The selected stock location is inactive and cannot be used.';
  }
  if (msg.includes('only a confirmed') || msg.includes('can only be allocated to a confirmed')) {
    return 'Stock can only be allocated to a confirmed sales order.';
  }
  if (msg.includes('only an open allocation can be released')) {
    return 'That allocation is no longer open and cannot be released.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected location, product or order belongs to a different organisation.';
  }
  if (msg.includes('positive number of bottles') || code === '23514') {
    return 'The allocation quantity must be a whole number greater than zero.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'A referenced order line, product or location could not be found.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('owner, admin or sales')) {
    return 'You do not have permission to allocate stock. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('not authenticated')) return 'Your session has expired. Please sign in again.';
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  // Unexpected server/database error (e.g. a function definition fault). Point at
  // the console/logs rather than silently swallowing it.
  if (code === '42702' || code === '42703' || code === '42804' || code === '42P13' || code === '42883') {
    return 'The allocation could not be processed due to a server error. Please contact support (an administrator can check the server logs for details).';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw stock_allocations row into camelCase.
function normalise(a) {
  if (!a) return null;
  return {
    id: a.id,
    salesOrderId: a.sales_order_id,
    salesOrderLineId: a.sales_order_line_id,
    finishedProductId: a.finished_product_id,
    locationId: a.location_id,
    qtyBottles: a.qty_bottles,
    status: a.status,
    allocatedAt: a.allocated_at,
    releasedAt: a.released_at,
    fulfilledAt: a.fulfilled_at,
    notes: a.notes,
    ownerId: a.owner_id,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    // Optional joined labels (present when the SELECT includes the joins).
    locationCode: a.stock_location ? a.stock_location.location_code : undefined,
    locationName: a.stock_location ? a.stock_location.name : undefined,
    skuCodeSnapshot: a.sales_order_line ? a.sales_order_line.sku_code_snapshot : undefined,
    productNameSnapshot: a.sales_order_line ? a.sales_order_line.product_name_snapshot : undefined,
  };
}

const SELECT =
  'id, sales_order_id, sales_order_line_id, finished_product_id, location_id, qty_bottles, ' +
  'status, allocated_at, released_at, fulfilled_at, notes, owner_id, created_at, updated_at, ' +
  'stock_location:stock_locations(id, location_code, name), ' +
  'sales_order_line:sales_order_lines(id, sku_code_snapshot, product_name_snapshot)';

function intOrNull(v) {
  return v === undefined || v === null || v === '' ? null : Number(v);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * All allocations for a sales order (any status), newest first within line.
 * @param {string} orderId
 */
export async function getAllocationsBySalesOrder(orderId) {
  const orgId = getActiveOrgId();
  if (!orgId || !orderId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('stock_allocations').select(SELECT)
    .eq('org_id', orgId).eq('sales_order_id', orderId)
    .order('sales_order_line_id', { ascending: true })
    .order('allocated_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * All allocations for a single order line (any status).
 * @param {string} lineId
 */
export async function getAllocationsBySalesOrderLine(lineId) {
  const orgId = getActiveOrgId();
  if (!orgId || !lineId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('stock_allocations').select(SELECT)
    .eq('org_id', orgId).eq('sales_order_line_id', lineId)
    .order('allocated_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * All allocations for a finished product (any status). Optional status filter.
 * @param {string} productId
 * @param {{ status?: string }} [options]
 */
export async function getAllocationsByProduct(productId, options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId || !productId) return { data: [], error: null };
  let query = supabase
    .from('stock_allocations').select(SELECT)
    .eq('org_id', orgId).eq('finished_product_id', productId);
  if (options.status) query = query.eq('status', options.status);
  const { data, error } = await query.order('allocated_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Open allocations for the active organisation. Optionally scoped to a product
 * and/or location — useful for availability roll-ups.
 * @param {{ productId?: string, locationId?: string }} [options]
 */
export async function getOpenAllocations(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  let query = supabase
    .from('stock_allocations').select(SELECT)
    .eq('org_id', orgId).eq('status', 'open');
  if (options.productId) query = query.eq('finished_product_id', options.productId);
  if (options.locationId) query = query.eq('location_id', options.locationId);
  const { data, error } = await query.order('allocated_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Available stock for a product at a single location, computed from the DATABASE:
 *   physical  = stock_items.qty_bottles  (0 if there is no stock row)
 *   reserved  = SUM(open stock_allocations) for the same product + location
 *   available = physical - reserved      (clamped at 0 for display)
 * @param {string} productId
 * @param {string} locationId
 * @returns {Promise<{ data: { physical, reserved, available }|null, error }>}
 */
export async function getAvailableStockForProductLocation(productId, locationId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!productId || !locationId) return { data: null, error: { message: 'A product and location are required.' } };

  const [itemRes, allocRes] = await Promise.all([
    supabase
      .from('stock_items').select('qty_bottles')
      .eq('org_id', orgId).eq('product_id', productId).eq('location_id', locationId)
      .maybeSingle(),
    supabase
      .from('stock_allocations').select('qty_bottles')
      .eq('org_id', orgId).eq('finished_product_id', productId).eq('location_id', locationId)
      .eq('status', 'open'),
  ]);
  if (itemRes.error) return { data: null, error: itemRes.error };
  if (allocRes.error) return { data: null, error: allocRes.error };

  const physical = itemRes.data ? Number(itemRes.data.qty_bottles) || 0 : 0;
  const reserved = (allocRes.data || []).reduce((sum, r) => sum + (Number(r.qty_bottles) || 0), 0);
  const available = Math.max(0, physical - reserved);
  return { data: { physical, reserved, available }, error: null };
}

// ── Writes (RPC-only; server-authoritative) ──────────────────────────────────

/**
 * Reserve stock for an order line at a location via the atomic SECURITY DEFINER
 * RPC. The server locks the stock_items row, recomputes availability under the
 * lock, enforces order-line remaining + per-location availability, inserts the
 * allocation, and recomputes the order status. Never reduces physical stock.
 * @param {string} lineId      sales_order_line id
 * @param {string} locationId  stock_locations id
 * @param {number} qtyBottles  positive whole bottles
 * @param {string|null} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>} availability summary
 */
export async function allocateStockForSalesOrderLine(lineId, locationId, qtyBottles, notes = null) {
  if (!lineId) return { data: null, error: { message: 'An order line is required.' } };
  if (!locationId) return { data: null, error: { message: 'A stock location is required.' } };
  const qty = intOrNull(qtyBottles);
  if (qty === null || !Number.isInteger(qty) || qty <= 0) {
    return { data: null, error: { message: 'Allocation quantity must be a whole number greater than zero.' } };
  }
  const trimmedNotes = typeof notes === 'string' && notes.trim() !== '' ? notes.trim() : null;

  const { data, error } = await supabase.rpc('allocate_stock_for_sales_order_line', {
    p_sales_order_line_id: lineId,
    p_location_id: locationId,
    p_qty_bottles: qty,
    p_notes: trimmedNotes,
  });
  if (error) return { data: null, error };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };
  // The RPC returns out_* column names (migration 049 renamed them to avoid a
  // RETURNS TABLE / column-name collision). Fall back to the un-prefixed names
  // for resilience if an older function version is still live.
  const pick = (a, b) => (row[a] !== undefined ? row[a] : row[b]);
  return {
    data: {
      allocationId: pick('out_allocation_id', 'allocation_id'),
      salesOrderId: pick('out_sales_order_id', 'sales_order_id'),
      salesOrderLineId: pick('out_sales_order_line_id', 'sales_order_line_id'),
      finishedProductId: pick('out_finished_product_id', 'finished_product_id'),
      locationId: pick('out_location_id', 'location_id'),
      qtyBottles: pick('out_qty_bottles', 'qty_bottles'),
      orderStatus: pick('out_order_status', 'order_status'),
      lineOrdered: pick('out_line_ordered', 'line_ordered'),
      lineAllocatedOpen: pick('out_line_allocated_open', 'line_allocated_open'),
      lineRemaining: pick('out_line_remaining', 'line_remaining'),
      locationPhysical: pick('out_location_physical', 'location_physical'),
      locationReserved: pick('out_location_reserved', 'location_reserved'),
      locationAvailable: pick('out_location_available', 'location_available'),
    },
    error: null,
  };
}

/**
 * Release an OPEN allocation via the SECURITY DEFINER RPC. Returns the reserved
 * bottles to AVAILABLE (the row becomes 'released'), never deletes, and
 * recomputes the order status. Does NOT change physical stock.
 * @param {string} allocationId
 * @param {string|null} [reason]
 * @returns {Promise<{ data: object|null, error: object|null }>} the released allocation
 */
export async function releaseStockAllocation(allocationId, reason = null) {
  if (!allocationId) return { data: null, error: { message: 'An allocation is required.' } };
  const trimmedReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null;
  const { data, error } = await supabase.rpc('release_stock_allocation', {
    p_allocation_id: allocationId,
    p_reason: trimmedReason,
  });
  if (error) return { data: null, error };
  return { data: normalise(Array.isArray(data) ? data[0] : data), error: null };
}
