import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer Contact Service (P2L-3)
// Contacts are people at a customer (buyer, accounts, logistics…). Org-scoped,
// child of customers (ON DELETE CASCADE). Retired via is_active = false — no
// delete path. At most ONE active primary per customer (DB partial unique
// index); the atomic set_primary_customer_contact RPC safely swaps the primary.
//
// Reads/writes are scoped to the active organisation on top of org-based RLS
// (is_org_member + OWNER/ADMIN/SALES writes) — RLS remains authoritative.
// Creates set org_id = active org and owner_id = the authenticated user; neither
// is taken from the UI. customer_id is never changed on update.
// Schema: supabase/migrations/045_customer_contacts_addresses.sql
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function friendlyContactError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The customers database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique') || msg.includes('uq_cc_one_active_primary')) {
    return 'This customer already has an active primary contact. Use “Set as primary” to switch it.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a first and last name.';
  }
  if (msg.includes('cross-organisation')) {
    return 'That customer belongs to a different organisation.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('owner, admin or sales')) {
    return 'You do not have permission to manage contacts. This requires an Owner, Admin or Sales role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function normalise(c) {
  if (!c) return null;
  return {
    id: c.id,
    customerId: c.customer_id,
    firstName: c.first_name,
    lastName: c.last_name,
    jobTitle: c.job_title,
    email: c.email,
    phone: c.phone,
    mobile: c.mobile,
    isPrimary: c.is_primary,
    isActive: c.is_active,
    notes: c.notes,
    ownerId: c.owner_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

const SELECT =
  'id, customer_id, first_name, last_name, job_title, email, phone, mobile, ' +
  'is_primary, is_active, notes, owner_id, created_at, updated_at';

function cleanText(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Fetch a customer's contacts (active-org scoped). Includes inactive by default
 * so the profile can show the full picture; pass { activeOnly: true } to limit.
 * @param {string} customerId
 * @param {{ activeOnly?: boolean }} [options]
 */
export async function getContactsByCustomer(customerId, options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId || !customerId) return { data: [], error: null };

  let query = supabase
    .from('customer_contacts')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('customer_id', customerId);

  if (options.activeOnly) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('is_primary', { ascending: false })
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getContact(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('customer_contacts').select(SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Create a contact under a customer. Sets org_id = active org, owner_id = the
 * authenticated user. If isPrimary is requested, the DB index enforces one
 * active primary — to swap safely, create as non-primary then call
 * setPrimaryContact (the page handles this). Here we honour isPrimary only when
 * no conflict is expected; a conflict surfaces as a friendly error.
 */
export async function createContact(customerId, input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!customerId) return { data: null, error: { message: 'A customer is required.' } };

  const firstName = (input.firstName || '').trim();
  const lastName = (input.lastName || '').trim();
  if (!firstName) return { data: null, error: { message: 'A first name is required.' } };
  if (!lastName) return { data: null, error: { message: 'A last name is required.' } };
  const email = cleanText(input.email);
  if (email && !EMAIL_RE.test(email)) return { data: null, error: { message: 'Enter a valid email address.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    customer_id: customerId,
    first_name: firstName,
    last_name: lastName,
    job_title: cleanText(input.jobTitle),
    email,
    phone: cleanText(input.phone),
    mobile: cleanText(input.mobile),
    is_primary: Boolean(input.isPrimary),
    notes: cleanText(input.notes),
  };

  const { data, error } = await supabase.from('customer_contacts').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a contact's editable fields. id/org_id/owner_id/customer_id never
 * change. is_primary is NOT toggled here — use setPrimaryContact (atomic RPC)
 * or deactivate/reactivate.
 */
export async function updateContact(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.firstName !== undefined) {
    const firstName = (input.firstName || '').trim();
    if (!firstName) return { data: null, error: { message: 'A first name is required.' } };
    row.first_name = firstName;
  }
  if (input.lastName !== undefined) {
    const lastName = (input.lastName || '').trim();
    if (!lastName) return { data: null, error: { message: 'A last name is required.' } };
    row.last_name = lastName;
  }
  if (input.email !== undefined) {
    const email = cleanText(input.email);
    if (email && !EMAIL_RE.test(email)) return { data: null, error: { message: 'Enter a valid email address.' } };
    row.email = email;
  }
  if (input.jobTitle !== undefined) row.job_title = cleanText(input.jobTitle);
  if (input.phone !== undefined) row.phone = cleanText(input.phone);
  if (input.mobile !== undefined) row.mobile = cleanText(input.mobile);
  if (input.notes !== undefined) row.notes = cleanText(input.notes);
  // is_primary / is_active / org_id / owner_id / customer_id intentionally not writable here.

  const { data, error } = await supabase
    .from('customer_contacts').update(row).eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deactivateContact(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  // Deactivating also drops the primary flag so the "one active primary" slot
  // is freed (a retired contact should not hold the primary slot).
  const { data, error } = await supabase
    .from('customer_contacts').update({ is_active: false, is_primary: false })
    .eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function reactivateContact(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('customer_contacts').update({ is_active: true })
    .eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Atomically make a contact the customer's primary (clears the current active
 * primary and sets this one in one transaction) via the SECURITY DEFINER RPC.
 */
export async function setPrimaryContact(id) {
  if (!id) return { data: null, error: { message: 'A contact is required.' } };
  const { data, error } = await supabase.rpc('set_primary_customer_contact', { p_contact_id: id });
  if (error) return { data: null, error };
  const r = Array.isArray(data) ? data[0] : data;
  return { data: normalise(r), error: null };
}
