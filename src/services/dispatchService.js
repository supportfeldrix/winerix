import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Dispatch Service (P2M-3, read-only UI consumer)
//
// Reads the physical-dispatch records produced by the P2M-2 backend:
//   dispatches        — one physical dispatch event against a single sales order
//   dispatch_lines    — one row per (dispatch, allocation) fulfilment of bottles
//
// This service is READ-ONLY. It performs NO INSERT / UPDATE / DELETE. The only
// way dispatch data is ever created is the SECURITY DEFINER RPC record_dispatch
// (P2M-2) — this service never calls it and never writes any table. Physical
// stock stays authoritative in stock_items; dispatch quantities come straight
// from dispatch_lines.qty_bottles (never recomputed here).
//
// Conventions match the other Winerix services: returns { data, error },
// camelCase normalisation, friendly error mapping, and active-organisation
// scoping on every read (never trusts a client-provided org_id — the org is
// taken from getActiveOrgId() and RLS remains the authoritative boundary).
//
// Schema: supabase/migrations/051_dispatch_core.sql
//         supabase/migrations/052_fix_record_dispatch_location_id_ambiguity.sql
// ─────────────────────────────────────────────────────────────────────────────

export const DISPATCH_STATUSES = Object.freeze([
  { value: 'recorded', label: 'Recorded' },
  // 'voided' is a forward-compat value in the schema; no void flow exists yet,
  // but it is listed so an existing voided row (if ever created) displays a label.
  { value: 'voided', label: 'Voided' },
]);

export function dispatchStatusLabel(status) {
  const found = DISPATCH_STATUSES.find((s) => s.value === status);
  return found ? found.label : (status || '—');
}

export function dispatchStatusColor(status) {
  switch (status) {
    case 'recorded': return 'success';
    case 'voided': return 'default';
    default: return 'default';
  }
}

export function friendlyDispatchError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The dispatch database is not set up yet. Please run the latest migration.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to view dispatches for this organisation.';
  }
  if (msg.includes('not authenticated')) return 'Your session has expired. Please sign in again.';
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function customerName(customer) {
  if (!customer) return null;
  return customer.trading_name || customer.legal_name || null;
}

function normaliseDispatch(d) {
  if (!d) return null;
  const order = d.sales_order || null;
  const customer = order ? order.customer || null : null;
  const lines = Array.isArray(d.dispatch_lines) ? d.dispatch_lines : [];
  const totalBottles = lines.reduce((sum, l) => sum + (Number(l.qty_bottles) || 0), 0);
  return {
    id: d.id,
    dispatchNumber: d.dispatch_number,
    status: d.status,
    dispatchedAt: d.dispatched_at,
    salesOrderId: d.sales_order_id,
    addressSnapshot: d.address_snapshot || null,
    notes: d.notes || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    // Derived order / customer context (read-only).
    orderNumber: order ? order.order_number : null,
    orderStatus: order ? order.status : null,
    customerId: order ? order.customer_id : null,
    customerLegalName: customer ? customer.legal_name : null,
    customerTradingName: customer ? customer.trading_name : null,
    customerName: customerName(customer),
    // Line count / total bottles when the lines are embedded in the query.
    lineCount: lines.length,
    totalBottles,
  };
}

function normaliseDispatchLine(l) {
  if (!l) return null;
  const product = l.finished_product || null;
  const location = l.stock_location || null;
  const allocation = l.stock_allocation || null;
  const movement = l.stock_movement || null;
  const orderLine = l.sales_order_line || null;
  return {
    id: l.id,
    dispatchId: l.dispatch_id,
    salesOrderId: l.sales_order_id,
    salesOrderLineId: l.sales_order_line_id,
    stockAllocationId: l.stock_allocation_id,
    finishedProductId: l.finished_product_id,
    locationId: l.location_id,
    qtyBottles: l.qty_bottles,
    stockMovementId: l.stock_movement_id,
    createdAt: l.created_at,
    // Product (finished_products stays authoritative — read, never duplicated).
    productName: product ? product.name : null,
    productSku: product ? product.sku_code : null,
    productBottleVolumeMl: product ? product.bottle_volume_ml : null,
    // Location.
    locationCode: location ? location.location_code : null,
    locationName: location ? location.name : null,
    // Allocation (the authoritative fulfilment relationship).
    allocationStatus: allocation ? allocation.status : null,
    allocationQtyBottles: allocation ? allocation.qty_bottles : null,
    allocationFulfilledQty: allocation ? allocation.fulfilled_qty : null,
    // Stock movement reference (physical inventory history).
    movementType: movement ? movement.movement_type : null,
    movementQtyDelta: movement ? movement.qty_bottles_delta : null,
    movementOccurredAt: movement ? movement.occurred_at : null,
    // Sales order line.
    salesOrderLineNumber: orderLine ? orderLine.line_number : null,
  };
}

