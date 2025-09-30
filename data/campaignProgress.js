// data/campaignProgress.js

const K = {
  PROG_PREFIX: "reachpoint.progress.",           // per-campaign object
  SURVEY_PREFIX: "reachpoint.survey.",           // simple presence marker
};

// Local save/load helpers
function saveProgress(p) {
  try { localStorage.setItem(K.PROG_PREFIX + p.campaignId, JSON.stringify(p)); } catch {}
}
function loadProgressLocal(campaignId) {
  try { return JSON.parse(localStorage.getItem(K.PROG_PREFIX + campaignId) || "null"); } catch { return null; }
}

function defaultContact() {
  return {
    attempts: 0,
    outcome: undefined,   // "answered" | "no_answer"
    lastCalledAt: 0,
    surveyAnswer: undefined,
    surveyLogs: [],
    notes: "",
    notesLogs: []
  };
}

/* ---------------- Supabase helpers ---------------- */

function supaAvailable() { return !!(window.hasSupabase && window.hasSupabase()); }

/**
 * Upsert a single call progress record into table `call_progress`.
 * Schema suggestion:
 *   - campaign_id (text)
 *   - contact_id (text)
 *   - attempts (int)
 *   - outcome (text)        -- 'answered' | 'no_answer' | null
 *   - last_called_at (timestamptz)
 */
async function supaUpsertCallProgress(campaignId, contactId, c) {
  if (!supaAvailable()) return;
  const row = {
    campaign_id: campaignId,
    contact_id:  contactId,
    attempts:    c.attempts ?? 0,
    outcome:     c.outcome ?? null,
    last_called_at: c.lastCalledAt ? new Date(c.lastCalledAt).toISOString() : null,
  };
  const { error } = await window.supabase.from("call_progress").upsert(row, { onConflict: "campaign_id,contact_id" });
  if (error) console.warn("[ReachPoint] call_progress upsert failed:", error);
}

/**
 * Insert a survey log row (append-only) into `survey_responses`.
 * Schema suggestion:
 *   - campaign_id (text)
 *   - contact_id (text)
 *   - answer (text)
 *   - at (timestamptz)
 */
async function supaInsertSurveyLog(campaignId, contactId, answer, atMs) {
  if (!supaAvailable()) return;
  const { error } = await window.supabase.from("survey_responses").insert({
    campaign_id: campaignId,
    contact_id:  contactId,
    answer:      String(answer ?? ""),
    at:          new Date(atMs).toISOString()
  });
  if (error) console.warn("[ReachPoint] survey_responses insert failed:", error);
}

/**
 * Insert a note log row (append-only) into `notes`.
 * Schema suggestion:
 *   - campaign_id (text)
 *   - contact_id (text)
 *   - text (text)
 *   - at (timestamptz)
 */
async function supaInsertNoteLog(campaignId, contactId, text, atMs) {
  if (!supaAvailable()) return;
  const { error } = await window.supabase.from("notes").insert({
    campaign_id: campaignId,
    contact_id:  contactId,
    text:        String(text ?? ""),
    at:          new Date(atMs).toISOString()
  });
  if (error) console.warn("[ReachPoint] notes insert failed:", error);
}

/**
 * Persist export rows to Supabase.
 * We store each row as JSON for exact fidelity.
 * Tables suggested:
 *   - export_full_rows
 *   - export_not_called_rows
 * Columns:
 *   - campaign_id (text)
 *   - row (jsonb)
 *   - exported_at (timestamptz)
 */
async function supaInsertExportRows(table, campaignId, rows) {
  if (!supaAvailable() || !Array.isArray(rows) || !rows.length) return;
  const exported_at = new Date().toISOString();
  const payload = rows.map(r => ({ campaign_id: campaignId, row: r, exported_at }));
  const { error } = await window.supabase.from(table).insert(payload);
  if (error) console.warn(`[ReachPoint] ${table} insert failed:`, error);
}

/* ---------------- Core progress API (local-first, write-through to Supabase) ---------------- */

