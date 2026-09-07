import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Finance Service. RLS-scoped to the authenticated user.
// Schema: supabase/migrations/005_phase1_modules.sql
// ─────────────────────────────────────────────────────────────────────────────

export const FINANCE_TYPES = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' },
];

export const FINANCE_CATEGORIES = [
  { value: 'sales', label: 'Sales' },
  { value: 'labour', label: 'Labour' },
  { value: 'materials', label: 'Materials' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'chemicals', label: 'Chemicals' },
  { value: 'services', label: 'Services' },
  { value: 'other', label: 'Other' },
];

export function friendlyFinanceError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The finance database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) return 'The selected vineyard or block could not be found.';
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) return 'Network error. Please check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

function normalise(f) {
  if (!f) return null;
  return {
    id: f.id,
    vineyardId: f.vineyard_id,
    blockId: f.block_id,
    title: f.title,
    type: f.type,
    category: f.category,
    amount: f.amount,
    entryDate: f.entry_date,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    vineyardName: f.vineyard ? f.vineyard.name : null,
    blockName: f.block ? f.block.name : null,
  };
}

const SELECT =
  'id, vineyard_id, block_id, title, type, category, amount, entry_date, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

export async function getFinanceRecords() {
  const { data, error } = await supabase
    .from('finance').select(SELECT)
    .order('entry_date', { ascending: false, nullsFirst: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

export async function getFinanceRecord(id) {
  const { data, error } = await supabase.from('finance').select(SELECT).eq('id', id).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function createFinanceRecord(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { data: null, error: userError || { message: 'Not authenticated' } };
  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId || null,
    block_id: input.blockId || null,
    title: input.title,
    type: input.type || 'expense',
    category: input.category || null,
    amount: input.amount ?? 0,
    entry_date: input.entryDate || null,
  };
  const { data, error } = await supabase.from('finance').insert(row).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function updateFinanceRecord(id, input) {
  const row = {
    vineyard_id: input.vineyardId || null,
    block_id: input.blockId || null,
    title: input.title,
    type: input.type,
    category: input.category || null,
    amount: input.amount ?? 0,
    entry_date: input.entryDate || null,
  };
  const { data, error } = await supabase.from('finance').update(row).eq('id', id).select(SELECT).single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

export async function deleteFinanceRecord(id) {
  const { error } = await supabase.from('finance').delete().eq('id', id);
  return { error };
}

/**
 * Compute income / expense / net totals from a normalised record list.
 * @param {Array} records
 * @returns {{ income: number, expense: number, net: number }}
 */
export function computeTotals(records) {
  let income = 0;
  let expense = 0;
  (records || []).forEach((r) => {
    const amt = Number(r.amount) || 0;
    if ((r.type || '').toLowerCase() === 'income') income += amt;
    else expense += amt;
  });
  return { income, expense, net: income - expense };
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
