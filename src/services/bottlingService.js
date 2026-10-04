import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';
import { getWineLots } from './wineLotService';
import { getLabSamples } from './labSampleService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Service (P2J-B3, data layer only)
//
// Reads/writes the bottling foundation tables (migration 034):
//     bottling_runs -> bottling_run_lots -> bottling_outputs
// This is CONFIGURATION / PLANNING data. It performs NO volume accounting:
// it NEVER modifies wine_lots.volume_litres, NEVER inserts lot_volume_movements,
// NEVER creates production_events, and calls NO completion RPC. The atomic
// bottling operation (volume deduction + movements + event + reconciliation)
// is P2J-B4 (complete_bottling_run), not this service.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes).
// Creates set org_id = active org and owner_id = the authenticated user; neither
// is taken from the caller. { data, error } convention, camelCase, friendly errors.
// Schema: supabase/migrations/034_bottling_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export const BOTTLING_RUN_STATUSES = Object.freeze([
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]);

export function bottlingRunStatusLabel(status) {
  const found = BOTTLING_RUN_STATUSES.find((s) => s.value === status);
  return found ? found.label : status || '—';
}

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyBottlingError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The bottling database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    if (msg.includes('uq_brl_run_lot') || details.includes('uq_brl_run_lot')) {
      return 'This wine lot is already a source for this bottling run.';
    }
    return 'A bottling run with this code already exists in this organisation.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected wine lot, bottling run or lab sample belongs to a different organisation.';
  }
  if (msg.includes('invalid wine lot')) return 'The wine lot could not be found.';
  if (msg.includes('invalid bottling run')) return 'The bottling run could not be found.';
  if (msg.includes('invalid release lab sample')) return 'The selected lab sample could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('brl_accounted_within_consumed') || details.includes('brl_accounted_within_consumed')) {
      return 'Bottled plus loss litres cannot exceed the consumed source volume.';
    }
    if (msg.includes('status')) return 'Please choose a valid bottling run status.';
    if (msg.includes('vintage')) return 'Please enter a valid vintage year (1900–2200).';
    return 'Please provide valid values (volumes and counts must be non-negative).';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'A referenced wine lot, bottling run or lab sample could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage bottling. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ──────────────────────────────────────────────────────────────

function normaliseRun(r) {
  if (!r) return null;
  const sample = r.release_lab_sample || null;
  return {
    id: r.id,
    bottlingCode: r.bottling_code,
    bottlingDate: r.bottling_date,
    status: r.status,
    notes: r.notes,
    releaseLabSampleId: r.release_lab_sample_id,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Derived context (read-only).
    releaseLabSampleCode: sample ? sample.sample_code : null,
  };
}

function normaliseRunLot(l) {
  if (!l) return null;
  const lot = l.wine_lot || null;
  const batch = lot && lot.wine_batch ? lot.wine_batch : null;
  return {
    id: l.id,
    bottlingRunId: l.bottling_run_id,
    wineLotId: l.wine_lot_id,
    consumedVolumeLitres: l.consumed_volume_litres,
    bottledLitres: l.bottled_litres,
    lossLitres: l.loss_litres,
    notes: l.notes,
    ownerId: l.owner_id,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    // Derived context via existing relationships (nothing duplicated).
    lotCode: lot ? lot.lot_code : null,
    lotStatus: lot ? lot.status : null,
    lotVolumeLitres: lot ? lot.volume_litres : null, // current lot volume (display only — NOT reduced by this planned allocation)
    batchCode: batch ? batch.batch_code : null,
    batchVintage: batch ? batch.vintage : null,
  };
}

