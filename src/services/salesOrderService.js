import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Order Service (P2L-4, draft foundation)
// A sales order is the org-scoped commercial order header. P2L-4 creates/edits
// DRAFT orders only: order_number is generated server-side via the SECURITY
// DEFINER RPC next_sales_order_number (never from the browser), status is always
// 'draft', currency defaults to ZAR, totals stay 0 (no lines yet). Customer and
// addresses are referenced (not snapshotted — snapshots are P2L-5). This service
// never writes sales_order_lines, pricing, tax, allocation or dispatch.
//
// Reads/writes org-scoped on top of org-based RLS (is_org_member + OWNER/ADMIN/
// SALES writes). Creates set org_id = active org, owner_id = authenticated user;
// neither taken from the UI. Update is draft-only and never changes id/org_id/
// owner_id/order_number/status/totals.
// Schema: supabase/migrations/046_sales_orders.sql
// ─────────────────────────────────────────────────────────────────────────────

export const SALES_ORDER_STATUSES = Object.freeze([
  { value: 'draft', label: 'Draft' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'allocated', label: 'Allocated' },
  { value: 'partially_allocated', label: 'Partially Allocated' },
  { value: 'ready_to_dispatch', label: 'Ready to Dispatch' },
  { value: 'cancelled', label: 'Cancelled' },
]);

export function salesOrderStatusLabel(status) {
  const found = SALES_ORDER_STATUSES.find((s) => s.value === status);
  return found ? found.label : (status || '—');
}

