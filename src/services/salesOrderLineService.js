import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Order Line Service (P2L-5)
// Order lines carry commercial SNAPSHOTS (sku/name/bottle volume/unit price/tax
// rate) + an FK to finished_products for traceability. Line money (tax_amount,
// line_total) is SERVER-AUTHORITATIVE — computed by a DB trigger; the client
// sends inputs only. After any line change the service calls
// recalculate_sales_order_totals so the order header reflects the lines.
//
// Lines may be added/edited/deleted ONLY while the parent order is 'draft' (the
// service checks, and RLS + the DB policies are the final authority). Reads/
// writes are org-scoped; owner_id = auth.uid() on create; org_id/owner_id/
// sales_order_id are never changed on update.
//
// Confirmation is confirm_sales_order (atomic RPC): validates draft + >=1 line,
// recalculates totals, snapshots addresses, flips to 'confirmed'. NO stock is
// touched (allocation is P2L-6).
// Schema: supabase/migrations/047_sales_order_lines_pricing_confirmation.sql
// ─────────────────────────────────────────────────────────────────────────────

export function friendlySalesOrderLineError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The sales orders database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'That line number already exists on this order. Please try again.';
  }
  if (msg.includes('discount exceeds') || msg.includes('discount_within_gross') || msg.includes('sol_discount')) {
    return 'The discount cannot be more than the line gross (quantity × unit price).';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('quantity')) return 'Quantity must be a whole number greater than zero.';
    if (msg.includes('unit_price')) return 'Unit price cannot be negative.';
    if (msg.includes('tax_rate')) return 'Tax rate cannot be negative.';
    return 'Please provide valid line values.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected product or order belongs to a different organisation.';
  }
  if (msg.includes('only a draft') || msg.includes('draft')) {
    return 'Only draft sales orders can have their lines changed.';
  }
  if (msg.includes('at least one line')) {
    return 'Add at least one order line before confirming.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'A referenced product or order could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('owner, admin or sales')) {
    return 'You do not have permission to manage sales orders. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function normalise(l) {
  if (!l) return null;
  return {
    id: l.id,
    salesOrderId: l.sales_order_id,
    finishedProductId: l.finished_product_id,
    lineNumber: l.line_number,
    skuCodeSnapshot: l.sku_code_snapshot,
    productNameSnapshot: l.product_name_snapshot,
    bottleVolumeMlSnapshot: l.bottle_volume_ml_snapshot,
    quantityBottles: l.quantity_bottles,
    unitPrice: l.unit_price,
    lineDiscount: l.line_discount,
    taxRate: l.tax_rate,
    taxAmount: l.tax_amount,
    lineTotal: l.line_total,
    notes: l.notes,
    ownerId: l.owner_id,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
  };
}

const SELECT =
  'id, sales_order_id, finished_product_id, line_number, sku_code_snapshot, product_name_snapshot, ' +
  'bottle_volume_ml_snapshot, quantity_bottles, unit_price, line_discount, tax_rate, tax_amount, ' +
  'line_total, notes, owner_id, created_at, updated_at';

