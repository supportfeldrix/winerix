import { supabase } from './supabase';

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
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard or block could not be found. Please choose valid options.';
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
  return {
    id: h.id,
    vineyardId: h.vineyard_id,
    blockId: h.block_id,
    title: h.title,
    status: h.status,
    harvestDate: h.harvest_date,
    yieldTons: h.yield_tons,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    vineyardName: h.vineyard ? h.vineyard.name : null,
    blockName: h.block ? h.block.name : null,
  };
}

const SELECT =
  'id, vineyard_id, block_id, title, status, harvest_date, yield_tons, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

export async function getHarvests() {
  const { data, error } = await supabase
    .from('harvest')
    .select(SELECT)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvestsByVineyard(vineyardId) {
  const { data, error } = await supabase
    .from('harvest').select(SELECT).eq('vineyard_id', vineyardId)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvestsByBlock(blockId) {
  const { data, error } = await supabase
    .from('harvest').select(SELECT).eq('block_id', blockId)
    .order('harvest_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getHarvest(id) {
  const { data, error } = await supabase.from('harvest').select(SELECT).eq('id', id).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createHarvest(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
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
  const row = {
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status,
    harvest_date: input.harvestDate || null,
    yield_tons: input.yieldTons ?? null,
  };
  const { data, error } = await supabase.from('harvest').update(row).eq('id', id).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deleteHarvest(id) {
  const { error } = await supabase.from('harvest').delete().eq('id', id);
  return { error };
}

export async function getVineyardOptions() {
  const { data, error } = await supabase.from('vineyards').select('id, name').order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: data || [], error: null };
}

export async function getBlockOptions() {
  const { data, error } = await supabase.from('blocks').select('id, name, vineyard_id').order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map((b) => ({ id: b.id, name: b.name, vineyardId: b.vineyard_id })), error: null };
}
