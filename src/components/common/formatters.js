// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Shared display formatters & status colours
// Small pure helpers reused across module Card / Table / Profile components.
// ─────────────────────────────────────────────────────────────────────────────

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatNumber(value, { maximumFractionDigits = 1 } = {}) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits });
}

export function formatCurrency(value) {
  const n = Number(value) || 0;
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'ZAR',
    maximumFractionDigits: 2,
  });
}

// Generic status → MUI chip colour mapping used across activity-style modules.
export function activityStatusColor(status) {
  const s = (status || '').toLowerCase();
  if (['active', 'operational', 'in progress'].includes(s)) return 'primary';
  if (['planned', 'pending', 'scheduled'].includes(s)) return 'secondary';
  return 'default'; // completed / cancelled / archived / other
}
