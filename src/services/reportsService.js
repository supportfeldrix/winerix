import { supabase } from './supabase';
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

// Fetch all rows of a table; returns [] for a missing table, throws otherwise.
async function safeSelect(table, columns = '*') {
  const { data, error } = await supabase.from(table).select(columns);
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
  try {
    const [
      vineyards, blocks, operations, irrigation, spray, harvest, machinery, finance, planner,
    ] = await Promise.all([
      safeSelect('vineyards', 'id, name, area_hectares, status'),
      safeSelect('blocks', 'id, area_hectares, status'),
      safeSelect('operations', 'id, status'),
      safeSelect('irrigation', 'id, status'),
      safeSelect('spray_programme', 'id, status'),
      safeSelect('harvest', 'id, status, yield_tons'),
      safeSelect('machinery', 'id, status'),
      safeSelect('finance', 'id, type, amount'),
      safeSelect('planner', 'id, status, due_date'),
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
