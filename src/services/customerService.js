import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer Service (P2L-2)
// A customer is an org-scoped commercial customer-master record used later by
// Sales Orders (P2L-4+). Customers are added on demand (no seed) and RETIRED via
// is_active = false — there is NO delete path (history must be preserved; future
// sales orders will reference customers with ON DELETE RESTRICT). legal_name is
// unique per org CASE-INSENSITIVELY among ACTIVE records; vat_number is unique
// per org when supplied.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/SALES writes) —
// RLS remains authoritative. Creates set org_id = active org and owner_id = the
// authenticated user; neither is taken from the UI. This service is focused only
// on Customers — no contacts, addresses, orders, allocations or stock.
// Schema: supabase/migrations/044_customers.sql
// ─────────────────────────────────────────────────────────────────────────────

// Controlled customer-type vocabulary (matches the DB CHECK exactly, 044).
export const CUSTOMER_TYPES = Object.freeze([
  'Individual',
  'Restaurant',
  'Retailer',
  'Distributor',
  'Wholesaler',
  'Wine Estate',
  'Export',
  'Other',
]);

const VALID_TYPES = new Set(CUSTOMER_TYPES);

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyCustomerError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The customers database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    if (msg.includes('uq_customers_org_vat') || details.includes('uq_customers_org_vat') || msg.includes('vat')) {
      return 'A customer with this VAT number already exists in this organisation.';
    }
    return 'An active customer with this legal name already exists in this organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('customers_type_check') || details.includes('customers_type_check') || msg.includes('customer_type')) {
      return 'Please choose a valid customer type.';
    }
    return 'Please provide a valid legal name.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage customers. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw customers row into camelCase.
function normalise(c) {
  if (!c) return null;
  return {
    id: c.id,
    customerType: c.customer_type,
    legalName: c.legal_name,
    tradingName: c.trading_name,
    registrationNumber: c.registration_number,
    vatNumber: c.vat_number,
    email: c.email,
    phone: c.phone,
    website: c.website,
    isActive: c.is_active,
    notes: c.notes,
    ownerId: c.owner_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

const SELECT =
  'id, customer_type, legal_name, trading_name, registration_number, vat_number, ' +
  'email, phone, website, is_active, notes, owner_id, created_at, updated_at';

// ── Shared input helpers ─────────────────────────────────────────────────────

function cleanText(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's customers. Active customers only by default;
 * pass { includeInactive: true } to include retired ones. Optional client-side
 * search (legal name / trading name / email / phone) and customerType filter.
 * Ordered by legal_name.
 * @param {{ includeInactive?: boolean, search?: string, customerType?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getCustomers(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('customers')
    .select(SELECT)
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);
  if (options.customerType) query = query.eq('customer_type', options.customerType);

  const { data, error } = await query.order('legal_name', { ascending: true });
  if (error) return { data: null, error };

  let rows = (data || []).map(normalise);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((c) =>
      (c.legalName || '').toLowerCase().includes(q) ||
      (c.tradingName || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single customer by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getCustomer(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('customers')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a customer in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload). is_active defaults
 * to true. Uniqueness (active legal name per org; VAT per org when supplied) is
 * DB-enforced.
 * @param {{ customerType: string, legalName: string, tradingName?: string|null,
 *   registrationNumber?: string|null, vatNumber?: string|null, email?: string|null,
 *   phone?: string|null, website?: string|null, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createCustomer(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const legalName = (input.legalName || '').trim();
  const customerType = (input.customerType || '').trim();
  if (!legalName) return { data: null, error: { message: 'A legal name is required.' } };
  if (!VALID_TYPES.has(customerType)) return { data: null, error: { message: 'Please choose a valid customer type.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    customer_type: customerType,
    legal_name: legalName,
    trading_name: cleanText(input.tradingName),
    registration_number: cleanText(input.registrationNumber),
    vat_number: cleanText(input.vatNumber),
    email: cleanText(input.email),
    phone: cleanText(input.phone),
    website: cleanText(input.website),
    notes: cleanText(input.notes),
    // is_active intentionally omitted — DB default is TRUE.
  };

  const { data, error } = await supabase
    .from('customers')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a customer's editable fields (active-org scoped). id, org_id and
 * owner_id are NEVER changed here (owner_id immutability is also DB-enforced).
 * is_active is NOT changed here — use deactivate/reactivate.
 * @param {string} id
 * @param {object} input - any of: customerType, legalName, tradingName,
 *   registrationNumber, vatNumber, email, phone, website, notes
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateCustomer(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.customerType !== undefined) {
    const customerType = (input.customerType || '').trim();
    if (!VALID_TYPES.has(customerType)) return { data: null, error: { message: 'Please choose a valid customer type.' } };
    row.customer_type = customerType;
  }
  if (input.legalName !== undefined) {
    const legalName = (input.legalName || '').trim();
    if (!legalName) return { data: null, error: { message: 'A legal name is required.' } };
    row.legal_name = legalName;
  }
  if (input.tradingName !== undefined) row.trading_name = cleanText(input.tradingName);
  if (input.registrationNumber !== undefined) row.registration_number = cleanText(input.registrationNumber);
  if (input.vatNumber !== undefined) row.vat_number = cleanText(input.vatNumber);
  if (input.email !== undefined) row.email = cleanText(input.email);
  if (input.phone !== undefined) row.phone = cleanText(input.phone);
  if (input.website !== undefined) row.website = cleanText(input.website);
  if (input.notes !== undefined) row.notes = cleanText(input.notes);
  // is_active / org_id / owner_id intentionally NOT writable here.

  const { data, error } = await supabase
    .from('customers')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Retire a customer (soft-delete). Sets is_active = false; never deletes.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivateCustomer(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('customers')
    .update({ is_active: false })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Re-activate a previously retired customer. Sets is_active = true. Active-org
 * scoped. Note: a duplicate active legal name (or VAT) is DB-rejected on
 * reactivation — surfaced as a friendly error.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateCustomer(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('customers')
    .update({ is_active: true })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// NOTE: there is intentionally NO deleteCustomer() — customers are retired via
// deactivateCustomer (is_active = false), never hard-deleted.
