import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Return Service (P2M-6, returned finished goods)
//
// Reads the returns ledger (a physical-receipt + attestation layer AFTER
// delivery) and performs ALL writes through SECURITY DEFINER RPCs. This service
// NEVER writes stock/allocation/dispatch/delivery/order tables and NEVER
// inserts/updates the return tables directly — every mutation goes through a
// controlled RPC:
//   create_return(delivery, quarantine_location, lines, reason_summary)
//   receive_return(return)                       -> +quarantine (return_in)
//   inspect_return_line(line, condition_code, notes)
//   restock_return_line(line, restock_location)  -> transfer_out + transfer_in
//   writeoff_return_line(line, reason)           -> return_writeoff
//   close_return(return)
//   cancel_return(return, reason)                [OWNER/ADMIN only, pending only]
//   next_return_number(org)
//
// Returns are additive: they never mutate delivered_qty, dispatch lines,
// allocation fulfilled_qty, or sales-order status. Returned goods first enter a
// QUARANTINE location, then are separately restocked or written off (whole-line
// disposition only). Reads are active-organisation scoped on top of org RLS.
// Schema: supabase/migrations/056_returns.sql
// ─────────────────────────────────────────────────────────────────────────────

export const RETURN_STATUSES = Object.freeze([
  { value: 'pending', label: 'Pending' },
  { value: 'received', label: 'Received' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
]);

export const RETURN_DISPOSITIONS = Object.freeze([
  { value: 'awaiting_inspection', label: 'Awaiting inspection' },
  { value: 'restocked', label: 'Restocked' },
  { value: 'written_off', label: 'Written off' },
]);

// Exactly the seven reason codes from 056_returns.sql (rline_reason_code_check).
export const RETURN_REASON_CODES = Object.freeze([
  { value: 'CUSTOMER_CANCELLED', label: 'Customer cancelled' },
  { value: 'ORDER_ERROR', label: 'Order error' },
  { value: 'DAMAGED_IN_TRANSIT', label: 'Damaged in transit' },
  { value: 'QUALITY_COMPLAINT', label: 'Quality complaint' },
  { value: 'LABELLING_ERROR', label: 'Labelling error' },
  { value: 'EXPIRED_OR_AGED', label: 'Expired or aged' },
  { value: 'OTHER', label: 'Other' },
]);

// Exactly the six condition codes from 056_returns.sql (rline_condition_code_check).
export const RETURN_CONDITION_CODES = Object.freeze([
  { value: 'SELLABLE', label: 'Sellable' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'LABEL_DAMAGED', label: 'Label damaged' },
  { value: 'OPENED', label: 'Opened' },
  { value: 'SUSPECT_QUALITY', label: 'Suspect quality' },
  { value: 'UNKNOWN', label: 'Unknown' },
]);

export function returnStatusLabel(status) {
  const found = RETURN_STATUSES.find((s) => s.value === status);
  return found ? found.label : (status || '—');
}

export function returnStatusColor(status) {
  switch (status) {
    case 'pending': return 'warning';
    case 'received': return 'info';
    case 'closed': return 'success';
    case 'cancelled': return 'default';
    default: return 'default';
  }
}

export function dispositionLabel(d) {
  const found = RETURN_DISPOSITIONS.find((x) => x.value === d);
  return found ? found.label : (d || '—');
}

export function dispositionColor(d) {
  switch (d) {
    case 'awaiting_inspection': return 'warning';
    case 'restocked': return 'success';
    case 'written_off': return 'error';
    default: return 'default';
  }
}

export function reasonCodeLabel(v) {
  const found = RETURN_REASON_CODES.find((r) => r.value === v);
  return found ? found.label : (v || '—');
}
export function conditionCodeLabel(v) {
  const found = RETURN_CONDITION_CODES.find((r) => r.value === v);
  return found ? found.label : (v || '—');
}

// Role helpers (UX gating only; the RPC role guards remain authoritative).
export function canCreateReturn(role) {
  return ['OWNER', 'ADMIN', 'SALES', 'CELLAR'].includes(role);
}
export function canPhysicalReturn(role) {
  return ['OWNER', 'ADMIN', 'CELLAR'].includes(role);
}
export function canCancelReturn(role) {
  return ['OWNER', 'ADMIN'].includes(role);
}

export function friendlyReturnError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  if (import.meta?.env?.DEV) {
    // eslint-disable-next-line no-console
    console.error('[return] error:', { code: error.code, message: error.message, details: error.details, hint: error.hint });
  }
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The returns database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('already has an active return')) {
    return 'This delivery already has an active return. Close or cancel it before starting another.';
  }
  if (msg.includes('exceeds the returnable quantity')) {
    return 'The return quantity exceeds what is still returnable for that line.';
  }
  if (msg.includes('nothing was delivered')) {
    return 'Nothing was delivered for that line, so nothing can be returned.';
  }
  if (msg.includes('only a confirmed delivery') || msg.includes('can only be created against a confirmed delivery')) {
    return 'A return can only be created against a confirmed delivery.';
  }
  if (msg.includes('not in a recorded state')) {
    return 'The dispatch for this delivery is not in a recorded state and cannot accept a return.';
  }
  if (msg.includes('inactive and cannot be used')) {
    return 'That stock location is inactive and cannot be used.';
  }
  if (msg.includes('only a pending return can be received')) {
    return 'Only a pending return can be received.';
  }
  if (msg.includes('only a pending return can be cancelled')) {
    return 'Only a pending return can be cancelled. A received return must be processed to closure.';
  }
  if (msg.includes('already has a disposition')) {
    return 'That line already has a disposition and cannot be changed.';
  }
  if (msg.includes('still awaiting disposition') || msg.includes('cannot close')) {
    return 'Every line must be restocked or written off before the return can be closed.';
  }
  if (msg.includes('must differ from the quarantine')) {
    return 'The restock location must differ from the quarantine location.';
  }
  if (msg.includes('not a member of the target organisation')) {
    return 'You are not a member of this organisation.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')
      || msg.includes('owner, admin') || msg.includes('owner or admin')) {
    return 'You do not have permission to perform this return operation.';
  }
  if (msg.includes('not authenticated')) return 'Your session has expired. Please sign in again.';
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normaliseReturn(r) {
  if (!r) return null;
  const order = r.sales_order || null;
  const customer = order ? order.customer || r.customer || null : (r.customer || null);
  const dispatch = r.dispatch || null;
  const delivery = r.delivery_confirmation || null;
  const location = r.quarantine_location || null;
  return {
    id: r.id,
    returnNumber: r.return_number,
    status: r.status,
    deliveryConfirmationId: r.delivery_confirmation_id,
    dispatchId: r.dispatch_id,
    salesOrderId: r.sales_order_id,
    customerId: r.customer_id,
    quarantineLocationId: r.quarantine_location_id,
    reasonSummary: r.reason_summary,
    receivedAt: r.received_at,
    closedAt: r.closed_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Derived display context.
    orderNumber: order ? order.order_number : null,
    customerLegalName: customer ? customer.legal_name : null,
    customerTradingName: customer ? customer.trading_name : null,
    dispatchNumber: dispatch ? dispatch.dispatch_number : null,
    deliveryNumber: delivery ? delivery.delivery_number : null,
    quarantineLocationCode: location ? location.location_code : null,
    quarantineLocationName: location ? location.name : null,
  };
}

