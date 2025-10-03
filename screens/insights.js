// screens/insights.js
import {
  listCampaigns,
  getCampaignById,
  getAllStudents,
  applyFilters,
  getStudentId
} from '../data/campaignsData.js';

import {
  loadProgressSnapshotFromSupabase,
  loadOrInitProgress
} from "../data/campaignProgress.js";

/* ------------- tiny DOM helpers ------------- */
function div(cls, style = {}) {
  const n = document.createElement('div');
  if (cls) n.className = cls;
  Object.assign(n.style, style);
  return n;
}
function h2(text) {
  const n = document.createElement('div');
  n.textContent = text;
  n.style.fontSize = '18px';
  n.style.fontWeight = '800';
  n.style.margin = '12px 0 8px';
  return n;
}
function chartCanvas(id) {
  const wrap = div('', { width: '100%', maxWidth: '980px', margin: '8px auto' });
  const c = document.createElement('canvas');
  c.id = id;
  c.style.width = '100%';
  c.style.maxHeight = '360px';
  wrap.appendChild(c);
  return { wrap, canvas: c };
}
function destroyChart(maybe) {
  if (maybe && typeof maybe.destroy === 'function') {
    try { maybe.destroy(); } catch {}
  }
}

/* ------------- data helpers ------------- */
function pickName(stu) {
  if (!stu) return '';
  const a = String(stu.first_name || '').trim();
  const b = String(stu.last_name || '').trim();
  const fallback = stu.full_name || stu.fullName || stu['Full Name*'] || '';
  return (a || b) ? `${a} ${b}`.trim() : String(fallback || '').trim();
}
function getGradYear(stu) {
  const keys = [
    'High School Graduation Year*',
    'High School Graduation Year',
    'Graduation Year',
    'HS Grad Year',
    'Grad Year'
  ];
  for (const k of keys) {
    const v = stu?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return 'Unknown';
}
function toDateSafe(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

/** Build the *same* queue + id->student map as Execute, including intersection with student_ids */
function buildQueueMap(students, campaign) {
  let filtered = applyFilters(students, campaign?.filters || []);

  // Intersect with campaign.student_ids/studentIds if present (mirror of Execute)
  const rawIds = campaign?.student_ids ?? campaign?.studentIds ?? null;
  let studentIds = null;
  if (Array.isArray(rawIds)) {
    studentIds = rawIds.map(String);
  } else if (typeof rawIds === 'string') {
    try {
      const arr = JSON.parse(rawIds);
      if (Array.isArray(arr)) studentIds = arr.map(String);
    } catch {}
  }

  if (studentIds && studentIds.length) {
    const set = new Set(studentIds);
    const primaryKey = (s) => String(s?.id ?? s?.student_id ?? s?.uuid ?? '');
    filtered = filtered.filter((s, i) => set.has(primaryKey(s)) || set.has(getStudentId(s, i)));
  }

  const queueIds = filtered.map((s, i) => getStudentId(s, i));
  const idToStudent = {};
  filtered.forEach((s, i) => { idToStudent[getStudentId(s, i)] = s; });
  return { queueIds, idToStudent };
}

/** Flatten progress.contacts into chartable rows */
function extractRowsForCampaign(progress, idToStudent, campaignMeta) {
  const rows = [];
  const contacts = progress?.contacts || {};
  for (const [studentId, c] of Object.entries(contacts)) {
    const stu = idToStudent[studentId] || null;
    const fullName = pickName(stu);

    const response = c?.surveyAnswer ?? c?.outcome ?? null;
    const notes = String(c?.notes ?? '');

    // prefer surveyLogs last timestamp, else lastCalledAt
    let ts = c?.lastCalledAt || 0;
    if (Array.isArray(c?.surveyLogs) && c.surveyLogs.length > 0) {
      const last = c.surveyLogs[c.surveyLogs.length - 1];
      if (last?.at) ts = last.at;
    }
    const timestamp = ts ? new Date(ts).toISOString() : '';

    rows.push({
      fullName,
      response,
      notes,
      timestamp,
      studentId,
      campaignId: String(campaignMeta.id),
      campaignName: campaignMeta.name || ''
    });
  }
  return rows;
}

/* ------------- charts ------------- */
function overallResponseBar(ctx, counts) {
  const labels = Object.keys(counts);
  const data = labels.map(k => counts[k]);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Count', data }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}
function answeredByGradYearPie(ctx, rows, idToStudent) {
  const answered = rows.filter(r => String(r.response).toLowerCase() === 'answered');
  const bucket = {};
  for (const r of answered) {
    const gy = getGradYear(idToStudent[r.studentId]);
    bucket[gy] = (bucket[gy] || 0) + 1;
  }
  const labels = Object.keys(bucket);
  const data = labels.map(k => bucket[k]);
  return new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ label: 'Answered', data }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
  });
}
function responsesByHourLine(ctx, rows) {
  const answered = rows
    .filter(r => String(r.response).toLowerCase() === 'answered')
    .map(r => toDateSafe(r.timestamp))
    .filter(Boolean);
  const hours = new Array(24).fill(0);
  for (const d of answered) hours[d.getHours()] += 1;
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [...Array(24).keys()].map(h => `${h}:00`), datasets: [{ label: 'Answered', data: hours, tension: 0.25 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}
function responsesByDOWLine(ctx, rows) {
  const answered = rows
    .filter(r => String(r.response).toLowerCase() === 'answered')
    .map(r => toDateSafe(r.timestamp))
    .filter(Boolean);
  const dow = new Array(7).fill(0);
  for (const d of answered) dow[d.getDay()] += 1;
  const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Answered', data: dow, tension: 0.25 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

/* ------------- main screen ------------- */
export async function Insights(root) {
  // layout shell
  root.innerHTML = '';
  const page = div('', { padding: '16px' });
  const header = div('', {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    maxWidth: '980px',
    margin: '0 auto 8px'
  });
  const title = document.createElement('div');
  title.textContent = 'Insights';
  title.style.fontWeight = '800';
  title.style.fontSize = '22px';

  const selectWrap = div('', { display: 'flex', gap: '8px', alignItems: 'center' });
  const label = document.createElement('label');
  label.textContent = 'Campaign:';
  label.style.fontWeight = '600';
  const picker = document.createElement('select');
  picker.style.padding = '6px 10px';
  picker.style.border = '1px solid #d1d5db';
  picker.style.borderRadius = '8px';
  picker.style.background = '#fff';
  selectWrap.append(label, picker);
  header.append(title, selectWrap);

  const sectionWrap = div('', { maxWidth: '980px', margin: '0 auto' });

  // Descriptive statistics
  const desc = div('', { marginTop: '8px' });
  desc.append(h2('Descriptive Statistics'));

  const overallBlock = div('', { marginTop: '6px' });
  const overallTitle = document.createElement('div');
  overallTitle.textContent = 'Overall Response / Outcome Breakdown';
  overallTitle.style.fontWeight = '700';
  overallTitle.style.margin = '8px 0';
  const overallCan = chartCanvas('overallResponsesChart');
  overallBlock.append(overallTitle, overallCan.wrap);

  const gyBlock = div('', { marginTop: '6px' });
  const gyTitle = document.createElement('div');
  gyTitle.textContent = 'Answered Distribution by High School Graduation Year*';
  gyTitle.style.fontWeight = '700';
  gyTitle.style.margin = '8px 0';
  const gyCan = chartCanvas('responsesByGradYearChart');
  gyBlock.append(gyTitle, gyCan.wrap);

  desc.append(overallBlock, gyBlock);

  // Call statistics
  const calls = div('', { marginTop: '16px' });
  calls.append(h2('Call Statistics'));

  const todBlock = div('', { marginTop: '6px' });
  const todTitle = document.createElement('div');
  todTitle.textContent = 'Responses by Hour of Day';
  todTitle.style.fontWeight = '700';
  todTitle.style.margin = '8px 0';
  const todCan = chartCanvas('responsesByHourChart');
  todBlock.append(todTitle, todCan.wrap);

  const dowBlock = div('', { marginTop: '6px' });
  const dowTitle = document.createElement('div');
  dowTitle.textContent = 'Responses by Day of Week';
  dowTitle.style.fontWeight = '700';
  dowTitle.style.margin = '8px 0';
  const dowCan = chartCanvas('responsesByDOWChart');
  dowBlock.append(dowTitle, dowCan.wrap);

  calls.append(todBlock, dowBlock);

  sectionWrap.append(desc, calls);
  page.append(header, sectionWrap);
  root.appendChild(page);

  // State
  let charts = { overall: null, gy: null, hour: null, dow: null };
  let students = [];
  let campaignList = [];

  // Load base data (Supabase-first via campaignsData helpers)
  try {
    students = await getAllStudents();
  } catch (e) {
    console.error('Insights: failed to load students', e);
  }
  try {
    const allCampaigns = await listCampaigns();
    campaignList = Array.isArray(allCampaigns) ? allCampaigns : [];
  } catch (e) {
    console.error('Insights: failed to list campaigns', e);
    campaignList = [];
  }

  // Active campaigns (default to all if you don't track "active")
  const activeCampaigns = campaignList.filter(c => c?.active !== false);

  // Populate dropdown
  picker.innerHTML = '';
  if (activeCampaigns.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No campaigns';
    picker.appendChild(opt);
    picker.disabled = true;
  } else {
    for (const c of activeCampaigns) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || `Campaign ${c.id}`;
      picker.appendChild(opt);
    }
  }

  async function renderForCampaign(campaignId) {
    if (!campaignId) return;

    const campaign = await getCampaignById(campaignId); // Supabase-first
    if (!campaign) {
      console.warn('Insights: campaign not found', campaignId);
      return;
    }

    // Build queue like Execute (includes intersection with student_ids)
    const { queueIds, idToStudent } = buildQueueMap(students, campaign);

    // Prefer shared/server progress; fallback to local
    let progress = null;
    try {
      const snap = await loadProgressSnapshotFromSupabase(campaign.id);
      progress = snap || await loadOrInitProgress(campaign.id, queueIds);
    } catch (e) {
      console.warn('Insights: server snapshot failed, using local', e);
      progress = await loadOrInitProgress(campaign.id, queueIds);
    }

    // Derive rows for charts
    const rows = extractRowsForCampaign(progress, idToStudent, { id: campaign.id, name: campaign.name });

    // Tally outcomes/survey answers
    const counts = {};
    for (const r of rows) {
      const key = (r.response ?? 'unknown').toString();
      counts[key] = (counts[key] || 0) + 1;
    }

    // Rebuild charts
    destroyChart(charts.overall);
    destroyChart(charts.gy);
    destroyChart(charts.hour);
    destroyChart(charts.dow);

    const overallCtx = document.getElementById('overallResponsesChart')?.getContext('2d');
    const gyCtx      = document.getElementById('responsesByGradYearChart')?.getContext('2d');
    const hourCtx    = document.getElementById('responsesByHourChart')?.getContext('2d');
    const dowCtx     = document.getElementById('responsesByDOWChart')?.getContext('2d');

    if (overallCtx) charts.overall = overallResponseBar(overallCtx, counts);
    if (gyCtx)      charts.gy      = answeredByGradYearPie(gyCtx, rows, idToStudent);
    if (hourCtx)    charts.hour    = responsesByHourLine(hourCtx, rows);
    if (dowCtx)     charts.dow     = responsesByDOWLine(dowCtx, rows);
  }

  // initial render
  if (activeCampaigns.length > 0) {
    await renderForCampaign(activeCampaigns[0].id);
  }

  // on change
  picker.addEventListener('change', async () => {
    await renderForCampaign(picker.value);
  });
}