function intOrNull(v) {
  return v === undefined || v === null || v === '' ? null : Number(v);
}
function numOrNull(v) {
  return v === undefined || v === null || v === '' ? null : Number(v);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getSalesOrderLines(orderId) {
  const orgId = getActiveOrgId();
  if (!orgId || !orderId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('sales_order_lines').select(SELECT)
    .eq('org_id', orgId).eq('sales_order_id', orderId)
    .order('line_number', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getSalesOrderLine(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('sales_order_lines').select(SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// ── Internal: order must exist, be same-org, and be draft ───────────────────

async function assertDraftOrder(orgId, orderId) {
  const { data, error } = await supabase
    .from('sales_orders').select('id, status').eq('id', orderId).eq('org_id', orgId).single();
  if (error) return { ok: false, error };
  if (!data) return { ok: false, error: { message: 'Sales order not found.' } };
  if (data.status !== 'draft') return { ok: false, error: { message: 'Only draft sales orders can have lines changed.' } };
  return { ok: true, error: null };
}

// ── Internal: snapshot product fields ───────────────────────────────────────

async function loadProductSnapshot(orgId, productId) {
  const { data, error } = await supabase
    .from('finished_products')
    .select('id, sku_code, name, bottle_volume_ml')
    .eq('id', productId).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { message: 'Finished product not found.' } };
  return { data, error: null };
}

// ── Internal: next line number for an order ─────────────────────────────────

async function nextLineNumber(orgId, orderId) {
  const { data, error } = await supabase
    .from('sales_order_lines').select('line_number')
    .eq('org_id', orgId).eq('sales_order_id', orderId)
    .order('line_number', { ascending: false }).limit(1);
  if (error) return { value: null, error };
  const max = (data && data[0]) ? Number(data[0].line_number) : 0;
  return { value: max + 1, error: null };
}

// ── Writes (draft only) ──────────────────────────────────────────────────────

/**
 * Add a line to a DRAFT order. Snapshots sku/name/bottle volume from the chosen
 * product; the DB trigger computes tax_amount + line_total. Recalculates the
 * order totals afterwards. owner_id = auth.uid(); org from active org.
 * @param {string} orderId
 * @param {{ finishedProductId: string, quantityBottles: number, unitPrice: number,
 *   lineDiscount?: number, taxRate?: number, notes?: string|null }} input
 */
export async function addSalesOrderLine(orderId, input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!orderId) return { data: null, error: { message: 'A sales order is required.' } };

  const draft = await assertDraftOrder(orgId, orderId);
  if (!draft.ok) return { data: null, error: draft.error };

  if (!input.finishedProductId) return { data: null, error: { message: 'A product is required.' } };
  const quantity = intOrNull(input.quantityBottles);
  if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) {
    return { data: null, error: { message: 'Quantity must be a whole number greater than zero.' } };
  }
  const unitPrice = numOrNull(input.unitPrice);
  if (unitPrice === null || !Number.isFinite(unitPrice) || unitPrice < 0) {
    return { data: null, error: { message: 'Unit price must be a non-negative number.' } };
  }
  const lineDiscount = input.lineDiscount === undefined || input.lineDiscount === null || input.lineDiscount === '' ? 0 : Number(input.lineDiscount);
  if (!Number.isFinite(lineDiscount) || lineDiscount < 0) return { data: null, error: { message: 'Discount must be a non-negative number.' } };
  const taxRate = input.taxRate === undefined || input.taxRate === null || input.taxRate === '' ? 0 : Number(input.taxRate);
  if (!Number.isFinite(taxRate) || taxRate < 0) return { data: null, error: { message: 'Tax rate must be a non-negative number.' } };
  if (lineDiscount > quantity * unitPrice) {
    return { data: null, error: { message: 'The discount cannot be more than the line gross (quantity × unit price).' } };
  }

  const snapRes = await loadProductSnapshot(orgId, input.finishedProductId);
  if (snapRes.error) return { data: null, error: snapRes.error };
  const product = snapRes.data;

  const lineNoRes = await nextLineNumber(orgId, orderId);
  if (lineNoRes.error) return { data: null, error: lineNoRes.error };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    sales_order_id: orderId,
    finished_product_id: input.finishedProductId,
    line_number: lineNoRes.value,
    sku_code_snapshot: product.sku_code,
    product_name_snapshot: product.name,
    bottle_volume_ml_snapshot: product.bottle_volume_ml,
    quantity_bottles: quantity,
    unit_price: unitPrice,
    line_discount: lineDiscount,
    tax_rate: taxRate,
    notes: input.notes ? input.notes.trim() : null,
    // tax_amount / line_total computed by the DB trigger.
  };

  const { data, error } = await supabase.from('sales_order_lines').insert(row).select(SELECT).single();
  if (error) return { data: null, error };

  await recalculateSalesOrderTotals(orderId);
  return { data: normalise(data), error: null };
}

/**
 * Update a DRAFT order line's commercial fields. If the product is changed, its
 * snapshots are refreshed. The DB trigger recomputes tax/total; the order totals
 * are recalculated afterwards. org_id/owner_id/sales_order_id/line_number are
 * never changed here.
 * @param {string} id
 * @param {{ finishedProductId?: string, quantityBottles?: number, unitPrice?: number,
 *   lineDiscount?: number, taxRate?: number, notes?: string|null }} input
 */
export async function updateSalesOrderLine(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Load the current line (for order id + merged validation).
  const { data: current, error: curErr } = await supabase
    .from('sales_order_lines')
    .select('id, sales_order_id, finished_product_id, quantity_bottles, unit_price, line_discount, tax_rate')
    .eq('id', id).eq('org_id', orgId).single();
  if (curErr) return { data: null, error: curErr };
  if (!current) return { data: null, error: { message: 'Order line not found.' } };

  const draft = await assertDraftOrder(orgId, current.sales_order_id);
  if (!draft.ok) return { data: null, error: draft.error };

  const row = {};

  if (input.finishedProductId !== undefined && input.finishedProductId !== current.finished_product_id) {
    if (!input.finishedProductId) return { data: null, error: { message: 'A product is required.' } };
    const snapRes = await loadProductSnapshot(orgId, input.finishedProductId);
    if (snapRes.error) return { data: null, error: snapRes.error };
    row.finished_product_id = input.finishedProductId;
    row.sku_code_snapshot = snapRes.data.sku_code;
    row.product_name_snapshot = snapRes.data.name;
    row.bottle_volume_ml_snapshot = snapRes.data.bottle_volume_ml;
  }

  if (input.quantityBottles !== undefined) {
    const quantity = intOrNull(input.quantityBottles);
    if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) return { data: null, error: { message: 'Quantity must be a whole number greater than zero.' } };
    row.quantity_bottles = quantity;
  }
  if (input.unitPrice !== undefined) {
    const unitPrice = numOrNull(input.unitPrice);
    if (unitPrice === null || !Number.isFinite(unitPrice) || unitPrice < 0) return { data: null, error: { message: 'Unit price must be a non-negative number.' } };
    row.unit_price = unitPrice;
  }
  if (input.lineDiscount !== undefined) {
    const lineDiscount = input.lineDiscount === null || input.lineDiscount === '' ? 0 : Number(input.lineDiscount);
    if (!Number.isFinite(lineDiscount) || lineDiscount < 0) return { data: null, error: { message: 'Discount must be a non-negative number.' } };
    row.line_discount = lineDiscount;
  }
  if (input.taxRate !== undefined) {
    const taxRate = input.taxRate === null || input.taxRate === '' ? 0 : Number(input.taxRate);
    if (!Number.isFinite(taxRate) || taxRate < 0) return { data: null, error: { message: 'Tax rate must be a non-negative number.' } };
    row.tax_rate = taxRate;
  }
  if (input.notes !== undefined) row.notes = input.notes ? input.notes.trim() : null;

  // Merged discount-vs-gross guard (DB CHECK is authoritative).
  const q = row.quantity_bottles ?? Number(current.quantity_bottles);
  const p = row.unit_price ?? Number(current.unit_price);
  const d = row.line_discount ?? Number(current.line_discount);
  if (Number.isFinite(q) && Number.isFinite(p) && Number.isFinite(d) && d > q * p) {
    return { data: null, error: { message: 'The discount cannot be more than the line gross (quantity × unit price).' } };
  }

  const { data, error } = await supabase
    .from('sales_order_lines').update(row).eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };

  await recalculateSalesOrderTotals(current.sales_order_id);
  return { data: normalise(data), error: null };
}

