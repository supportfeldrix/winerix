import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Harvest Service
// Data access for harvest records. RLS-scoped to the authenticated user.
// Schema: supabase/migrations/005_phase1_modules.sql
// ─────────────────────────────────────────────────────────────────────────────

export const HARVEST_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function friendlyHarvestError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The harvest database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected planting belongs to a different organisation.';
  }
  if (msg.includes('block mismatch')) {
    return 'The selected planting does not belong to the selected block.';
  }
  if (msg.includes('invalid planting')) return 'The selected planting could not be found.';
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard, block or planting could not be found. Please choose valid options.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function normalise(h) {
  if (!h) return null;
  const planting = h.planting || null;
  const plantingCultivar = planting && planting.cultivar ? planting.cultivar : null;
  return {
    id: h.id,
    vineyardId: h.vineyard_id,
    blockId: h.block_id,
    plantingId: h.planting_id,
    title: h.title,
    status: h.status,
    harvestDate: h.harvest_date,
    yieldTons: h.yield_tons,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    vineyardName: h.vineyard ? h.vineyard.name : null,
    blockName: h.block ? h.block.name : null,
    // Planting + its cultivar (derived; cultivar is never stored on harvest).
    // Resolves even for a now-inactive planting so historical harvests display.
    plantingStatus: planting ? planting.status : null,
    plantingYear: planting ? planting.planting_year : null,
    cultivarId: plantingCultivar ? plantingCultivar.id : null,
    cultivarName: plantingCultivar ? plantingCultivar.name : null,
    cultivarColour: plantingCultivar ? plantingCultivar.colour : null,
  };
}

const SELECT =
  'id, vineyard_id, block_id, planting_id, title, status, harvest_date, yield_tons, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name), ' +
  'planting:plantings(id, status, planting_year, cultivar:cultivars(id, name, colour))';

export async function getHarvests() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('harvest')
    .select(SELECT)
    .eq('org_id', orgId)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvestsByVineyard(vineyardId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('harvest').select(SELECT).eq('vineyard_id', vineyardId).eq('org_id', orgId)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvestsByBlock(blockId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('harvest').select(SELECT).eq('block_id', blockId).eq('org_id', orgId)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvest(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase.from('harvest').select(SELECT).eq('id', id).eq('org_id', orgId).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createHarvest(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) {
    return { data: null, error: { message: 'No active organisation' } };
  }
  const row = {
    owner_id: userData.user.id,
    org_id: orgId,
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    planting_id: input.plantingId || null,
    title: input.title,
    status: input.status || 'planned',
    harvest_date: input.harvestDate || null,
    yield_tons: input.yieldTons ?? null,
  };
  const { data, error } = await supabase.from('harvest').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function updateHarvest(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const row = {
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    planting_id: input.plantingId || null,
    title: input.title,
    status: input.status,
    harvest_date: input.harvestDate || null,
    yield_tons: input.yieldTons ?? null,
  };
  const { data, error } = await supabase.from('harvest').update(row).eq('id', id).eq('org_id', orgId).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deleteHarvest(id) {
  const { error } = await supabase.from('harvest').delete().eq('id', id);
  return { error };
}

export async function getVineyardOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase.from('vineyards').select('id, name').eq('org_id', orgId).order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: data || [], error: null };
}

export async function getBlockOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase.from('blocks').select('id, name, vineyard_id').eq('org_id', orgId).order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map((b) => ({ id: b.id, name: b.name, vineyardId: b.vineyard_id })), error: null };
}

/**
 * Load ACTIVE plantings for a block as options for the harvest form's planting
 * selector, each with its derived cultivar. Organisation-scoped; returns only
 * active plantings (for new harvests). The harvest form merges an existing
 * (possibly inactive) planting for edit mode so historical harvests display.
 * @param {string} blockId
 * @returns {Promise<{ data: Array<{ id, cultivarName, cultivarColour, plantingYear }>|null, error: object|null }>}
 */
export async function getPlantingOptionsByBlock(blockId) {
  const orgId = getActiveOrgId();
  if (!orgId || !blockId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('plantings')
    .select('id, planting_year, status, cultivar:cultivars(id, name, colour)')
    .eq('org_id', orgId)
    .eq('block_id', blockId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) return { data: null, error };
  return {
    data: (data || []).map((p) => ({
      id: p.id,
      plantingYear: p.planting_year,
      cultivarId: p.cultivar ? p.cultivar.id : null,
      cultivarName: p.cultivar ? p.cultivar.name : null,
      cultivarColour: p.cultivar ? p.cultivar.colour : null,
    })),
    error: null,
  };
}