export function friendlySalesOrderError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The sales orders database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'That order number already exists. Please try again.';
  }
  if (msg.includes('does not belong to the order customer')) {
    return 'The selected address does not belong to the chosen customer.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected customer or address belongs to a different organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('so_delivery_not_before_order') || msg.includes('delivery')) {
      return 'The requested delivery date cannot be before the order date.';
    }
    if (msg.includes('status')) return 'Invalid order status.';
    return 'Please provide valid order details.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'A referenced customer or address could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('not a member')) {
    return 'You do not have permission to manage sales orders. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normaliser ───────────────────────────────────────────────────────────────

function normalise(o) {
  if (!o) return null;
  const customer = o.customer || null;
  return {
    id: o.id,
    customerId: o.customer_id,
    orderNumber: o.order_number,
    orderDate: o.order_date,
    requestedDeliveryDate: o.requested_delivery_date,
    status: o.status,
    currency: o.currency,
    billingAddressId: o.billing_address_id,
    shippingAddressId: o.shipping_address_id,
    billingAddressSnapshot: o.billing_address_snapshot,
    shippingAddressSnapshot: o.shipping_address_snapshot,
    subtotal: o.subtotal,
    discountTotal: o.discount_total,
    taxTotal: o.tax_total,
    total: o.total,
    notes: o.notes,
    ownerId: o.owner_id,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    // Derived customer context (read-only).
    customerLegalName: customer ? customer.legal_name : null,
    customerTradingName: customer ? customer.trading_name : null,
  };
}

const SELECT =
  'id, customer_id, order_number, order_date, requested_delivery_date, status, currency, ' +
  'billing_address_id, shipping_address_id, billing_address_snapshot, shipping_address_snapshot, ' +
  'subtotal, discount_total, tax_total, total, notes, owner_id, created_at, updated_at, ' +
  'customer:customers(id, legal_name, trading_name)';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's sales orders, newest first. Optional filters:
 * status, customerId, and client-side search (order number / customer name).
 * @param {{ status?: string, customerId?: string, search?: string }} [options]
 */
export async function getSalesOrders(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('sales_orders')
    .select(SELECT)
    .eq('org_id', orgId);

  if (options.status) query = query.eq('status', options.status);
  if (options.customerId) query = query.eq('customer_id', options.customerId);

  query = query.order('order_date', { ascending: false }).order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return { data: null, error };

  let rows = (data || []).map(normalise);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((o) =>
      (o.orderNumber || '').toLowerCase().includes(q) ||
      (o.customerLegalName || '').toLowerCase().includes(q) ||
      (o.customerTradingName || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single sales order by id (active-org scoped), with customer context.
 */
export async function getSalesOrder(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('sales_orders').select(SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Lightweight sales-order options for future selectors (active-org scoped).
 */
export async function getSalesOrderOptions(options = {}) {
  const { data, error } = await getSalesOrders(options);
  if (error) return { data: null, error };
  return {
    data: (data || []).map((o) => ({
      id: o.id, orderNumber: o.orderNumber, status: o.status,
      customerId: o.customerId, customerLegalName: o.customerLegalName,
    })),
    error: null,
  };
}

// ── Writes (draft only) ──────────────────────────────────────────────────────

/**
 * Create a DRAFT sales order in the active organisation. Generates the order
 * number server-side via next_sales_order_number (never from the client), sets
 * org_id = active org, owner_id = the authenticated user, status = 'draft',
 * currency defaults to ZAR, and leaves totals at 0. Addresses, when supplied,
 * must belong to the chosen customer (DB integrity trigger is authoritative).
 * @param {{ customerId: string, orderDate?: string, requestedDeliveryDate?: string|null,
 *   currency?: string, billingAddressId?: string|null, shippingAddressId?: string|null,
 *   notes?: string|null }} input
 */
export async function createDraftSalesOrder(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.customerId) return { data: null, error: { message: 'A customer is required.' } };
  const orderDate = input.orderDate || null;
  if (!orderDate) return { data: null, error: { message: 'An order date is required.' } };
  if (input.requestedDeliveryDate && input.requestedDeliveryDate < orderDate) {
    return { data: null, error: { message: 'The requested delivery date cannot be before the order date.' } };
  }

  // Server-side order number (concurrency-safe RPC). Never browser-generated.
  const { data: numberData, error: numberError } = await supabase.rpc('next_sales_order_number', { p_org_id: orgId });
  if (numberError) return { data: null, error: numberError };
  const orderNumber = Array.isArray(numberData) ? numberData[0] : numberData;
  if (!orderNumber) return { data: null, error: { message: 'Could not generate an order number.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    customer_id: input.customerId,
    order_number: orderNumber,
    order_date: orderDate,
    requested_delivery_date: input.requestedDeliveryDate || null,
    currency: (input.currency || 'ZAR').trim() || 'ZAR',
    billing_address_id: input.billingAddressId || null,
    shipping_address_id: input.shippingAddressId || null,
    notes: input.notes ? input.notes.trim() : null,
    // status omitted -> DB default 'draft'; totals omitted -> DB default 0.
  };

  const { data, error } = await supabase.from('sales_orders').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a DRAFT sales order's editable header fields (active-org scoped).
 * Refuses to edit a non-draft order. id/org_id/owner_id/order_number/status/
 * totals are never changed here. Addresses must belong to the order's customer
 * (DB integrity trigger authoritative).
 * @param {string} id
 * @param {{ customerId?: string, orderDate?: string, requestedDeliveryDate?: string|null,
 *   currency?: string, billingAddressId?: string|null, shippingAddressId?: string|null,
 *   notes?: string|null }} input
 */
export async function updateDraftSalesOrder(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Refuse to edit a non-draft order (lifecycle actions come later).
  const { data: current, error: curErr } = await supabase
    .from('sales_orders').select('status, order_date').eq('id', id).eq('org_id', orgId).single();
  if (curErr) return { data: null, error: curErr };
  if (!current) return { data: null, error: { message: 'Sales order not found.' } };
  if (current.status !== 'draft') {
    return { data: null, error: { message: 'Only draft sales orders can be edited.' } };
  }

  const row = {};
  if (input.customerId !== undefined) {
    if (!input.customerId) return { data: null, error: { message: 'A customer is required.' } };
    row.customer_id = input.customerId;
  }
  if (input.orderDate !== undefined) {
    if (!input.orderDate) return { data: null, error: { message: 'An order date is required.' } };
    row.order_date = input.orderDate;
  }
  if (input.requestedDeliveryDate !== undefined) row.requested_delivery_date = input.requestedDeliveryDate || null;
  if (input.currency !== undefined) {
    const currency = (input.currency || '').trim();
    if (!currency) return { data: null, error: { message: 'A currency is required.' } };
    row.currency = currency;
  }
  if (input.billingAddressId !== undefined) row.billing_address_id = input.billingAddressId || null;
  if (input.shippingAddressId !== undefined) row.shipping_address_id = input.shippingAddressId || null;
  if (input.notes !== undefined) row.notes = input.notes ? input.notes.trim() : null;
  // id / org_id / owner_id / order_number / status / totals intentionally NOT writable here.

  // Client-side delivery-vs-order-date guard (DB CHECK is authoritative).
  const effectiveOrderDate = row.order_date || current.order_date;
  const effectiveDelivery = input.requestedDeliveryDate !== undefined ? (input.requestedDeliveryDate || null) : undefined;
  if (effectiveDelivery && effectiveOrderDate && effectiveDelivery < effectiveOrderDate) {
    return { data: null, error: { message: 'The requested delivery date cannot be before the order date.' } };
  }

  const { data, error } = await supabase
    .from('sales_orders').update(row).eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}