export async function loadOrInitProgress(campaignId, queueIds = []) {
  // local first
  const raw = loadProgressLocal(campaignId);
  if (raw) return raw;

  const init = {
    campaignId,
    totals: { total: queueIds.length || 0, made: 0, answered: 0, missed: 0 },
    contacts: {},
  };
  saveProgress(init);
  return init;
}

export async function recordOutcome(campaignId, contactId, outcome /* 'answered' | 'no_answer' */) {
  const p = await loadOrInitProgress(campaignId, []);
  const c = p.contacts[contactId] || defaultContact();

  c.attempts += 1;
  c.lastCalledAt = Date.now();
  c.outcome = outcome === "answered" ? "answered" : "no_answer";
  p.contacts[contactId] = c;

  // recompute totals
  const seenIds = Object.keys(p.contacts);
  p.totals.made = seenIds.reduce((acc, id) => acc + (p.contacts[id].attempts > 0 ? 1 : 0), 0);
  p.totals.answered = seenIds.reduce((acc, id) => acc + (p.contacts[id].outcome === "answered" ? 1 : 0), 0);
  p.totals.missed = seenIds.reduce((acc, id) => acc + (p.contacts[id].outcome === "no_answer" ? 1 : 0), 0);

  saveProgress(p);

  // write-through
  supaUpsertCallProgress(campaignId, contactId, c).catch(() => {});
  return p;
}

export async function recordSurveyResponse(campaignId, contactId, answer) {
  const p = await loadOrInitProgress(campaignId, []);
  const c = p.contacts[contactId] || defaultContact();

  c.surveyAnswer = answer;
  c.surveyLogs = c.surveyLogs || [];
  const at = Date.now();
  c.surveyLogs.push({ answer, at });

  p.contacts[contactId] = c;
  saveProgress(p);

  // marker (kept from your original code)
  try { localStorage.setItem(K.SURVEY_PREFIX + campaignId, "1"); } catch {}

  // write-through (append-only)
  supaInsertSurveyLog(campaignId, contactId, answer, at).catch(() => {});
  // also keep call_progress up to date (attempt count may not change here, but outcome/time might later)
  supaUpsertCallProgress(campaignId, contactId, c).catch(() => {});
  return p;
}

export async function recordNote(campaignId, contactId, text) {
  const p = await loadOrInitProgress(campaignId, []);
  const c = p.contacts[contactId] || defaultContact();

  c.notes = String(text || "");
  c.notesLogs = c.notesLogs || [];
  const at = Date.now();
  c.notesLogs.push({ text: c.notes, at });
  if (c.notesLogs.length > 10) c.notesLogs = c.notesLogs.slice(-10);

  p.contacts[contactId] = c;
  saveProgress(p);

  // write-through (append-only)
  supaInsertNoteLog(campaignId, contactId, c.notes, at).catch(() => {});
  return c.notes;
}

export async function getSurveyResponse(campaignId, contactId) {
  const p = await loadOrInitProgress(campaignId, []);
  return p.contacts?.[contactId]?.surveyAnswer ?? null;
}

export async function getNote(campaignId, contactId) {
  const p = await loadOrInitProgress(campaignId, []);
  return p.contacts?.[contactId]?.notes ?? "";
}

export async function getSummary(campaignId) {
  const p = await loadOrInitProgress(campaignId, []);
  return p.totals || { total: 0, made: 0, answered: 0, missed: 0 };
}

