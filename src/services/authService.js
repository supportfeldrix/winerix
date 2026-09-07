import { supabase } from './supabase';

/**
 * Register a new user with email and password.
 * @param {string} email
 * @param {string} password
 * @param {object} [metadata] - Optional user metadata (e.g. { full_name })
 * @returns {{ data: object|null, error: object|null }}
 */
export async function signUp(email, password, metadata = {}) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: metadata,
    },
  });
  return { data, error };
}

/**
 * Sign in an existing user with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {{ data: object|null, error: object|null }}
 */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

/**
 * Sign out the current user.
 * @returns {{ error: object|null }}
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

/**
 * Get the currently authenticated user.
 * @returns {{ data: { user: object|null }, error: object|null }}
 */
export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { data, error };
}

/**
 * Get the current session.
 * @returns {{ data: { session: object|null }, error: object|null }}
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  return { data, error };
}

/**
 * Subscribe to authentication state changes.
 * Returns the subscription object — call subscription.unsubscribe() to clean up.
 * @param {function} callback - Receives (event, session) on auth state change.
 * @returns {{ subscription: object }}
 */
export function onAuthStateChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return { subscription };
}
