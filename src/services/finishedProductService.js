import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Finished Product Service (P2K-2)
// A finished product is an org-scoped, reusable, sellable finished-wine IDENTITY
// (a catalogue SKU). It is NOT a bottling event: the same product may be used by
// many bottling outputs across multiple runs. Products are added on demand (no
// seed catalogue) and RETIRED via is_active = false — there is NO delete path
// (history must be preserved; later stock movements will reference products).
// sku_code is unique per organisation CASE-INSENSITIVELY.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes) —
// RLS remains authoritative. Creates set org_id = active org and owner_id = the
// authenticated user; neither is taken from the UI. This service does NOT touch
// stock, locations, movements or any P2K-3+ concern.
// Schema: supabase/migrations/038_finished_products.sql
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyFinishedProductError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The finished products database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A product with this SKU code already exists in this organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('vintage')) return 'Please enter a valid vintage year (1900–2200).';
    if (msg.includes('bottle_volume')) return 'Bottle volume (ml) must be greater than zero.';
    if (msg.includes('bottles_per_case')) return 'Bottles per case must be greater than zero.';
    if (msg.includes('packaging')) return 'A packaging format is required.';
    return 'Please provide a SKU code, name, bottle volume and packaging format.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage finished products. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw finished_products row into camelCase.
