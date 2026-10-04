// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab alert display helpers (shared, pure)
// Factual, operational labels + MUI chip colours for laboratory alerts. These
// are ATTENTION records, never quality/regulatory/compliance judgements — the
// wording deliberately avoids "failed", "bad", "non-compliant", etc.
// ─────────────────────────────────────────────────────────────────────────────

// Status → human label + chip colour. Colour supplements the always-present
// text label (never colour-only).
export function alertStatusDisplay(status) {
  switch (status) {
    case 'open': return { label: 'Open', color: 'error' };          // high attention
    case 'acknowledged': return { label: 'Acknowledged', color: 'warning' }; // being handled
    case 'resolved': return { label: 'Resolved', color: 'success' };         // completed
    case 'dismissed': return { label: 'Dismissed', color: 'default' };       // closed, no action
    default: return { label: status || '—', color: 'default' };
  }
}

// Alert type → human label (factual).
export function alertTypeLabel(type) {
  switch (type) {
    case 'below_minimum': return 'Below minimum';
    case 'above_maximum': return 'Above maximum';
    case 'incompatible_unit': return 'Unit mismatch';
    default: return type || '—';
  }
}

// Alert class → human label.
export function alertClassLabel(cls) {
  switch (cls) {
    case 'range_exception': return 'Range exception';
    case 'data_quality': return 'Data quality';
    default: return cls || '—';
  }
}

// Open + acknowledged are the "needs attention" states (visually prominent).
export function isActiveAlertStatus(status) {
  return status === 'open' || status === 'acknowledged';
}
