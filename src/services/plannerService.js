import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Planner Service. RLS-scoped to the authenticated user.
// Schema: supabase/migrations/005_phase1_modules.sql
// ─────────────────────────────────────────────────────────────────────────────

export const PLANNER_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function friendlyPlannerError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The planner database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) return 'The selected vineyard or block could not be found.';
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) return 'Network error. Please check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

function normalise(t) {
  if (!t) return null;
  return {
    id: t.id,
    vineyardId: t.vineyard_id,
    blockId: t.block_id,
    title: t.title,
    status: t.status,
    dueDate: t.due_date,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    vineyardName: t.vineyard ? t.vineyard.name : null,
    blockName: t.block ? t.block.name : null,
  };
}

const SELECT =
  'id, vineyard_id, block_id, title, status, due_date, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

export async function getPlannerTasks() {
  const { data, error } = await supabase
    .from('planner').select(SELECT)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getPlannerTask(id) {
  const { data, error } = await supabase.from('planner').select(SELECT).eq('id', id).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createPlannerTask(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId || null,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status || 'pending',
    due_date: input.dueDate || null,
  };
  const { data, error } = await supabase.from('planner').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function updatePlannerTask(id, input) {
  const row = {
    vineyard_id: input.vineyardId || null,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status,
    due_date: input.dueDate || null,
  };
  const { data, error } = await supabase.from('planner').update(row).eq('id', id).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deletePlannerTask(id) {
  const { error } = await supabase.from('planner').delete().eq('id', id);
  return { error };
}

/**
 * Upcoming, not-yet-finished tasks with a due date (soonest first).
 * @param {Array} tasks - normalised planner tasks
 * @param {number} [limit]
 */
export function upcomingTasks(tasks, limit = 5) {
  const active = (tasks || []).filter(
    (t) => t.dueDate && !['completed', 'cancelled'].includes((t.status || '').toLowerCase())
  );
  active.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  return typeof limit === 'number' ? active.slice(0, limit) : active;
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
