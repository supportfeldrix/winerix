import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { getMyOrganisations } from '../services/organisationService';
import { setActiveOrgId } from '../services/activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Organisation Context
//
// Loads the authenticated user's ACTIVE organisation memberships and resolves a
// single "active organisation" for the session. The active organisation is a
// CLIENT-SIDE selection only — it is never an authorisation mechanism. Supabase
// RLS remains the authoritative security boundary.
//
// Active-org resolution order:
//   a. localStorage['winerix.activeOrgId'] — ONLY if it is in the freshly
//      loaded active list.
//   b. the user's personal organisation (is_personal === true AND
//      created_by === user.id).
//   c. the first active organisation.
//
// localStorage is a convenience for remembering the last selection, never an
// authority. Invalid / stale ids are ignored and safely replaced.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'winerix.activeOrgId';

const OrganisationContext = createContext(null);

function readStoredOrgId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null; // localStorage may be unavailable (private mode, etc.)
  }
}

function writeStoredOrgId(id) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures — they must never break the app.
  }
}

/**
 * Resolve which organisation id should be active, given the freshly loaded
 * list and (optionally) a previously selected id. Never returns an id that is
 * not present in `orgs`.
 *
 * @param {Array} orgs - normalised organisations available to the user
 * @param {string|null} preferredId - a candidate (e.g. stored) id
 * @param {string} userId - authenticated user id (for personal-org matching)
 * @returns {string|null}
 */
function resolveActiveOrgId(orgs, preferredId, userId) {
  if (!orgs || orgs.length === 0) return null;

  // a. Honour the preferred id only if it is a currently-available org.
  if (preferredId && orgs.some((o) => o.id === preferredId)) {
    return preferredId;
  }

  // b. Prefer the user's personal organisation.
  const personal = orgs.find((o) => o.isPersonal === true && o.createdBy === userId);
  if (personal) return personal.id;

  // c. Fall back to the first available organisation.
  return orgs[0].id;
}

/**
 * Provides organisation context to the authenticated application shell.
 * @param {object} props
 * @param {object} props.user - the authenticated Supabase user
 * @param {React.ReactNode} props.children
 */
export function OrganisationProvider({ user, children }) {
  const userId = user?.id || null;

  const [organisations, setOrganisations] = useState([]); // [{ organisation, role, status }]
  const [activeOrgId, setActiveOrgIdState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Keep the latest resolved active id available to async callbacks.
  const activeOrgIdRef = useRef(null);
  activeOrgIdRef.current = activeOrgId;

  // Keep the non-React helper in sync so services can read the active org.
  const applyActiveOrgId = useCallback((id) => {
    setActiveOrgIdState(id);
    setActiveOrgId(id);        // module-level helper (not a security boundary)
    writeStoredOrgId(id);      // convenience persistence only
  }, []);

  const load = useCallback(async () => {
    if (!userId) {
      // No authenticated user — clear everything safely.
      setOrganisations([]);
      applyActiveOrgId(null);
      setError('');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    const { data, error: err } = await getMyOrganisations();

    if (err) {
      setError('We couldn\u2019t load your organisations right now. Please try again in a moment.');
      setOrganisations([]);
      applyActiveOrgId(null);
      setLoading(false);
      return;
    }

    const memberships = data || [];
    const orgs = memberships.map((m) => m.organisation).filter(Boolean);

    setOrganisations(memberships);

    // Resolve active org against the freshly loaded list. Prefer the currently
    // selected id (if still valid), else the stored id, else personal/first.
    const preferred = activeOrgIdRef.current || readStoredOrgId();
    const resolved = resolveActiveOrgId(orgs, preferred, userId);
    applyActiveOrgId(resolved);

    setLoading(false);
  }, [userId, applyActiveOrgId]);

  // Load on mount and whenever the authenticated user changes.
  useEffect(() => {
    load();
  }, [load]);

  /**
   * Select an active organisation. Only accepts an id present in the currently
   * loaded active list; invalid ids are ignored.
   */
  const setActiveOrg = useCallback(
    (id) => {
      const isValid = organisations.some((m) => m.organisation && m.organisation.id === id);
      if (!isValid) return; // reject arbitrary / stale ids safely
      applyActiveOrgId(id);
    },
    [organisations, applyActiveOrgId]
  );

  const refresh = useCallback(() => load(), [load]);

  // Derived, memoised view values.
  const activeMembership = useMemo(
    () => organisations.find((m) => m.organisation && m.organisation.id === activeOrgId) || null,
    [organisations, activeOrgId]
  );
  const activeOrg = activeMembership ? activeMembership.organisation : null;
  const activeRole = activeMembership ? activeMembership.role : null;
  const orgList = useMemo(
    () => organisations.map((m) => m.organisation).filter(Boolean),
    [organisations]
  );

  const value = useMemo(
    () => ({
      organisations: orgList,
      memberships: organisations,
      activeOrg,
      activeOrgId,
      activeRole,
      loading,
      error,
      setActiveOrg,
      refresh,
    }),
    [orgList, organisations, activeOrg, activeOrgId, activeRole, loading, error, setActiveOrg, refresh]
  );

  // While memberships are loading, show a simple existing-style spinner so
  // pages never render against undefined organisation state.
  if (loading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress color="primary" />
      </Box>
    );
  }

  return (
    <OrganisationContext.Provider value={value}>
      {children}
    </OrganisationContext.Provider>
  );
}

/**
 * Access the organisation context.
 * @returns {{ organisations, memberships, activeOrg, activeOrgId, activeRole,
 *   loading, error, setActiveOrg, refresh }}
 */
export function useOrganisation() {
  const ctx = useContext(OrganisationContext);
  if (ctx === null) {
    throw new Error('useOrganisation must be used within an OrganisationProvider');
  }
  return ctx;
}

export default OrganisationContext;