/**
 * Delete a DRAFT order line, then recalculate the order totals. The DB DELETE
 * policy also gates this to draft parent orders.
 * @param {string} id
 */
export async function deleteSalesOrderLine(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data: current, error: curErr } = await supabase
    .from('sales_order_lines').select('id, sales_order_id').eq('id', id).eq('org_id', orgId).single();
  if (curErr) return { data: null, error: curErr };
  if (!current) return { data: null, error: { message: 'Order line not found.' } };

  const draft = await assertDraftOrder(orgId, current.sales_order_id);
  if (!draft.ok) return { data: null, error: draft.error };

  const { error } = await supabase.from('sales_order_lines').delete().eq('id', id).eq('org_id', orgId);
  if (error) return { data: null, error };

  await recalculateSalesOrderTotals(current.sales_order_id);
  return { data: { id }, error: null };
}

// ── Totals + confirmation (RPC wrappers) ─────────────────────────────────────

/**
 * Recalculate an order's totals from its lines via the SECURITY DEFINER RPC.
 * Returns the recalculated order (normalisation left to the caller/salesOrderService).
 */
export async function recalculateSalesOrderTotals(orderId) {
  if (!orderId) return { data: null, error: { message: 'A sales order is required.' } };
  const { data, error } = await supabase.rpc('recalculate_sales_order_totals', { p_sales_order_id: orderId });
  if (error) return { data: null, error };
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/**
 * Confirm a DRAFT order via the atomic SECURITY DEFINER RPC (validates draft +
 * >=1 line, recalculates totals, snapshots addresses, status -> confirmed).
 * Does NOT touch stock.
 */
export async function confirmSalesOrder(orderId) {
  if (!orderId) return { data: null, error: { message: 'A sales order is required.' } };
  const { data, error } = await supabase.rpc('confirm_sales_order', { p_sales_order_id: orderId });
  if (error) return { data: null, error };
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}
