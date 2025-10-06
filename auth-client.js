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

export async function signOut() {
  await window.supabase.auth.signOut();
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