function normaliseOutput(o) {
  if (!o) return null;
  return {
    id: o.id,
    bottlingRunId: o.bottling_run_id,
    bottleVolumeMl: o.bottle_volume_ml,
    bottleCount: o.bottle_count,
    bottledLitres: o.bottled_litres,
    packagingFormat: o.packaging_format,
    productName: o.product_name,
    vintage: o.vintage,
    notes: o.notes,
    ownerId: o.owner_id,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

const RUN_SELECT =
  'id, bottling_code, bottling_date, status, notes, release_lab_sample_id, owner_id, created_at, updated_at, ' +
  'release_lab_sample:lab_samples(id, sample_code)';

const RUN_LOT_SELECT =
  'id, bottling_run_id, wine_lot_id, consumed_volume_litres, bottled_litres, loss_litres, notes, owner_id, created_at, updated_at, ' +
  'wine_lot:wine_lots(id, lot_code, status, volume_litres, wine_batch:wine_batches(id, batch_code, vintage))';

const OUTPUT_SELECT =
  'id, bottling_run_id, bottle_volume_ml, bottle_count, bottled_litres, packaging_format, product_name, vintage, notes, owner_id, created_at, updated_at';

// ── Shared validation helpers (DB constraints remain authoritative) ──────────

function isNonNegativeNumber(v) {
  return v === undefined || v === null || v === '' ? true : (Number.isFinite(Number(v)) && Number(v) >= 0);
}

function numOrNull(v) {
  return v === undefined || v === null || v === '' ? null : Number(v);
}

function numOrDefault(v, dflt) {
  return v === undefined || v === null || v === '' ? dflt : Number(v);
}

// ── Bottling run reads ───────────────────────────────────────────────────────

/**
 * Fetch the active organisation's bottling runs, newest first.
 * Options: status, search (bottling_code / notes, client-side), limit,
 * dateFrom / dateTo (inclusive, on bottling_date).
 * @param {{ status?: string, search?: string, limit?: number, dateFrom?: string, dateTo?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBottlingRuns(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('bottling_runs')
    .select(RUN_SELECT)
    .eq('org_id', orgId);

  if (options.status) query = query.eq('status', options.status);
  if (options.dateFrom) query = query.gte('bottling_date', options.dateFrom);
  if (options.dateTo) query = query.lte('bottling_date', options.dateTo);

  query = query.order('bottling_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) return { data: null, error };

  let rows = (data || []).map(normaliseRun);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      (r.bottlingCode || '').toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single bottling run by id (active-org scoped), with basic context.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getBottlingRun(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('bottling_runs')
    .select(RUN_SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseRun(data), error: null };
}

/**
 * Fetch the source Wine Lot allocations for a bottling run (active-org scoped),
 * with lot + basic batch context.
 * @param {string} bottlingRunId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBottlingRunLots(bottlingRunId) {
  const orgId = getActiveOrgId();
  if (!orgId || !bottlingRunId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('bottling_run_lots')
    .select(RUN_LOT_SELECT)
    .eq('org_id', orgId)
    .eq('bottling_run_id', bottlingRunId)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseRunLot), error: null };
}

/**
 * Fetch the output lines for a bottling run (active-org scoped). Bottling
 * outputs are NOT finished-goods inventory.
 * @param {string} bottlingRunId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBottlingOutputs(bottlingRunId) {
  const orgId = getActiveOrgId();
  if (!orgId || !bottlingRunId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('bottling_outputs')
    .select(OUTPUT_SELECT)
    .eq('org_id', orgId)
    .eq('bottling_run_id', bottlingRunId)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseOutput), error: null };
}

// ── Bottling run writes ──────────────────────────────────────────────────────

/**
 * Create a bottling run in the active organisation. Sets org_id = active org,
 * owner_id = the authenticated user. status defaults to 'planned' (the DB
 * default) — the caller cannot set a different status here (lifecycle is
 * controlled later). Creates NO source lots or outputs.
 * @param {{ bottlingCode: string, bottlingDate?: string|null, notes?: string|null,
 *   releaseLabSampleId?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createBottlingRun(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const code = (input.bottlingCode || '').trim();
  if (!code) return { data: null, error: { message: 'A bottling code is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    bottling_code: code,
    bottling_date: input.bottlingDate || null,
    notes: input.notes || null,
    release_lab_sample_id: input.releaseLabSampleId || null,
    // status intentionally omitted -> DB default 'planned'.
  };

  const { data, error } = await supabase
    .from('bottling_runs')
    .insert(row)
    .select(RUN_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseRun(data), error: null };
}

/**
 * Update a bottling run's safe header fields (active-org scoped). org_id,
 * owner_id and status are NEVER changed here (status transitions belong to the
 * future controlled workflow; owner immutability is also DB-enforced). Does not
 * touch source volumes, outputs, Wine Lot volume, movements, or events.
 * @param {string} id
 * @param {{ bottlingCode?: string, bottlingDate?: string|null, notes?: string|null,
 *   releaseLabSampleId?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateBottlingRun(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.bottlingCode !== undefined) {
    const code = (input.bottlingCode || '').trim();
    if (!code) return { data: null, error: { message: 'A bottling code is required.' } };
    row.bottling_code = code;
  }
  if (input.bottlingDate !== undefined) row.bottling_date = input.bottlingDate || null;
  if (input.notes !== undefined) row.notes = input.notes || null;
  if (input.releaseLabSampleId !== undefined) row.release_lab_sample_id = input.releaseLabSampleId || null;
  // status / org_id / owner_id intentionally NOT writable here.

  const { data, error } = await supabase
    .from('bottling_runs')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(RUN_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseRun(data), error: null };
}

// ── Source lot allocation (PLANNING ONLY — no volume accounting) ─────────────

/**
 * Add a source Wine Lot allocation to a bottling run. PLANNING DATA ONLY — this
 * does NOT deduct Wine Lot volume, insert lot_volume_movements, create
 * production_events, or reconcile volume. The DB CHECK
 * (bottled + loss <= consumed) and the cross-org trigger are the first
 * validation layer; the authoritative availability/accounting is P2J-B4.
 * @param {{ bottlingRunId: string, wineLotId: string, consumedVolumeLitres: number,
 *   bottledLitres?: number, lossLitres?: number, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function addBottlingRunLot(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.bottlingRunId) return { data: null, error: { message: 'A bottling run is required.' } };
  if (!input.wineLotId) return { data: null, error: { message: 'A wine lot is required.' } };
  if (!isNonNegativeNumber(input.consumedVolumeLitres) || numOrNull(input.consumedVolumeLitres) === null) {
    return { data: null, error: { message: 'Consumed volume must be a non-negative number.' } };
  }
  if (!isNonNegativeNumber(input.bottledLitres)) return { data: null, error: { message: 'Bottled litres must be non-negative.' } };
  if (!isNonNegativeNumber(input.lossLitres)) return { data: null, error: { message: 'Loss litres must be non-negative.' } };

  const consumed = numOrDefault(input.consumedVolumeLitres, 0);
  const bottled = numOrDefault(input.bottledLitres, 0);
  const loss = numOrDefault(input.lossLitres, 0);
  if (bottled + loss > consumed) {
    return { data: null, error: { message: 'Bottled plus loss litres cannot exceed the consumed source volume.' } };
  }

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    bottling_run_id: input.bottlingRunId,
    wine_lot_id: input.wineLotId,
    consumed_volume_litres: consumed,
    bottled_litres: bottled,
    loss_litres: loss,
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('bottling_run_lots')
    .insert(row)
    .select(RUN_LOT_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseRunLot(data), error: null };
}

/**
 * Update a source lot allocation's planning values (active-org scoped). id,
 * org_id, owner_id, bottling_run_id and wine_lot_id are NEVER changed here.
 * No volume mutation, movements, or events. Validates the merged
 * bottled + loss <= consumed rule for a friendly message (DB also enforces).
 * @param {string} id
 * @param {{ consumedVolumeLitres?: number, bottledLitres?: number,
 *   lossLitres?: number, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateBottlingRunLot(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Load current to validate the merged final state against the DB rule.
  if (input.consumedVolumeLitres !== undefined || input.bottledLitres !== undefined || input.lossLitres !== undefined) {
    const { data: current, error: curErr } = await supabase
      .from('bottling_run_lots')
      .select('consumed_volume_litres, bottled_litres, loss_litres')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (curErr) return { data: null, error: curErr };
    if (!current) return { data: null, error: { message: 'Source allocation not found.' } };

    const consumed = input.consumedVolumeLitres !== undefined ? numOrDefault(input.consumedVolumeLitres, 0) : Number(current.consumed_volume_litres);
    const bottled = input.bottledLitres !== undefined ? numOrDefault(input.bottledLitres, 0) : Number(current.bottled_litres);
    const loss = input.lossLitres !== undefined ? numOrDefault(input.lossLitres, 0) : Number(current.loss_litres);
    if ([consumed, bottled, loss].some((v) => !Number.isFinite(v) || v < 0)) {
      return { data: null, error: { message: 'Volumes must be non-negative numbers.' } };
    }
    if (bottled + loss > consumed) {
      return { data: null, error: { message: 'Bottled plus loss litres cannot exceed the consumed source volume.' } };
    }
  }

  const row = {};
  if (input.consumedVolumeLitres !== undefined) row.consumed_volume_litres = numOrDefault(input.consumedVolumeLitres, 0);
  if (input.bottledLitres !== undefined) row.bottled_litres = numOrDefault(input.bottledLitres, 0);
  if (input.lossLitres !== undefined) row.loss_litres = numOrDefault(input.lossLitres, 0);
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('bottling_run_lots')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(RUN_LOT_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseRunLot(data), error: null };
}

// NOTE: there is intentionally NO deleteBottlingRunLot() — bottling is
// auditable operational data and 034 grants no DELETE / defines no DELETE RLS
// policy. Removing a planned source allocation needs a future cancellation/
// removal workflow (e.g. a controlled RPC or a "voided" flag); it is NOT
// supported here. See the report's architectural-concerns note.

// ── Bottling output writes (output records only — NOT stock) ─────────────────

/**
 * Create a bottling output line (active-org scoped). Sets org_id + owner_id
 * server-trusted. Creates NO stock, product, SKU, or inventory.
 * @param {{ bottlingRunId: string, bottleVolumeMl: number, bottleCount: number,
 *   bottledLitres: number, packagingFormat: string, productName?: string|null,
 *   vintage?: number|null, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createBottlingOutput(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.bottlingRunId) return { data: null, error: { message: 'A bottling run is required.' } };
  const vol = numOrNull(input.bottleVolumeMl);
  if (vol === null || !Number.isFinite(vol) || vol <= 0) {
    return { data: null, error: { message: 'Bottle volume (ml) must be greater than zero.' } };
  }
  const count = numOrDefault(input.bottleCount, 0);
  if (!Number.isFinite(count) || count < 0) return { data: null, error: { message: 'Bottle count must be non-negative.' } };
  if (!isNonNegativeNumber(input.bottledLitres)) return { data: null, error: { message: 'Bottled litres must be non-negative.' } };
  const format = (input.packagingFormat || '').trim();
  if (!format) return { data: null, error: { message: 'A packaging format is required.' } };
  const vintage = numOrNull(input.vintage);
  if (vintage !== null && (vintage < 1900 || vintage > 2200)) {
    return { data: null, error: { message: 'Vintage must be between 1900 and 2200.' } };
  }

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    bottling_run_id: input.bottlingRunId,
    bottle_volume_ml: vol,
    bottle_count: count,
    bottled_litres: numOrDefault(input.bottledLitres, 0),
    packaging_format: format,
    product_name: input.productName ? input.productName.trim() : null,
    vintage,
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('bottling_outputs')
    .insert(row)
    .select(OUTPUT_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseOutput(data), error: null };
}

/**
 * Update a bottling output's descriptive fields (active-org scoped). id, org_id,
 * owner_id and bottling_run_id are NEVER changed here. Creates no stock; mutates
 * no Wine Lot volume, movements, or events. Status-gating of edits is deferred
 * to the controlled completion workflow (B4) — not enforced here.
 * @param {string} id
 * @param {{ bottleVolumeMl?: number, bottleCount?: number, bottledLitres?: number,
 *   packagingFormat?: string, productName?: string|null, vintage?: number|null,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateBottlingOutput(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.bottleVolumeMl !== undefined) {
    const vol = numOrNull(input.bottleVolumeMl);
    if (vol === null || !Number.isFinite(vol) || vol <= 0) return { data: null, error: { message: 'Bottle volume (ml) must be greater than zero.' } };
    row.bottle_volume_ml = vol;
  }
  if (input.bottleCount !== undefined) {
    const count = numOrDefault(input.bottleCount, 0);
    if (!Number.isFinite(count) || count < 0) return { data: null, error: { message: 'Bottle count must be non-negative.' } };
    row.bottle_count = count;
  }
  if (input.bottledLitres !== undefined) {
    if (!isNonNegativeNumber(input.bottledLitres)) return { data: null, error: { message: 'Bottled litres must be non-negative.' } };
    row.bottled_litres = numOrDefault(input.bottledLitres, 0);
  }
  if (input.packagingFormat !== undefined) {
    const format = (input.packagingFormat || '').trim();
    if (!format) return { data: null, error: { message: 'A packaging format is required.' } };
    row.packaging_format = format;
  }
  if (input.productName !== undefined) row.product_name = input.productName ? input.productName.trim() : null;
  if (input.vintage !== undefined) {
    const vintage = numOrNull(input.vintage);
    if (vintage !== null && (vintage < 1900 || vintage > 2200)) return { data: null, error: { message: 'Vintage must be between 1900 and 2200.' } };
    row.vintage = vintage;
  }
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('bottling_outputs')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(OUTPUT_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseOutput(data), error: null };
}

// NOTE: there is intentionally NO deleteBottlingOutput() — 034 defines no DELETE
// RLS policy / grant for bottling tables. Removing a planned output needs a
// future lifecycle workflow (not implemented here).

// ── Options / selectors ──────────────────────────────────────────────────────

/**
 * Lightweight bottling-run options for future selectors (active-org scoped).
 * @param {{ status?: string }} [options]
 * @returns {Promise<{ data: Array<{ id, bottlingCode, status, bottlingDate }>|null, error: object|null }>}
 */
export async function getBottlingRunOptions(options = {}) {
  const { data, error } = await getBottlingRuns({ status: options.status });
  if (error) return { data: null, error };
  return {
    data: (data || []).map((r) => ({
      id: r.id, bottlingCode: r.bottlingCode, status: r.status, bottlingDate: r.bottlingDate,
    })),
    error: null,
  };
}

/**
 * Wine Lot options suitable for selecting bottling sources (active-org scoped).
 * Delegates to the existing wineLotService (single data-access path). Excludes
 * terminal lots (depleted/archived/bottled) by default. Includes the current
 * volume for display ONLY — it is NOT an authoritative availability check; the
 * real check is the B4 completion RPC with row locking.
 * @param {{ includeTerminal?: boolean }} [options]
 * @returns {Promise<{ data: Array<{ id, lotCode, volumeLitres, status, batchCode }>|null, error: object|null }>}
 */
export async function getWineLotOptionsForBottling(options = {}) {
  const { data, error } = await getWineLots();
  if (error) return { data: null, error };
  const terminal = new Set(['depleted', 'archived', 'bottled']);
  const rows = (data || [])
    .filter((l) => options.includeTerminal || !terminal.has(l.status))
    .map((l) => ({
      id: l.id,
      lotCode: l.lotCode,
      volumeLitres: l.volumeLitres, // display only — NOT an availability guarantee
      status: l.status,
      batchCode: l.batchCode,
    }));
  return { data: rows, error: null };
}

/**
 * Lab-sample options for the bottling run's OPTIONAL releaseLabSampleId
 * (active-org scoped). Delegates to the existing labSampleService. A lab sample
 * is never required and alerts/lab status are never evaluated here.
 * @param {{ wineLotId?: string }} [options]
 * @returns {Promise<{ data: Array<{ id, sampleCode, sampleType, status, lotCode }>|null, error: object|null }>}
 */
export async function getReleaseLabSampleOptions(options = {}) {
  const { data, error } = await getLabSamples({ wineLotId: options.wineLotId });
  if (error) return { data: null, error };
  return {
    data: (data || []).map((s) => ({
      id: s.id, sampleCode: s.sampleCode, sampleType: s.sampleType, status: s.status, lotCode: s.lotCode,
    })),
    error: null,
  };
}
