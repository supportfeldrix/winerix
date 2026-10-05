// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Packaging presentation helper (P2K-8)
//
// PRESENTATION ONLY. Bottles are the authoritative finished-goods stock unit;
// these pure helpers derive a case/loose-bottle view for DISPLAY. They never
// store, mutate, or convert stock, and never call Supabase. Cases are not
// inventory — a case is simply N bottles.
//
// Rounding rule (never round up):
//   fullCases    = floor(qtyBottles / bottlesPerCase)
//   looseBottles = qtyBottles % bottlesPerCase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the case breakdown for a bottle quantity.
 * @param {number} qtyBottles - non-negative integer bottle count
 * @param {number|null|undefined} bottlesPerCase - positive integer, or null/undefined when no case config
 * @returns {{ hasConfig: boolean, fullCases: number|null, looseBottles: number|null, bottlesPerCase: number|null }}
 *   hasConfig is false (and the case fields null) when bottlesPerCase is not a
 *   positive integer — callers should then show bottles only.
 */
export function getPackagingBreakdown(qtyBottles, bottlesPerCase) {
  const qty = Number(qtyBottles);
  const per = Number(bottlesPerCase);

  const qtyValid = Number.isFinite(qty) && qty >= 0;
  const perValid = Number.isInteger(per) && per > 0;

  if (!qtyValid || !perValid) {
    return { hasConfig: false, fullCases: null, looseBottles: null, bottlesPerCase: perValid ? per : null };
  }

  const whole = Math.floor(qty); // defensive: only whole bottles are stock units
  return {
    hasConfig: true,
    fullCases: Math.floor(whole / per),
    looseBottles: whole % per,
    bottlesPerCase: per,
  };
}

/**
 * A compact human string for the case breakdown, or '' when no case config.
 * Examples (bottlesPerCase = 6):
 *   4975 -> "829 full cases + 1 loose bottle"
 *   4974 -> "829 full cases"
 *   5    -> "5 loose bottles"
 *   0    -> "0 full cases"
 * @param {number} qtyBottles
 * @param {number|null|undefined} bottlesPerCase
 * @returns {string}
 */
export function formatPackagingBreakdown(qtyBottles, bottlesPerCase) {
  const b = getPackagingBreakdown(qtyBottles, bottlesPerCase);
  if (!b.hasConfig) return '';

  const parts = [];
  if (b.fullCases > 0 || b.looseBottles === 0) {
    parts.push(`${b.fullCases.toLocaleString()} full ${b.fullCases === 1 ? 'case' : 'cases'}`);
  }
  if (b.looseBottles > 0) {
    parts.push(`${b.looseBottles.toLocaleString()} loose ${b.looseBottles === 1 ? 'bottle' : 'bottles'}`);
  }
  return parts.join(' + ');
}
