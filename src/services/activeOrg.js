// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Active organisation holder (module-level, non-React)
//
// A tiny, dependency-free module that remembers the currently selected
// organisation id so that service code can read it WITHOUT importing React.
//
// IMPORTANT: this is NOT a security boundary. It is a client-side convenience
// only. Supabase Row Level Security remains the authoritative access control.
// This module performs no Supabase calls, no auth, no permission checks, and
// no database access.
//
// The OrganisationProvider is responsible for keeping this value in sync with
// the resolved active organisation (calling setActiveOrgId on resolution and
// on every change). When no valid organisation is selected the value is null.
// ─────────────────────────────────────────────────────────────────────────────

let activeOrgId = null;

/**
 * Get the currently selected organisation id (or null if none is selected).
 * @returns {string|null}
 */
export function getActiveOrgId() {
  return activeOrgId;
}

/**
 * Set the currently selected organisation id. Pass null/undefined to clear it.
 * No validation is performed here — the OrganisationProvider is responsible for
 * only ever passing an id that belongs to the user's active memberships.
 * @param {string|null|undefined} id
 */
export function setActiveOrgId(id) {
  activeOrgId = id ?? null;
}
