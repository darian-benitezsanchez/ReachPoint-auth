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
/**
 * Attempts to read from Supabase table `students`.
 * - If available, returns full array and refreshes local cache.
 * - If offline or error, falls back to cache, then to ./data/students.json file.
 */
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

// ---------- Campaigns: Supabase-first CRUD (local fallback) ----------
export async function listCampaigns() {
  const s = supa();
  if (s) {
    const { data, error } = await s
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      // Normalize any stringified JSON columns
      const normalized = data.map(c => ({
        ...c,
        filters: maybeParseJSON(c.filters),
        student_ids: maybeParseJSON(c.student_ids),
        reminders: maybeParseJSON(c.reminders),
        survey: maybeParseJSON(c.survey),
      }));
      try { localStorage.setItem(K.CAMPAIGNS, JSON.stringify(normalized)); } catch {}
      return normalized;
    }
    console.warn("[ReachPoint] listCampaigns Supabase error; using local fallback:", error);
  }
  try {
    const arr = JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function getCampaignById(id) {
  const s = supa();
  if (s) {
    const { data, error } = await s.from("campaigns").select("*").eq("id", id).maybeSingle();
    if (!error && data) {
      // Normalize any stringified JSON columns
      data.filters = maybeParseJSON(data.filters);
      data.student_ids = maybeParseJSON(data.student_ids);
      data.reminders = maybeParseJSON(data.reminders);
      data.survey = maybeParseJSON(data.survey);
      return data;
    }
    console.warn("[ReachPoint] getCampaignById Supabase error; using local fallback:", error);
  }
  const local = (JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]") || []).find(c => c.id === id) || null;
  if (local) {
    local.filters = maybeParseJSON(local.filters);
    local.student_ids = maybeParseJSON(local.student_ids);
    local.reminders = maybeParseJSON(local.reminders);
    local.survey = maybeParseJSON(local.survey);
  }
  return local;
}

export async function saveCampaign(campaign) {
  const s = supa();
  if (s) {
    // ✅ include survey so Execute can render chips
    const up = {
      id: campaign.id,
      name: campaign.name,
      filters: campaign.filters || [],
      student_ids: campaign.studentIds || null,
      reminders: campaign.reminders || null,
      survey: campaign.survey || null,   // <-- added
    };
    const { error } = await s.from("campaigns").upsert(up);
    if (error) throw error;
    await listCampaigns(); // refresh local cache w/ normalized rows
    return campaign;
  }
  // local fallback
  const arr = JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]");
  const next = { ...campaign };
  // keep local shape consistent
  next.filters = next.filters || [];
  next.student_ids = next.studentIds || null;
  // ensure local copy stores survey too
  next.survey = next.survey || null;

  const i = arr.findIndex(c => c.id === campaign.id);
  if (i >= 0) arr[i] = next; else arr.push(next);
  localStorage.setItem(K.CAMPAIGNS, JSON.stringify(arr));
  return campaign;
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
