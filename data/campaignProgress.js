// data/campaignProgress.js

const K = {
  PROG_PREFIX: "reachpoint.progress.",   // per-campaign object (local cache)
  SURVEY_PREFIX: "reachpoint.survey.",   // simple presence marker
};

// ---------- local helpers ----------
function saveProgress(p) { try { localStorage.setItem(K.PROG_PREFIX + p.campaignId, JSON.stringify(p)); } catch {} }
function loadProgressLocal(campaignId) {
  try { return JSON.parse(localStorage.getItem(K.PROG_PREFIX + campaignId) || "null"); } catch { return null; }
}
function supa() { return (window.hasSupabase && window.hasSupabase()) ? window.supabase : null; }

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

// ---------- Supabase write-through helpers ----------
async function supaUpsertCallProgress(campaignId, contactId, c) {
  const s = supa(); if (!s) return;
  const row = {
    campaign_id: campaignId,
    contact_id:  contactId,
    attempts:    c.attempts ?? 0,
    outcome:     c.outcome ?? null,
    last_called_at: c.lastCalledAt ? new Date(c.lastCalledAt).toISOString() : null,
  };
  const { error } = await s.from("call_progress").upsert(row, { onConflict: "campaign_id,contact_id" });
  if (error) console.warn("[ReachPoint] call_progress upsert failed:", error);
}

async function supaInsertSurveyLog(campaignId, contactId, answer, atMs) {
  const s = supa(); if (!s) return;
  const { error } = await s.from("survey_responses").insert({
    campaign_id: campaignId,
    contact_id:  contactId,
    answer:      String(answer ?? ""),
    at:          new Date(atMs).toISOString()
  });
  if (error) console.warn("[ReachPoint] survey_responses insert failed:", error);
}

async function supaInsertNoteLog(campaignId, contactId, text, atMs) {
  const s = supa(); if (!s) return;
  const { error } = await s.from("notes").insert({
    campaign_id: campaignId,
    contact_id:  contactId,
    text:        String(text ?? ""),
    at:          new Date(atMs).toISOString()
  });
  if (error) console.warn("[ReachPoint] notes insert failed:", error);
}

async function supaInsertExportRows(table, campaignId, rows) {
  const s = supa(); if (!s || !Array.isArray(rows) || !rows.length) return;
  const exported_at = new Date().toISOString();
  const payload = rows.map(r => ({ campaign_id: campaignId, row: r, exported_at }));
  const { error } = await s.from(table).insert(payload);
  if (error) console.warn(`[ReachPoint] ${table} insert failed:`, error);
}

// ---------- Core progress API (local-first, write-through to Supabase) ----------
export async function loadOrInitProgress(campaignId, queueIds = []) {
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

  try { localStorage.setItem(K.SURVEY_PREFIX + campaignId, "1"); } catch {}

  // write-through (append-only) + keep progress synced
  supaInsertSurveyLog(campaignId, contactId, answer, at).catch(() => {});
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

// ---------- CSV helpers + export-row persistence ----------
function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exports survey logs as CSV and ALSO stores the exact rows in `export_full_rows`. */
export async function exportSurveyCSV(campaignId) {
  const p = await loadOrInitProgress(campaignId, []);
  const rows = [["contactId","answer","timestamp"]];
  const jsonRows = [];

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

  supaInsertExportRows("export_full_rows", campaignId, jsonRows).catch(() => {});
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

/** Exports call outcomes as CSV and stores exact rows in `export_full_rows`. */
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

/** "Not Called" list + CSV; also persists exact rows into `export_not_called_rows`. */
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
  supaInsertExportRows("export_not_called_rows", campaignId, rows).catch(() => {});
  const csvRows = [["contactId","full_name"], ...rows.map(r => [r.contactId, r.full_name])];
  return csvRows.map(r => r.map(csvEscape).join(",")).join("\n");
}

/** Allow Dashboard to persist its own "Full CSV" merged rows. */
export async function persistFullExportRows(campaignId, rows) {
  await supaInsertExportRows("export_full_rows", campaignId, Array.isArray(rows) ? rows : []);
}

// ---------- Server-backed progress snapshot + realtime (shared state) ----------
export async function loadProgressSnapshotFromSupabase(campaignId) {
  const s = supa();
  if (!s) return null;

  // 1) call progress rows
  const { data: cp, error: e1 } = await s
    .from("call_progress")
    .select("contact_id, attempts, outcome, last_called_at")
    .eq("campaign_id", campaignId);
  if (e1) { console.warn("call_progress error", e1); return null; }

  // 2) latest survey per contact (no RPC; table query, newest first)
  const latestSurvey = {};
  {
    const { data: allSr, error: e2 } = await s
      .from("survey_responses")
      .select("contact_id, answer, at")
      .eq("campaign_id", campaignId)
      .order("at", { ascending: false });
    if (!e2 && Array.isArray(allSr)) {
      for (const r of allSr) {
        if (!latestSurvey[r.contact_id]) latestSurvey[r.contact_id] = r; // first seen is newest
      }
    } else if (e2) {
      console.warn("[ReachPoint] survey_responses fetch failed:", e2);
    }
  }

  // 3) latest note per contact
  const latestNote = {};
  {
    const { data: allNotes, error: eN } = await s
      .from("notes")
      .select("contact_id, text, at")
      .eq("campaign_id", campaignId)
      .order("at", { ascending: false });
    if (!eN && Array.isArray(allNotes)) {
      for (const r of allNotes) {
        if (!latestNote[r.contact_id]) latestNote[r.contact_id] = r; // newest first
      }
    } else if (eN) {
      console.warn("[ReachPoint] notes fetch failed:", eN);
    }
  }

  // 4) compose snapshot
  const contacts = {};
  for (const row of (cp || [])) {
    contacts[row.contact_id] = {
      attempts: row.attempts || 0,
      outcome: row.outcome || undefined,
      lastCalledAt: row.last_called_at ? new Date(row.last_called_at).getTime() : 0,
      surveyAnswer: latestSurvey[row.contact_id]?.answer || undefined,
      surveyLogs: [], // logs are still kept client-side; server is append-only
      notes: latestNote[row.contact_id]?.text || "",
      notesLogs: [],
    };
  }

  const ids = Object.keys(contacts);
  const totals = {
    total: ids.length,
    made: ids.filter(id => (contacts[id].attempts || 0) > 0).length,
    answered: ids.filter(id => contacts[id].outcome === "answered").length,
    missed: ids.filter(id => contacts[id].outcome === "no_answer").length,
  };

  return { campaignId, totals, contacts };
}

export function subscribeToCampaignProgress(campaignId, onChange) {
  const s = supa();
  if (!s) return () => {};
  const ch = s.channel(`progress-${campaignId}`)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "call_progress",   filter: `campaign_id=eq.${campaignId}` },
      onChange
    )
    .on("postgres_changes",
      { event: "*", schema: "public", table: "survey_responses", filter: `campaign_id=eq.${campaignId}` },
      onChange
    )
    .on("postgres_changes",
      { event: "*", schema: "public", table: "notes",             filter: `campaign_id=eq.${campaignId}` },
      onChange
    )
    .subscribe();
  return () => s.removeChannel(ch);
}

// ---------- Maintenance ----------
export async function removeProgress(campaignId) {
  try { localStorage.removeItem(K.PROG_PREFIX + campaignId); } catch {}
}

// ---------- name resolution helpers ----------
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

/*
  (Optional) DB performance tip:
  Add this index once to keep the "latest per contact" fetch fast.

  create index if not exists idx_survey_responses_campaign_contact_at
    on public.survey_responses (campaign_id, contact_id, at desc);
*/
