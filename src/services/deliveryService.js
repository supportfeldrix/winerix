import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Delivery Service (P2M-5, delivery confirmation / proof of delivery)
//
// Reads delivery confirmations (an ATTESTATION layer on top of physical dispatch)
// and performs all writes through SECURITY DEFINER RPCs. This service NEVER
// writes dispatch/stock/allocation/order tables and NEVER inserts/updates the
// delivery tables directly — every mutation goes through a controlled RPC:
//   create_delivery_confirmation(dispatch)
//   update_delivery_confirmation_pending(delivery, lines, recipient, notes)
//   confirm_delivery_confirmation(delivery, variance_reason, pod...)
//   fail_delivery_confirmation(delivery, failure_reason, notes)
//   cancel_delivery_confirmation(delivery, reason)   [OWNER/ADMIN only]
//
// A delivery confirmation records what the customer received (delivered_qty).
// It does NOT move stock. The dispatched quantity remains authoritative in
// dispatch_lines.qty_bottles and is DERIVED for display (never editable here).
// Reads are active-organisation scoped on top of org-based RLS.
// Schema: supabase/migrations/055_delivery_confirmations.sql
// ─────────────────────────────────────────────────────────────────────────────

export const DELIVERY_STATUSES = Object.freeze([
  { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'delivered_with_variance', label: 'Delivered (variance)' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]);

export const VARIANCE_REASONS = Object.freeze([
  { value: 'SHORT_DELIVERY', label: 'Short delivery' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'MISSING', label: 'Missing' },
  { value: 'OTHER', label: 'Other' },
]);

export const FAILURE_REASONS = Object.freeze([
  { value: 'CUSTOMER_UNAVAILABLE', label: 'Customer unavailable' },
  { value: 'VEHICLE_ISSUE', label: 'Vehicle issue' },
  { value: 'DAMAGED_IN_TRANSIT', label: 'Damaged in transit' },
  { value: 'WRONG_ADDRESS', label: 'Wrong address' },
  { value: 'CUSTOMER_REJECTED', label: 'Customer rejected' },
  { value: 'OTHER', label: 'Other' },
]);

export function deliveryStatusLabel(status) {
  const found = DELIVERY_STATUSES.find((s) => s.value === status);
  return found ? found.label : (status || '—');
}

export function deliveryStatusColor(status) {
  switch (status) {
    case 'pending': return 'warning';
    case 'delivered': return 'success';
    case 'delivered_with_variance': return 'info';
    case 'failed': return 'error';
    case 'cancelled': return 'default';
    default: return 'default';
  }
}

export function varianceReasonLabel(v) {
  const found = VARIANCE_REASONS.find((r) => r.value === v);
  return found ? found.label : (v || '—');
}
export function failureReasonLabel(v) {
  const found = FAILURE_REASONS.find((r) => r.value === v);
  return found ? found.label : (v || '—');
}

export function friendlyDeliveryError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  if (import.meta?.env?.DEV) {
    // eslint-disable-next-line no-console
    console.error('[delivery] error:', { code: error.code, message: error.message, details: error.details, hint: error.hint });
  }
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The delivery database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('already has an active or confirmed delivery')) {
    return 'This dispatch already has an active or confirmed delivery.';
  }
  if (msg.includes('only a recorded dispatch') || msg.includes('recorded dispatch')) {
    return 'A delivery can only be created for a recorded dispatch (not a voided one).';
  }
  if (msg.includes('variance reason is required')) {
    return 'Please choose a variance reason for the short delivery.';
  }
  if (msg.includes('failure reason is required')) {
    return 'Please choose a failure reason.';
  }
  if (msg.includes('exceeds the dispatched quantity') || msg.includes('exceeds the dispatched')) {
    return 'A delivered quantity cannot exceed the dispatched quantity.';
  }
  if (msg.includes('only a pending delivery')) {
    return 'Only a pending delivery can be changed. Confirmed, failed and cancelled deliveries are historical.';
  }
  if (msg.includes('confirmed delivery and cannot be reversed')) {
    return 'This dispatch has a confirmed delivery and cannot be reversed.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')
      || msg.includes('owner, admin') || msg.includes('owner or admin')) {
    return 'You do not have permission to perform this delivery operation.';
  }
  if (msg.includes('not authenticated')) return 'Your session has expired. Please sign in again.';
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normaliseDelivery(d) {
  if (!d) return null;
  const dispatch = d.dispatch || null;
  const order = dispatch ? dispatch.sales_order || null : (d.sales_order || null);
  const customer = order ? order.customer || null : null;
  return {
    id: d.id,
    dispatchId: d.dispatch_id,
    salesOrderId: d.sales_order_id,
    deliveryNumber: d.delivery_number,
    status: d.status,
    recipientName: d.recipient_name,
    recipientRole: d.recipient_role,
    deliveredAt: d.delivered_at,
    deliveryNotes: d.delivery_notes,
    varianceReason: d.variance_reason,
    failureReason: d.failure_reason,
    signatureStoragePath: d.signature_storage_path,
    proofDocumentStoragePath: d.proof_document_storage_path,
    proofPhotoStoragePath: d.proof_photo_storage_path,
    addressSnapshot: d.address_snapshot || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    dispatchNumber: dispatch ? dispatch.dispatch_number : null,
    dispatchStatus: dispatch ? dispatch.status : null,
    orderNumber: order ? order.order_number : null,
    customerId: order ? order.customer_id : null,
    customerLegalName: customer ? customer.legal_name : null,
    customerTradingName: customer ? customer.trading_name : null,
  };
}

