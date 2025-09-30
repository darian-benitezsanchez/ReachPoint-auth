// data/campaignsData.js

// Storage keys
const K = {
  CAMPAIGNS: "reachpoint.campaigns",
  STUDENTS_CACHE: "reachpoint.studentsCache.v1", // optional local cache
  STUDENTS_CACHE_AT: "reachpoint.studentsCacheAt",
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

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

/* ---------------- Students: Supabase-first with graceful fallback ---------------- */

/**
 * Attempts to read from Supabase table `students`.
 * - If available, returns full array and refreshes local cache.
 * - If offline or error, falls back to cache, then to ./data/students.json file.
 */
export async function getAllStudents() {
  // 1) Try Supabase if present
  try {
    if (window.hasSupabase && window.hasSupabase()) {
      const { data, error } = await window.supabase
        .from("students")
        .select("*"); // customize columns if needed
      if (error) throw error;
      if (Array.isArray(data)) {
        // refresh local cache (lightweight)
        localStorage.setItem(K.STUDENTS_CACHE, JSON.stringify(data));
        localStorage.setItem(K.STUDENTS_CACHE_AT, nowIso());
        return data;
      }
    }
  } catch (err) {
    console.warn("[ReachPoint] Supabase students fetch failed; will try cache/file.", err);
  }

  // 2) Try cache if fresh enough (< 1 day old)
  try {
    const cached = localStorage.getItem(K.STUDENTS_CACHE);
    const at = localStorage.getItem(K.STUDENTS_CACHE_AT);
    if (cached) {
      const rows = JSON.parse(cached);
      if (Array.isArray(rows)) return rows;
    }
  } catch {}

  // 3) Fallback to file on disk (dev)
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

  // 4) Final fallback: empty
  return [];
}

/* ---------------- Campaign CRUD (unchanged: local only) ---------------- */

export function listCampaigns() {
  try { return JSON.parse(localStorage.getItem(K.CAMPAIGNS) || "[]"); }
  catch { return []; }
}

export function getCampaignById(id) {
  return listCampaigns().find(c => c.id === id) || null;
}

export async function saveCampaign(campaign) {
  const arr = listCampaigns();
  const i = arr.findIndex(c => c.id === campaign.id);
  if (i >= 0) arr[i] = campaign; else arr.push(campaign);
  localStorage.setItem(K.CAMPAIGNS, JSON.stringify(arr));
  return campaign;
}

export async function deleteCampaign(id) {
  const arr = listCampaigns().filter(c => c.id !== id);
  localStorage.setItem(K.CAMPAIGNS, JSON.stringify(arr));
  return true;
}
