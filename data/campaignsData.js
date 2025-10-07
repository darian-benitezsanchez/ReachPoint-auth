// data/campaignsData.js

// ---------- keys & utils ----------
const K = {
  CAMPAIGNS: "reachpoint.campaigns",          // local cache (fallback)
  STUDENTS_CACHE: "reachpoint.studentsCache.v1",
  STUDENTS_CACHE_AT: "reachpoint.studentsCacheAt",
};

function nowIso() { return new Date().toISOString(); }
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function supa() { return (window.hasSupabase && window.hasSupabase()) ? window.supabase : null; }

// Safely JSON-parse only if the value is a string
function maybeParseJSON(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ---------- student helpers ----------
/** Derive a stable student id from row + position (compatible with your app) */
export function getStudentId(student, idx) {
  const key =
    student.id ??
    student.student_id ??
    student.uuid ??
    `${student.first_name ?? ""}-${student.last_name ?? ""}-${idx}`;
  return String(key);
}

/** Field list from dataset */
export function uniqueFieldsFromStudents(rows) {
  const set = new Set();
  for (const r of rows) for (const k of Object.keys(r || {})) set.add(k);
  return Array.from(set);
}

/** Apply filters: [{field, op, value}] */
export function applyFilters(rows, filters) {
  if (!filters?.length) return rows.slice();
  const ops = {
    "=":  (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase(),
    "~":  (a, b) => String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase()),
    ">":  (a, b) => Number(a) >  Number(b),
    ">=": (a, b) => Number(a) >= Number(b),
    "<":  (a, b) => Number(a) <  Number(b),
    "<=": (a, b) => Number(a) <= Number(b),
  };
  return rows.filter(r => filters.every(f => (ops[f.op] || ops["="])(r?.[f.field], f.value)));
}

// ---------- Students: Supabase-first with graceful fallback ----------
export async function getAllStudents() {
  try {
    const s = supa();
    if (s) {
      const { data, error } = await s.from("students").select("*");
      if (error) throw error;
      if (Array.isArray(data)) {
        localStorage.setItem(K.STUDENTS_CACHE, JSON.stringify(data));
        localStorage.setItem(K.STUDENTS_CACHE_AT, nowIso());
        return data;
      }
    }
  } catch (err) {
    console.warn("[ReachPoint] Supabase students fetch failed; will try cache/file.", err);
  }

  // cache fallback
  try {
    const cached = localStorage.getItem(K.STUDENTS_CACHE);
    if (cached) {
      const rows = JSON.parse(cached);
      if (Array.isArray(rows)) return rows;
    }
  } catch {}

  // file fallback (dev only)
  try {
    const resp = await fetch("./data/students.json", { cache: "no-store" });
    if (resp.ok) {
      const json = await resp.json();
      const rows = Array.isArray(json) ? json : (json?.data ?? []);
      if (Array.isArray(rows)) {
        localStorage.setItem(K.STUDENTS_CACHE, JSON.stringify(rows));
        localStorage.setItem(K.STUDENTS_CACHE_AT, nowIso());
        return rows;
      }
    }
  } catch (e) {
    console.error("[ReachPoint] Could not load ./data/students.json", e);
  }

  return [];
}

/* -------------------- Normalization helpers -------------------- */
function normalizeRowFromDB(row) {
  // Parse any stringified JSON (defensive)
  const filters   = maybeParseJSON(row.filters)     ?? [];
  const studentIDs= maybeParseJSON(row.student_ids) ?? [];
  const reminders = maybeParseJSON(row.reminders)   ?? [];
  const survey    = maybeParseJSON(row.survey)      ?? null;

  // Return both camelCase and snake_case for backwards compatibility
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,

    // camelCase the app prefers
    filters,
    studentIds: studentIDs,
    reminders,
    survey,

    // keep snake_case a copy so legacy code (execution.js) that reads student_ids still works
    student_ids: studentIDs
  };
}

function normalizeRowFromLocal(row) {
  const filters   = maybeParseJSON(row.filters)                 ?? [];
  const studentIDs= maybeParseJSON(row.studentIds ?? row.student_ids) ?? [];
  const reminders = maybeParseJSON(row.reminders)               ?? [];
  const survey    = maybeParseJSON(row.survey)                  ?? null;

  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,

    filters,
    studentIds: studentIDs,
    reminders,
    survey,

    student_ids: studentIDs
  };
}

