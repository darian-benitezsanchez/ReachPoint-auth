// supa.js
export async function authed() {
  const { data: { session } } = await window.supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  return session;
}

export async function from(table) {
  await authed();              // ensure a session exists
  return window.supabase.from(table);
}