/* ---------------- CSV helpers + export-row persistence ---------------- */

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exports survey logs as CSV and ALSO stores the exact rows as JSON in `export_full_rows` if you pass them. */
export async function exportSurveyCSV(campaignId) {
  const p = await loadOrInitProgress(campaignId, []);
  const rows = [["contactId","answer","timestamp"]];
  const jsonRows = []; // for Supabase storage

  for (const [id, c] of Object.entries(p.contacts)) {
    if (Array.isArray(c.surveyLogs) && c.surveyLogs.length) {
      for (const log of c.surveyLogs) {
        const rowObj = { contactId: id, answer: String(log.answer ?? ""), timestamp: new Date(log.at || 0).toISOString() };
        jsonRows.push(rowObj);
        rows.push([rowObj.contactId, rowObj.answer, rowObj.timestamp]);
      }
    } else if (c.surveyAnswer) {
      const rowObj = { contactId: id, answer: String(c.surveyAnswer), timestamp: new Date(c.lastCalledAt || 0).toISOString() };
      jsonRows.push(rowObj);
      rows.push([rowObj.contactId, rowObj.answer, rowObj.timestamp]);
    }
  }

  // Persist exact rows as JSON if you want this considered a "full" export
  // (If you prefer a different trigger, call persistFullExportRows from Dashboard instead.)
  supaInsertExportRows("export_full_rows", campaignId, jsonRows).catch(() => {});

  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

/** Exports call outcomes as CSV and stores exact rows in `export_full_rows` as well. */
export async function exportCallOutcomesCSV(campaignId) {
  const p = await loadOrInitProgress(campaignId, []);
  const rows = [["contactId","outcome","timestamp"]];
  const jsonRows = [];

  for (const [id, c] of Object.entries(p.contacts)) {
    const rowObj = { contactId: id, outcome: String(c.outcome ?? ""), timestamp: new Date(c.lastCalledAt || 0).toISOString() };
    jsonRows.push(rowObj);
    rows.push([rowObj.contactId, rowObj.outcome, rowObj.timestamp]);
  }

  supaInsertExportRows("export_full_rows", campaignId, jsonRows).catch(() => {});
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

/**
 * Build a "Not Called" list with full_name using resolver.
 * We also expose CSV export which persists to `export_not_called_rows`.
 */
export async function getNotCalledIds(campaignId, queueIds = []) {
  const p = await loadOrInitProgress(campaignId, queueIds);
  const notCalled = [];
  for (const id of queueIds) {
    const c = p.contacts[id];
    if (!c || !c.attempts) notCalled.push(id);
  }
  return notCalled;
}

export async function getNotCalled(campaignId, queueIds = [], resolver) {
  const ids = await getNotCalledIds(campaignId, queueIds);
  const rows = ids.map(id => ({ contactId: id, full_name: resolveName(resolver, id) }));
  rows.sort((a,b) => a.full_name.localeCompare(b.full_name));
  return rows;
}

export async function exportNotCalledCSV(campaignId, queueIds = [], resolver) {
  const rows = await getNotCalled(campaignId, queueIds, resolver);
  // Persist exact rows as JSON array of objects {contactId, full_name}
  supaInsertExportRows("export_not_called_rows", campaignId, rows).catch(() => {});

  const csvRows = [["contactId","full_name"], ...rows.map(r => [r.contactId, r.full_name])];
  return csvRows.map(r => r.map(csvEscape).join(",")).join("\n");
}

/* ---------------- Optional: let Dashboard persist its own "Full CSV" row set ---------------- */

/**
 * If your Dashboard constructs a richer "Full CSV" (e.g., merges students + progress),
 * call this to store the exact JSON rows you used to build the CSV.
 * `rows` must be an array of plain objects — we store them as-is inside `row` jsonb.
 */
export async function persistFullExportRows(campaignId, rows) {
  await supaInsertExportRows("export_full_rows", campaignId, Array.isArray(rows) ? rows : []);
}

/* ---------------- Local helpers for name resolution ---------------- */

function resolveName(resolver, id) {
  if (!resolver) return "";
  if (typeof resolver === "function") {
    const v = resolver(id);
    return pickName(v);
  }
  if (typeof resolver === "object") {
    const v = (resolver.get && resolver.get(id)) || resolver[id];
    return pickName(v);
  }
  return "";
}

function pickName(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "object") {
    const f =
      val.full_name ??
      val.fullName ??
      val["Full Name*"] ??
      joinNames(val.first_name, val.last_name);
    return String(f || "").trim();
  }
  return String(val || "").trim();
}

function joinNames(first, last) {
  const a = String(first || "").trim();
  const b = String(last || "").trim();
  return (a + " " + b).trim();
}

/* ---------------- Maintenance ---------------- */

export async function removeProgress(campaignId) {
  try { localStorage.removeItem(K.PROG_PREFIX + campaignId); } catch {}
}
