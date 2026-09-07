import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Machinery Service. RLS-scoped to the authenticated user.
// Schema: supabase/migrations/005_phase1_modules.sql
// ─────────────────────────────────────────────────────────────────────────────

export const MACHINERY_STATUSES = [
  { value: 'operational', label: 'Operational' },
  { value: 'maintenance', label: 'In Maintenance' },
  { value: 'out_of_service', label: 'Out of Service' },
  { value: 'retired', label: 'Retired' },
];

export const MACHINERY_CATEGORIES = [
  { value: 'tractor', label: 'Tractor' },
  { value: 'sprayer', label: 'Sprayer' },
  { value: 'harvester', label: 'Harvester' },
  { value: 'trailer', label: 'Trailer' },
  { value: 'irrigation', label: 'Irrigation Equipment' },
  { value: 'other', label: 'Other' },
];

export function friendlyMachineryError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The machinery database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) return 'The selected vineyard could not be found.';
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) return 'Network error. Please check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

function normalise(m) {
  if (!m) return null;
  return {
    id: m.id,
    vineyardId: m.vineyard_id,
    name: m.name,
    category: m.category,
    registration: m.registration,
    status: m.status,
    lastServiceDate: m.last_service_date,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    vineyardName: m.vineyard ? m.vineyard.name : null,
  };
}

const SELECT =
  'id, vineyard_id, name, category, registration, status, last_service_date, created_at, updated_at, ' +
  'vineyard:vineyards(id, name)';

export async function getMachinery() {
  const { data, error } = await supabase.from('machinery').select(SELECT).order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getMachineryItem(id) {
  const { data, error } = await supabase.from('machinery').select(SELECT).eq('id', id).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createMachinery(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId || null,
    name: input.name,
    category: input.category || null,
    registration: input.registration || null,
    status: input.status || 'operational',
    last_service_date: input.lastServiceDate || null,
  };
  const { data, error } = await supabase.from('machinery').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function updateMachinery(id, input) {
  const row = {
    vineyard_id: input.vineyardId || null,
    name: input.name,
    category: input.category || null,
    registration: input.registration || null,
    status: input.status,
    last_service_date: input.lastServiceDate || null,
  };
  const { data, error } = await supabase.from('machinery').update(row).eq('id', id).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deleteMachinery(id) {
  const { error } = await supabase.from('machinery').delete().eq('id', id);
  return { error };
}

export async function getVineyardOptions() {
  const { data, error } = await supabase.from('vineyards').select('id, name').order('name', { ascending: true });
  if (error) return { data: null, error };
  return { data: data || [], error: null };
}