function normaliseDeliveryLine(l) {
  if (!l) return null;
  const dline = l.dispatch_line || null;
  const product = dline ? dline.finished_product || null : null;
  const location = dline ? dline.stock_location || null : null;
  const dispatchedQty = dline ? dline.qty_bottles : null;
  const deliveredQty = l.delivered_qty;
  return {
    id: l.id,
    deliveryConfirmationId: l.delivery_confirmation_id,
    dispatchLineId: l.dispatch_line_id,
    deliveredQty,
    notes: l.notes,
    createdAt: l.created_at,
    // Derived (authoritative dispatched qty stays in dispatch_lines).
    dispatchedQty,
    varianceQty: dispatchedQty != null && deliveredQty != null ? dispatchedQty - deliveredQty : null,
    productName: product ? product.name : null,
    productSku: product ? product.sku_code : null,
    productBottleVolumeMl: product ? product.bottle_volume_ml : null,
    locationCode: location ? location.location_code : null,
    locationName: location ? location.name : null,
  };
}

const DELIVERY_SELECT =
  'id, org_id, dispatch_id, sales_order_id, delivery_number, status, recipient_name, recipient_role, ' +
  'delivered_at, delivery_notes, variance_reason, failure_reason, signature_storage_path, ' +
  'proof_document_storage_path, proof_photo_storage_path, address_snapshot, created_at, updated_at, ' +
  'dispatch:dispatches(id, dispatch_number, status, ' +
  'sales_order:sales_orders(id, order_number, customer_id, customer:customers(id, legal_name, trading_name)))';

const DELIVERY_LINE_SELECT =
  'id, org_id, delivery_confirmation_id, dispatch_line_id, delivered_qty, notes, created_at, ' +
  'dispatch_line:dispatch_lines(id, qty_bottles, ' +
  'finished_product:finished_products(id, sku_code, name, bottle_volume_ml), ' +
  'stock_location:stock_locations(id, location_code, name))';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Active organisation's delivery confirmations, newest first. Optional filters:
 * status, dispatchId, salesOrderId, and client-side search.
 */