function normaliseReturnLine(l) {
  if (!l) return null;
  const product = l.finished_product || null;
  const restockLocation = l.restock_location || null;
  const dline = l.dispatch_line || null;
  const dcl = l.delivery_confirmation_line || null;
  return {
    id: l.id,
    returnId: l.return_id,
    dispatchLineId: l.dispatch_line_id,
    deliveryConfirmationLineId: l.delivery_confirmation_line_id,
    finishedProductId: l.finished_product_id,
    returnedQty: l.returned_qty,
    reasonCode: l.reason_code,
    conditionCode: l.condition_code,
    disposition: l.disposition,
    dispositionQty: l.disposition_qty,
    restockLocationId: l.restock_location_id,
    restockTransferGroupId: l.restock_transfer_group_id,
    notes: l.notes,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    productName: product ? product.name : null,
    productSku: product ? product.sku_code : null,
    productBottleVolumeMl: product ? product.bottle_volume_ml : null,
    restockLocationCode: restockLocation ? restockLocation.location_code : null,
    restockLocationName: restockLocation ? restockLocation.name : null,
    dispatchedQty: dline ? dline.qty_bottles : null,
    deliveredQty: dcl ? dcl.delivered_qty : null,
  };
}

const RETURN_SELECT =
  'id, org_id, return_number, status, delivery_confirmation_id, dispatch_id, sales_order_id, ' +
  'customer_id, quarantine_location_id, reason_summary, received_at, closed_at, cancelled_at, ' +
  'cancel_reason, created_at, updated_at, ' +
  'sales_order:sales_orders(id, order_number, customer_id, customer:customers(id, legal_name, trading_name)), ' +
  'dispatch:dispatches(id, dispatch_number, status), ' +
  'delivery_confirmation:delivery_confirmations(id, delivery_number, status), ' +
  'quarantine_location:stock_locations(id, location_code, name)';

