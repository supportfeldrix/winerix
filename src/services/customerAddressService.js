import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer Address Service (P2L-3)
// Addresses are billing/shipping/other locations of a customer. Org-scoped,
// child of customers (ON DELETE CASCADE). Retired via is_active = false — no
// delete path. At most ONE active primary per customer (DB partial unique
// index); the atomic set_primary_customer_address RPC safely swaps the primary.
//
// Org-scoped on top of org-based RLS (is_org_member + OWNER/ADMIN/SALES writes).
// Creates set org_id = active org, owner_id = authenticated user; customer_id is
// never changed on update.
// Schema: supabase/migrations/045_customer_contacts_addresses.sql
// ─────────────────────────────────────────────────────────────────────────────

export const CUSTOMER_ADDRESS_TYPES = Object.freeze(['Billing', 'Shipping', 'Other']);
const VALID_TYPES = new Set(CUSTOMER_ADDRESS_TYPES);

export function friendlyAddressError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The customers database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique') || msg.includes('uq_ca_one_active_primary')) {
    return 'This customer already has an active primary address. Use “Set as primary” to switch it.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('ca_type_check') || msg.includes('address_type')) return 'Please choose a valid address type.';
    return 'Please provide address line 1, city and country.';
  }
  if (msg.includes('cross-organisation')) {
    return 'That customer belongs to a different organisation.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('owner, admin or sales')) {
    return 'You do not have permission to manage addresses. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function normalise(a) {
  if (!a) return null;
  return {
    id: a.id,
    customerId: a.customer_id,
    addressType: a.address_type,
    label: a.label,
    companyName: a.company_name,
    addressLine1: a.address_line_1,
    addressLine2: a.address_line_2,
    city: a.city,
    province: a.province,
    postalCode: a.postal_code,
    country: a.country,
    isPrimary: a.is_primary,
    isActive: a.is_active,
    notes: a.notes,
    ownerId: a.owner_id,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

const SELECT =
  'id, customer_id, address_type, label, company_name, address_line_1, address_line_2, ' +
  'city, province, postal_code, country, is_primary, is_active, notes, owner_id, created_at, updated_at';

function cleanText(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

export async function getAddressesByCustomer(customerId, options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId || !customerId) return { data: [], error: null };

  let query = supabase
    .from('customer_addresses')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('customer_id', customerId);

  if (options.activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('is_primary', { ascending: false })
    .order('address_type', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getAddress(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('customer_addresses').select(SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createAddress(customerId, input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!customerId) return { data: null, error: { message: 'A customer is required.' } };

  const addressType = (input.addressType || '').trim();
  const line1 = (input.addressLine1 || '').trim();
  const city = (input.city || '').trim();
  const country = (input.country || '').trim() || 'South Africa';
  if (!VALID_TYPES.has(addressType)) return { data: null, error: { message: 'Please choose a valid address type.' } };
  if (!line1) return { data: null, error: { message: 'Address line 1 is required.' } };
  if (!city) return { data: null, error: { message: 'City is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    customer_id: customerId,
    address_type: addressType,
    label: cleanText(input.label),
    company_name: cleanText(input.companyName),
    address_line_1: line1,
    address_line_2: cleanText(input.addressLine2),
    city,
    province: cleanText(input.province),
    postal_code: cleanText(input.postalCode),
    country,
    is_primary: Boolean(input.isPrimary),
    notes: cleanText(input.notes),
  };

  const { data, error } = await supabase.from('customer_addresses').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function updateAddress(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.addressType !== undefined) {
    const addressType = (input.addressType || '').trim();
    if (!VALID_TYPES.has(addressType)) return { data: null, error: { message: 'Please choose a valid address type.' } };
    row.address_type = addressType;
  }
  if (input.addressLine1 !== undefined) {
    const line1 = (input.addressLine1 || '').trim();
    if (!line1) return { data: null, error: { message: 'Address line 1 is required.' } };
    row.address_line_1 = line1;
  }
  if (input.city !== undefined) {
    const city = (input.city || '').trim();
    if (!city) return { data: null, error: { message: 'City is required.' } };
    row.city = city;
  }
  if (input.country !== undefined) {
    const country = (input.country || '').trim();
    if (!country) return { data: null, error: { message: 'Country is required.' } };
    row.country = country;
  }
  if (input.label !== undefined) row.label = cleanText(input.label);
  if (input.companyName !== undefined) row.company_name = cleanText(input.companyName);
  if (input.addressLine2 !== undefined) row.address_line_2 = cleanText(input.addressLine2);
  if (input.province !== undefined) row.province = cleanText(input.province);
  if (input.postalCode !== undefined) row.postal_code = cleanText(input.postalCode);
  if (input.notes !== undefined) row.notes = cleanText(input.notes);
  // is_primary / is_active / org_id / owner_id / customer_id intentionally not writable here.

  const { data, error } = await supabase
    .from('customer_addresses').update(row).eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deactivateAddress(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('customer_addresses').update({ is_active: false, is_primary: false })
    .eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function reactivateAddress(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('customer_addresses').update({ is_active: true })
    .eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Atomically make an address the customer's primary via the SECURITY DEFINER RPC.
 */
export async function setPrimaryAddress(id) {
  if (!id) return { data: null, error: { message: 'An address is required.' } };
  const { data, error } = await supabase.rpc('set_primary_customer_address', { p_address_id: id });
  if (error) return { data: null, error };
  const r = Array.isArray(data) ? data[0] : data;
  return { data: normalise(r), error: null };
}