export async function getDeliveries(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase.from('delivery_confirmations').select(DELIVERY_SELECT).eq('org_id', orgId);
  if (options.status) query = query.eq('status', options.status);
  if (options.dispatchId) query = query.eq('dispatch_id', options.dispatchId);
  if (options.salesOrderId) query = query.eq('sales_order_id', options.salesOrderId);
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return { data: null, error };
  let rows = (data || []).map(normaliseDelivery);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((d) =>
      (d.deliveryNumber || '').toLowerCase().includes(q) ||
      (d.dispatchNumber || '').toLowerCase().includes(q) ||
      (d.orderNumber || '').toLowerCase().includes(q) ||
      (d.customerLegalName || '').toLowerCase().includes(q) ||
      (d.customerTradingName || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

export async function getDelivery(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!id) return { data: null, error: { message: 'A delivery is required.' } };
  const { data, error } = await supabase
    .from('delivery_confirmations').select(DELIVERY_SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normaliseDelivery(data), error: null };
}

export async function getDeliveryLines(deliveryId) {
  const orgId = getActiveOrgId();
  if (!orgId || !deliveryId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('delivery_confirmation_lines').select(DELIVERY_LINE_SELECT)
    .eq('org_id', orgId).eq('delivery_confirmation_id', deliveryId)
    .order('created_at', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseDeliveryLine), error: null };
}

/** The delivery confirmation(s) for a dispatch (used by the dispatch profile). */
export async function getDeliveriesByDispatch(dispatchId) {
  const orgId = getActiveOrgId();
  if (!orgId || !dispatchId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('delivery_confirmations').select(DELIVERY_SELECT)
    .eq('org_id', orgId).eq('dispatch_id', dispatchId)
    .order('created_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseDelivery), error: null };
}

// ── Writes (RPC-only) ─────────────────────────────────────────────────────────

export async function createDeliveryConfirmation(dispatchId) {
  if (!dispatchId) return { data: null, error: { message: 'A dispatch is required.' } };
  const { data, error } = await supabase.rpc('create_delivery_confirmation', { p_dispatch_id: dispatchId });
  if (error) return { data: null, error };
  return { data: normaliseDelivery(Array.isArray(data) ? data[0] : data), error: null };
}

/**
 * Update a PENDING delivery's per-line delivered quantities + optional recipient/notes.
 * @param {string} deliveryId
 * @param {Array<{ delivery_confirmation_line_id: string, delivered_qty: number, notes?: string }>} lines
 * @param {{ recipientName?: string, recipientRole?: string, deliveryNotes?: string }} [meta]
 */
export async function updateDeliveryPending(deliveryId, lines, meta = {}) {
  if (!deliveryId) return { data: null, error: { message: 'A delivery is required.' } };
  const { data, error } = await supabase.rpc('update_delivery_confirmation_pending', {
    p_delivery_id: deliveryId,
    p_lines: lines || [],
    p_recipient_name: meta.recipientName ?? null,
    p_recipient_role: meta.recipientRole ?? null,
    p_delivery_notes: meta.deliveryNotes ?? null,
  });
  if (error) return { data: null, error };
  return { data: normaliseDelivery(Array.isArray(data) ? data[0] : data), error: null };
}

/**
 * Confirm a PENDING delivery. Status is determined server-side (delivered vs
 * delivered_with_variance). varianceReason is required when there is a shortfall.
 */
export async function confirmDelivery(deliveryId, options = {}) {
  if (!deliveryId) return { data: null, error: { message: 'A delivery is required.' } };
  const { data, error } = await supabase.rpc('confirm_delivery_confirmation', {
    p_delivery_id: deliveryId,
    p_variance_reason: options.varianceReason ?? null,
    p_recipient_name: options.recipientName ?? null,
    p_recipient_role: options.recipientRole ?? null,
    p_delivery_notes: options.deliveryNotes ?? null,
    p_signature_storage_path: options.signatureStoragePath ?? null,
    p_proof_document_storage_path: options.proofDocumentStoragePath ?? null,
    p_proof_photo_storage_path: options.proofPhotoStoragePath ?? null,
  });
  if (error) return { data: null, error };
  return { data: normaliseDelivery(Array.isArray(data) ? data[0] : data), error: null };
}

export async function failDelivery(deliveryId, failureReason, notes = null) {
  if (!deliveryId) return { data: null, error: { message: 'A delivery is required.' } };
  if (!failureReason) return { data: null, error: { message: 'A failure reason is required.' } };
  const { data, error } = await supabase.rpc('fail_delivery_confirmation', {
    p_delivery_id: deliveryId,
    p_failure_reason: failureReason,
    p_delivery_notes: notes,
  });
  if (error) return { data: null, error };
  return { data: normaliseDelivery(Array.isArray(data) ? data[0] : data), error: null };
}

export async function cancelDelivery(deliveryId, reason = null) {
  if (!deliveryId) return { data: null, error: { message: 'A delivery is required.' } };
  const { data, error } = await supabase.rpc('cancel_delivery_confirmation', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
  if (error) return { data: null, error };
  return { data: normaliseDelivery(Array.isArray(data) ? data[0] : data), error: null };
}