function normalise(p) {
  if (!p) return null;
  return {
    id: p.id,
    skuCode: p.sku_code,
    name: p.name,
    vintage: p.vintage,
    bottleVolumeMl: p.bottle_volume_ml,
    packagingFormat: p.packaging_format,
    wineStyle: p.wine_style,
    bottlesPerCase: p.bottles_per_case,
    isActive: p.is_active,
    notes: p.notes,
    ownerId: p.owner_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const SELECT =
  'id, sku_code, name, vintage, bottle_volume_ml, packaging_format, wine_style, ' +
  'bottles_per_case, is_active, notes, owner_id, created_at, updated_at';

// ── Shared input helpers ─────────────────────────────────────────────────────

function intOrNull(v) {
  return v === undefined || v === null || v === '' ? null : Number(v);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's finished products. Active products only by
 * default; pass { includeInactive: true } to include retired products. Optional
 * client-side search (sku_code / name) and vintage filter. Ordered by name, SKU.
 * @param {{ includeInactive?: boolean, search?: string, vintage?: number|string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getFinishedProducts(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('finished_products')
    .select(SELECT)
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);
  if (options.vintage !== undefined && options.vintage !== null && options.vintage !== '') {
    query = query.eq('vintage', Number(options.vintage));
  }

  const { data, error } = await query
    .order('name', { ascending: true })
    .order('sku_code', { ascending: true });

  if (error) return { data: null, error };

  let rows = (data || []).map(normalise);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      (p.skuCode || '').toLowerCase().includes(q) ||
      (p.name || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single finished product by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getFinishedProduct(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('finished_products')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Lightweight product options for future selectors (e.g. P2K-5 Receive Finished
 * Goods). Active-org scoped; active products only by default. When editing a
 * record whose product has since been retired, pass { includeId } to fold that
 * one inactive product in so it still renders.
 * @param {{ includeInactive?: boolean, includeId?: string|null }} [options]
 * @returns {Promise<{ data: Array<{ id, skuCode, name, vintage, bottleVolumeMl, packagingFormat, isActive }>|null, error: object|null }>}
 */
export async function getFinishedProductOptions(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('finished_products')
    .select('id, sku_code, name, vintage, bottle_volume_ml, packaging_format, is_active')
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('name', { ascending: true })
    .order('sku_code', { ascending: true });

  if (error) return { data: null, error };

  const toOption = (p) => ({
    id: p.id,
    skuCode: p.sku_code,
    name: p.name,
    vintage: p.vintage,
    bottleVolumeMl: p.bottle_volume_ml,
    packagingFormat: p.packaging_format,
    isActive: p.is_active,
  });

  const list = (data || []).map(toOption);

  if (options.includeId && !list.some((o) => o.id === options.includeId)) {
    const { data: extra, error: extraError } = await supabase
      .from('finished_products')
      .select('id, sku_code, name, vintage, bottle_volume_ml, packaging_format, is_active')
      .eq('id', options.includeId)
      .eq('org_id', orgId)
      .single();
    if (!extraError && extra) list.push(toOption(extra));
  }

  return { data: list, error: null };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a finished product in the active organisation. Sets org_id = active org
 * and owner_id = the authenticated user (never from the payload). is_active
 * defaults to true. SKU uniqueness (case-insensitive, per org) is DB-enforced.
 * @param {{ skuCode: string, name: string, vintage?: number|string|null,
 *   bottleVolumeMl: number|string, packagingFormat: string, wineStyle?: string|null,
 *   bottlesPerCase?: number|string|null, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createFinishedProduct(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const skuCode = (input.skuCode || '').trim();
  const name = (input.name || '').trim();
  const packagingFormat = (input.packagingFormat || '').trim();
  const bottleVolumeMl = intOrNull(input.bottleVolumeMl);
  const vintage = intOrNull(input.vintage);
  const bottlesPerCase = intOrNull(input.bottlesPerCase);

  if (!skuCode) return { data: null, error: { message: 'A SKU code is required.' } };
  if (!name) return { data: null, error: { message: 'A product name is required.' } };
  if (bottleVolumeMl === null || !Number.isFinite(bottleVolumeMl) || bottleVolumeMl <= 0) {
    return { data: null, error: { message: 'Bottle volume (ml) must be greater than zero.' } };
  }
  if (!packagingFormat) return { data: null, error: { message: 'A packaging format is required.' } };
  if (vintage !== null && (!Number.isInteger(vintage) || vintage < 1900 || vintage > 2200)) {
    return { data: null, error: { message: 'Vintage must be a whole year between 1900 and 2200.' } };
  }
  if (bottlesPerCase !== null && (!Number.isInteger(bottlesPerCase) || bottlesPerCase <= 0)) {
    return { data: null, error: { message: 'Bottles per case must be a whole number greater than zero.' } };
  }

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    sku_code: skuCode,
    name,
    vintage,
    bottle_volume_ml: bottleVolumeMl,
    packaging_format: packagingFormat,
    wine_style: input.wineStyle ? input.wineStyle.trim() : null,
    bottles_per_case: bottlesPerCase,
    notes: input.notes ? input.notes.trim() : null,
    // is_active intentionally omitted — DB default is TRUE.
  };

  const { data, error } = await supabase
    .from('finished_products')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a finished product's editable fields (active-org scoped). id, org_id and
 * owner_id are NEVER changed here (owner_id immutability is also DB-enforced).
 * is_active is NOT changed here — use deactivate/reactivate.
 * @param {string} id
 * @param {{ skuCode?: string, name?: string, vintage?: number|string|null,
 *   bottleVolumeMl?: number|string, packagingFormat?: string, wineStyle?: string|null,
 *   bottlesPerCase?: number|string|null, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateFinishedProduct(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.skuCode !== undefined) {
    const skuCode = (input.skuCode || '').trim();
    if (!skuCode) return { data: null, error: { message: 'A SKU code is required.' } };
    row.sku_code = skuCode;
  }
  if (input.name !== undefined) {
    const name = (input.name || '').trim();
    if (!name) return { data: null, error: { message: 'A product name is required.' } };
    row.name = name;
  }
  if (input.bottleVolumeMl !== undefined) {
    const bottleVolumeMl = intOrNull(input.bottleVolumeMl);
    if (bottleVolumeMl === null || !Number.isFinite(bottleVolumeMl) || bottleVolumeMl <= 0) {
      return { data: null, error: { message: 'Bottle volume (ml) must be greater than zero.' } };
    }
    row.bottle_volume_ml = bottleVolumeMl;
  }
  if (input.packagingFormat !== undefined) {
    const packagingFormat = (input.packagingFormat || '').trim();
    if (!packagingFormat) return { data: null, error: { message: 'A packaging format is required.' } };
    row.packaging_format = packagingFormat;
  }
  if (input.vintage !== undefined) {
    const vintage = intOrNull(input.vintage);
    if (vintage !== null && (!Number.isInteger(vintage) || vintage < 1900 || vintage > 2200)) {
      return { data: null, error: { message: 'Vintage must be a whole year between 1900 and 2200.' } };
    }
    row.vintage = vintage;
  }
  if (input.bottlesPerCase !== undefined) {
    const bottlesPerCase = intOrNull(input.bottlesPerCase);
    if (bottlesPerCase !== null && (!Number.isInteger(bottlesPerCase) || bottlesPerCase <= 0)) {
      return { data: null, error: { message: 'Bottles per case must be a whole number greater than zero.' } };
    }
    row.bottles_per_case = bottlesPerCase;
  }
  if (input.wineStyle !== undefined) row.wine_style = input.wineStyle ? input.wineStyle.trim() : null;
  if (input.notes !== undefined) row.notes = input.notes ? input.notes.trim() : null;
  // is_active / org_id / owner_id intentionally NOT writable here.

  const { data, error } = await supabase
    .from('finished_products')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Retire a finished product (soft-delete). Sets is_active = false; never deletes.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivateFinishedProduct(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('finished_products')
    .update({ is_active: false })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Re-activate a previously retired finished product. Sets is_active = true.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateFinishedProduct(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('finished_products')
    .update({ is_active: true })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// NOTE: there is intentionally NO deleteFinishedProduct() — products are retired
// via deactivateFinishedProduct (is_active = false), never hard-deleted.