// ---------- Campaigns: Supabase-first CRUD (local fallback) ----------
export async function listCampaigns() {
  const s = supa();
  if (s) {
    const { data, error } = await s
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      const normalized = data.map(normalizeRowFromDB);
      try { localStorage.setItem(K.CAMPAIGNS, JSON.stringify(normalized)); } catch {}
      return normalized;
    }
    console.warn("[ReachPoint] listCampaigns Supabase error; using local fallback:", error);
  }
  try {
    const arr = JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]");
    return Array.isArray(arr) ? arr.map(normalizeRowFromLocal) : [];
  } catch {
    return [];
  }
}

export async function getCampaignById(id) {
  const s = supa();
  if (s) {
    const { data, error } = await s.from("campaigns").select("*").eq("id", id).maybeSingle();
    if (!error && data) return normalizeRowFromDB(data);
    console.warn("[ReachPoint] getCampaignById Supabase error; using local fallback:", error);
  }
  const local = (JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]") || []).find(c => c.id === id) || null;
  return local ? normalizeRowFromLocal(local) : null;
}

export async function saveCampaign(campaign) {
  const s = supa();

  // Map incoming object to DB column names (snake_case) and strip unknowns
  const toDb = (c) => {
    const payload = {
      name: c.name,
      // only include if these columns exist in your table:
      filters: c.filters ?? [],
      student_ids: c.studentIds ?? c.student_ids ?? [],
      survey: c.survey ?? null,
      // reminders: c.reminders ?? [],   // ← include ONLY if campaigns.reminders exists
      // created_at: new Date().toISOString(), // usually let DB default handle this
    };
    return payload;
  };

  if (s) {
    if (!campaign.id) {
      // --- CREATE: no id provided → let DB generate UUID ---
      const { data, error } = await s
        .from('campaigns')
        .insert(toDb(campaign))          // no id, no onConflict
        .select('*')
        .single();

      if (error) throw error;

      // refresh cache with normalized rows
      await listCampaigns();
      return normalizeRowFromDB(data);
    } else {
      // --- UPDATE: existing id ---
      const { data, error } = await s
        .from('campaigns')
        .update(toDb(campaign))
        .eq('id', campaign.id)
        .select('*')
        .single();

      if (error) throw error;

      await listCampaigns();
      return normalizeRowFromDB(data);
    }
  }

  // ---------- Local fallback (no Supabase) ----------
  const arr = JSON.parse(localStorage.getItem(K.CAMPAIGNS) || '[]');

  // If no id (create), synthesize a local id so the app can keep working offline
  const localId = campaign.id ?? `local_${Date.now()}`;

  const next = {
    id: localId,
    name: campaign.name,
    createdAt: campaign.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    filters: campaign.filters ?? [],
    studentIds: campaign.studentIds ?? campaign.student_ids ?? [],
    survey: campaign.survey ?? null,
    // reminders: campaign.reminders ?? [], // keep only if you actually use it locally
    student_ids: campaign.studentIds ?? campaign.student_ids ?? [],
  };

  const i = arr.findIndex((c) => c.id === localId);
  if (i >= 0) arr[i] = next; else arr.push(next);
  localStorage.setItem(K.CAMPAIGNS, JSON.stringify(arr));
  return next;
}


export async function deleteCampaign(id) {
  const s = supa();
  if (s) {
    const { error } = await s.from("campaigns").delete().eq("id", id);
    if (error) throw error;
    await listCampaigns(); // refresh local cache
    return true;
  }
  const arr = (JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]") || []).filter(c => c.id !== id);
  localStorage.setItem(K.CAMPAIGNS, JSON.stringify(arr));
  return true;
}

// ---------- Optional: realtime subscription for campaigns ----------
export function subscribeCampaigns(onChange) {
  const s = supa();
  if (!s) return () => {};
  const ch = s.channel("campaigns-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "campaigns" }, onChange)
    .subscribe();
  return () => s.removeChannel(ch);
}
