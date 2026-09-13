import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';
import { computeTotals } from './financeService';
import { upcomingTasks } from './plannerService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Reports / Insights aggregation
// Reads real, RLS-scoped data across all Phase 1 modules and computes summary
// metrics. Missing tables (migration not yet run) are treated as empty rather
// than errors, so the page degrades gracefully. No fabricated statistics.
// ─────────────────────────────────────────────────────────────────────────────

function isMissingTable(error) {
  if (!error) return false;
  if (['42P01', 'PGRST205'].includes(error.code)) return true;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table');
}

// Fetch all rows of a table scoped to the active organisation; returns [] for a
// missing table, throws otherwise. The org filter is additive on top of RLS.
async function safeSelect(table, columns, orgId) {
  const { data, error } = await supabase.from(table).select(columns).eq('org_id', orgId);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

const ACTIVE_OP_STATUSES = new Set(['active', 'planned', 'pending', 'in_progress', 'scheduled']);
function countActive(rows) {
  return rows.filter((r) => ACTIVE_OP_STATUSES.has((r.status || '').toLowerCase())).length;
}

/**
 * Aggregate all Phase 1 module data into a single report snapshot.
 * @returns {Promise<{ data: object|null, error: string|null }>}
 */
export async function getReportSnapshot() {
  const orgId = getActiveOrgId();
  if (!orgId) {
    // No active organisation selected: return a safe empty snapshot rather than
    // an unscoped read. Shape matches a fully-empty dataset.
    return {
      data: {
        vineyards: { total: 0, totalHectares: 0 },
        blocks: { total: 0 },
        operations: { total: 0, active: 0 },
        irrigation: { total: 0, active: 0 },
        spray: { total: 0, active: 0 },
        harvest: { total: 0, totalYield: 0 },
        machinery: { total: 0, operational: 0, needsAttention: 0 },
        finance: computeTotals([]),
        planner: { total: 0, open: 0, upcoming: [] },
      },
      error: null,
    };
  }

  try {
    const [
      vineyards, blocks, operations, irrigation, spray, harvest, machinery, finance, planner,
    ] = await Promise.all([
      safeSelect('vineyards', 'id, name, area_hectares, status', orgId),
      safeSelect('blocks', 'id, area_hectares, status', orgId),
      safeSelect('operations', 'id, status', orgId),
      safeSelect('irrigation', 'id, status', orgId),
      safeSelect('spray_programme', 'id, status', orgId),
      safeSelect('harvest', 'id, status, yield_tons', orgId),
      safeSelect('machinery', 'id, status', orgId),
      safeSelect('finance', 'id, type, amount', orgId),
      safeSelect('planner', 'id, status, due_date', orgId),
    ]);

    const totalHectares = vineyards.reduce((s, v) => s + (Number(v.area_hectares) || 0), 0);
    const totalYield = harvest.reduce((s, h) => s + (Number(h.yield_tons) || 0), 0);
    const financeNorm = finance.map((f) => ({ type: f.type, amount: f.amount }));
    const financeTotals = computeTotals(financeNorm);
    const plannerNorm = planner.map((p) => ({ status: p.status, dueDate: p.due_date }));

    return {
      data: {
        vineyards: { total: vineyards.length, totalHectares },
        blocks: { total: blocks.length },
        operations: { total: operations.length, active: countActive(operations) },
        irrigation: { total: irrigation.length, active: countActive(irrigation) },
        spray: { total: spray.length, active: countActive(spray) },
        harvest: { total: harvest.length, totalYield },
        machinery: {
          total: machinery.length,
          operational: machinery.filter((m) => (m.status || '').toLowerCase() === 'operational').length,
          needsAttention: machinery.filter((m) => ['maintenance', 'out_of_service'].includes((m.status || '').toLowerCase())).length,
        },
        finance: financeTotals,
        planner: {
          total: planner.length,
          open: countActive(planner),
          upcoming: upcomingTasks(plannerNorm, 5),
        },
      },
      error: null,
    };
  } catch {
    return { data: null, error: 'We couldn\u2019t load your reports right now. Please try again in a moment.' };
  }
}