const RETURN_LINE_SELECT =
  'id, org_id, return_id, dispatch_line_id, delivery_confirmation_line_id, finished_product_id, ' +
  'returned_qty, reason_code, condition_code, disposition, disposition_qty, restock_location_id, ' +
  'restock_transfer_group_id, notes, created_at, updated_at, ' +
  'finished_product:finished_products(id, sku_code, name, bottle_volume_ml), ' +
  'restock_location:stock_locations(id, location_code, name), ' +
  'dispatch_line:dispatch_lines(id, qty_bottles), ' +
  'delivery_confirmation_line:delivery_confirmation_lines(id, delivered_qty)';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Active organisation's returns, newest first. Optional filters:
 * status, deliveryConfirmationId, dispatchId, salesOrderId, and client-side search.
 */
export async function getReturns(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase.from('returns').select(RETURN_SELECT).eq('org_id', orgId);
  if (options.status) query = query.eq('status', options.status);
  if (options.deliveryConfirmationId) query = query.eq('delivery_confirmation_id', options.deliveryConfirmationId);
  if (options.dispatchId) query = query.eq('dispatch_id', options.dispatchId);
  if (options.salesOrderId) query = query.eq('sales_order_id', options.salesOrderId);
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return { data: null, error };
  let rows = (data || []).map(normaliseReturn);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      (r.returnNumber || '').toLowerCase().includes(q) ||
      (r.dispatchNumber || '').toLowerCase().includes(q) ||
      (r.deliveryNumber || '').toLowerCase().includes(q) ||
      (r.orderNumber || '').toLowerCase().includes(q) ||
      (r.customerLegalName || '').toLowerCase().includes(q) ||
      (r.customerTradingName || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

export async function getReturn(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!id) return { data: null, error: { message: 'A return is required.' } };
  const { data, error } = await supabase
    .from('returns').select(RETURN_SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normaliseReturn(data), error: null };
}

export async function getReturnLines(returnId) {
  const orgId = getActiveOrgId();
  if (!orgId || !returnId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('return_lines').select(RETURN_LINE_SELECT)
    .eq('org_id', orgId).eq('return_id', returnId)
    .order('created_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseReturnLine), error: null };
}

/**
 * Confirmed deliveries eligible to start a NEW return: status delivered /
 * delivered_with_variance, their dispatch still 'recorded', and no active
 * (pending/received) return already open. Returns a normalised-delivery-ish
 * shape { id, deliveryNumber, dispatchId, dispatchNumber, orderNumber,
 * customerName }. Active-org scoped.
 */
export async function getEligibleDeliveriesForReturn() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('delivery_confirmations')
    .select(
      'id, status, dispatch_id, sales_order_id, delivery_number, ' +
      'dispatch:dispatches(id, dispatch_number, status), ' +
      'sales_order:sales_orders(id, order_number, customer:customers(id, legal_name, trading_name))'
    )
    .eq('org_id', orgId)
    .in('status', ['delivered', 'delivered_with_variance'])
    .order('created_at', { ascending: false });
  if (error) return { data: null, error };

  const candidates = (data || []).filter((d) => d.dispatch && d.dispatch.status === 'recorded');
  if (candidates.length === 0) return { data: [], error: null };

  // Exclude deliveries that already have an active (pending/received) return.
  const { data: activeReturns, error: arErr } = await supabase
    .from('returns')
    .select('delivery_confirmation_id, status')
    .eq('org_id', orgId)
    .in('status', ['pending', 'received']);
  if (arErr) return { data: null, error: arErr };
  const blocked = new Set((activeReturns || []).map((r) => r.delivery_confirmation_id));

  const rows = candidates
    .filter((d) => !blocked.has(d.id))
    .map((d) => {
      const order = d.sales_order || null;
      const customer = order ? order.customer || null : null;
      return {
        id: d.id,
        deliveryNumber: d.delivery_number,
        status: d.status,
        dispatchId: d.dispatch_id,
        dispatchNumber: d.dispatch ? d.dispatch.dispatch_number : null,
        salesOrderId: d.sales_order_id,
        orderNumber: order ? order.order_number : null,
        customerName: customer ? (customer.trading_name || customer.legal_name) : null,
      };
    });
  return { data: rows, error: null };
}

/**
 * Per-dispatch-line returnable headroom for a given delivery, used by the create
 * flow. returnable = delivered_qty - SUM(returned_qty across non-cancelled
 * returns for that dispatch_line). Returns an array of
 * { deliveryLineId, dispatchLineId, productName, productSku, deliveredQty,
 *   alreadyReturned, returnable }.
 */
export async function getReturnableLines(deliveryConfirmationId) {
  const orgId = getActiveOrgId();
  if (!orgId || !deliveryConfirmationId) return { data: [], error: null };

  const { data: dcls, error: dclErr } = await supabase
    .from('delivery_confirmation_lines')
    .select(
      'id, dispatch_line_id, delivered_qty, ' +
      'dispatch_line:dispatch_lines(id, finished_product_id, ' +
      'finished_product:finished_products(id, sku_code, name, bottle_volume_ml))'
    )
    .eq('org_id', orgId)
    .eq('delivery_confirmation_id', deliveryConfirmationId);
  if (dclErr) return { data: null, error: dclErr };

  const lines = dcls || [];
  if (lines.length === 0) return { data: [], error: null };

  const dispatchLineIds = lines.map((l) => l.dispatch_line_id);
  // Sum existing non-cancelled returned quantities per dispatch_line.
  const { data: rls, error: rlErr } = await supabase
    .from('return_lines')
    .select('dispatch_line_id, returned_qty, returns!inner(status)')
    .in('dispatch_line_id', dispatchLineIds);
  if (rlErr) return { data: null, error: rlErr };

  const usedByLine = {};
  (rls || []).forEach((r) => {
    const st = r.returns?.status;
    if (st && st !== 'cancelled') {
      usedByLine[r.dispatch_line_id] = (usedByLine[r.dispatch_line_id] || 0) + (Number(r.returned_qty) || 0);
    }
  });

  const rows = lines.map((l) => {
    const dline = l.dispatch_line || null;
    const product = dline ? dline.finished_product || null : null;
    const delivered = Number(l.delivered_qty) || 0;
    const already = usedByLine[l.dispatch_line_id] || 0;
    return {
      deliveryLineId: l.id,
      dispatchLineId: l.dispatch_line_id,
      finishedProductId: dline ? dline.finished_product_id : null,
      productName: product ? product.name : null,
      productSku: product ? product.sku_code : null,
      deliveredQty: delivered,
      alreadyReturned: already,
      returnable: Math.max(0, delivered - already),
    };
  });
  return { data: rows, error: null };
}

// ── Writes (RPC-only) ─────────────────────────────────────────────────────────

/**
 * Create a return against a confirmed delivery.
 * @param {string} deliveryConfirmationId
 * @param {string} quarantineLocationId
 * @param {Array<{ dispatch_line_id: string, returned_qty: number,
 *   reason_code: string, condition_code: string, notes?: string }>} lines
 * @param {string|null} [reasonSummary]
 */
export async function createReturn(deliveryConfirmationId, quarantineLocationId, lines, reasonSummary = null) {
  if (!deliveryConfirmationId) return { data: null, error: { message: 'A delivery is required.' } };
  if (!quarantineLocationId) return { data: null, error: { message: 'A quarantine location is required.' } };
  if (!Array.isArray(lines) || lines.length === 0) return { data: null, error: { message: 'At least one return line is required.' } };
  const { data, error } = await supabase.rpc('create_return', {
    p_delivery_confirmation_id: deliveryConfirmationId,
    p_quarantine_location_id: quarantineLocationId,
    p_lines: lines,
    p_reason_summary: reasonSummary,
  });
  if (error) return { data: null, error };
  return { data: normaliseReturn(Array.isArray(data) ? data[0] : data), error: null };
}

export async function receiveReturn(returnId) {
  if (!returnId) return { data: null, error: { message: 'A return is required.' } };
  const { data, error } = await supabase.rpc('receive_return', { p_return_id: returnId });
  if (error) return { data: null, error };
  return { data: normaliseReturn(Array.isArray(data) ? data[0] : data), error: null };
}

export async function inspectReturnLine(returnLineId, conditionCode = null, notes = null) {
  if (!returnLineId) return { data: null, error: { message: 'A return line is required.' } };
  const { data, error } = await supabase.rpc('inspect_return_line', {
    p_return_line_id: returnLineId,
    p_condition_code: conditionCode,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data: normaliseReturnLine(Array.isArray(data) ? data[0] : data), error: null };
}

export async function restockReturnLine(returnLineId, restockLocationId) {
  if (!returnLineId) return { data: null, error: { message: 'A return line is required.' } };
  if (!restockLocationId) return { data: null, error: { message: 'A restock location is required.' } };
  const { data, error } = await supabase.rpc('restock_return_line', {
    p_return_line_id: returnLineId,
    p_restock_location_id: restockLocationId,
  });
  if (error) return { data: null, error };
  return { data: normaliseReturnLine(Array.isArray(data) ? data[0] : data), error: null };
}

export async function writeoffReturnLine(returnLineId, reason = null) {
  if (!returnLineId) return { data: null, error: { message: 'A return line is required.' } };
  const { data, error } = await supabase.rpc('writeoff_return_line', {
    p_return_line_id: returnLineId,
    p_reason: reason,
  });
  if (error) return { data: null, error };
  return { data: normaliseReturnLine(Array.isArray(data) ? data[0] : data), error: null };
}

export async function closeReturn(returnId) {
  if (!returnId) return { data: null, error: { message: 'A return is required.' } };
  const { data, error } = await supabase.rpc('close_return', { p_return_id: returnId });
  if (error) return { data: null, error };
  return { data: normaliseReturn(Array.isArray(data) ? data[0] : data), error: null };
}

export async function cancelReturn(returnId, reason) {
  if (!returnId) return { data: null, error: { message: 'A return is required.' } };
  if (!reason || !reason.trim()) return { data: null, error: { message: 'A cancellation reason is required.' } };
  const { data, error } = await supabase.rpc('cancel_return', { p_return_id: returnId, p_reason: reason });
  if (error) return { data: null, error };
  return { data: normaliseReturn(Array.isArray(data) ? data[0] : data), error: null };
}
