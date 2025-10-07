// auth-client.js
export async function signUp(email, password) {
  const { data, error } = await window.supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await window.supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// Accept optional { global: true } to revoke all refresh tokens for the user
export async function signOut(opts = {}) {
  const args = opts.global ? { scope: 'global' } : undefined;
  await window.supabase.auth.signOut(args);
}

export async function getSession() {
  const { data } = await window.supabase.auth.getSession();
  return data.session;
}

export async function getUser() {
  const { data } = await window.supabase.auth.getUser();
  return data.user;
}

export function onAuthChange(cb) {
  return window.supabase.auth.onAuthStateChange((_evt, session) => cb(session));
}