// ── SELECTs ──────────────────────────────────────────────────────────────────

// Header list/detail — embeds the order + customer for display and the lines'
// quantities so a total can be derived without a second request.
const DISPATCH_SELECT =
  'id, org_id, sales_order_id, dispatch_number, dispatched_at, status, address_snapshot, notes, ' +
  'created_at, updated_at, ' +
  'sales_order:sales_orders(id, order_number, status, customer_id, ' +
  'customer:customers(id, legal_name, trading_name)), ' +
  'dispatch_lines(qty_bottles)';

// Full line detail with every traceability relationship.
const DISPATCH_LINE_SELECT =
  'id, org_id, dispatch_id, sales_order_id, sales_order_line_id, stock_allocation_id, ' +
  'finished_product_id, location_id, qty_bottles, stock_movement_id, created_at, ' +
  'finished_product:finished_products(id, sku_code, name, bottle_volume_ml), ' +
  'stock_location:stock_locations(id, location_code, name), ' +
  'stock_allocation:stock_allocations(id, status, qty_bottles, fulfilled_qty), ' +
  'stock_movement:stock_movements(id, movement_type, qty_bottles_delta, occurred_at), ' +
  'sales_order_line:sales_order_lines(id, line_number)';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's dispatches, newest first. Optional filters:
 * status, salesOrderId, customerId, a date range (fromDate/toDate on
 * dispatched_at), and a client-side search over dispatch #, order # or customer.
 * Each row carries a derived total bottle count from its embedded lines.
 * @param {{ status?: string, salesOrderId?: string, customerId?: string,
 *   fromDate?: string, toDate?: string, search?: string }} [options]
 */
export async function getDispatches(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('dispatches')
    .select(DISPATCH_SELECT)
    .eq('org_id', orgId);

  if (options.status) query = query.eq('status', options.status);
  if (options.salesOrderId) query = query.eq('sales_order_id', options.salesOrderId);
  if (options.fromDate) query = query.gte('dispatched_at', options.fromDate);
  if (options.toDate) query = query.lte('dispatched_at', options.toDate);

  query = query.order('dispatched_at', { ascending: false }).order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return { data: null, error };

  let rows = (data || []).map(normaliseDispatch);

  // Customer filter is applied after normalisation (customer is a nested join).
  if (options.customerId) {
    rows = rows.filter((d) => d.customerId === options.customerId);
  }

  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((d) =>
      (d.dispatchNumber || '').toLowerCase().includes(q) ||
      (d.orderNumber || '').toLowerCase().includes(q) ||
      (d.customerLegalName || '').toLowerCase().includes(q) ||
      (d.customerTradingName || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single dispatch header by id (active-org scoped), with order + customer
 * context and a derived total bottle count.
 */
export async function getDispatch(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!id) return { data: null, error: { message: 'A dispatch is required.' } };

  const { data, error } = await supabase
    .from('dispatches').select(DISPATCH_SELECT)
    .eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normaliseDispatch(data), error: null };
}

/**
 * Fetch all dispatch lines for a dispatch (active-org scoped), with full
 * traceability joins (product, location, allocation, stock movement, order line).
 * @param {string} dispatchId
 */
export async function getDispatchLines(dispatchId) {
  const orgId = getActiveOrgId();
  if (!orgId || !dispatchId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('dispatch_lines').select(DISPATCH_LINE_SELECT)
    .eq('org_id', orgId).eq('dispatch_id', dispatchId)
    .order('created_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseDispatchLine), error: null };
}
