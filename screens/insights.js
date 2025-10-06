// screens/insights.js
/* ------------------------------------------------------------------ */
/* ReachPoint Insights — Supabase-backed                              */
/* Uses: campaigns, v_call_progress_latest (or call_progress),        */
/*       survey_responses, students                                   */
/* ------------------------------------------------------------------ */

// ======= Chart.js lazy loader ======================================
async function ensureChart() {
  if (window.Chart) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(s);
  });
}

// ======= tiny DOM helpers ==========================================
function div(cls, style = {}) { const n=document.createElement('div'); if (cls) n.className=cls; Object.assign(n.style, style); return n; }
function h2(text) { const n=document.createElement('div'); n.textContent=text; n.style.cssText='font-size:18px;font-weight:800;margin:12px 0 8px'; return n; }
function chartCanvas(id) {
  const wrap = div('', { width:'100%', maxWidth:'980px', margin:'8px auto' });
  const c = document.createElement('canvas');
  c.id = id;
  c.style.width = '100%';
  c.style.maxHeight = '360px';
  wrap.appendChild(c);
  return { wrap, canvas: c };
}
function destroyChart(maybe){ if (maybe && typeof maybe.destroy==='function'){ try{ maybe.destroy(); }catch{} } }
function destroyChartOnCanvasId(canvasId){
  if (!window.Chart) return;
  const el = document.getElementById(canvasId);
  if (!el) return;
  const inst = window.Chart.getChart ? window.Chart.getChart(el) : null;
  if (inst){ try{ inst.destroy(); }catch{} }
}
function ctxFor(id){ destroyChartOnCanvasId(id); const el=document.getElementById(id); return el?el.getContext('2d'):null; }

// ======= small utils ===============================================
function toDateSafe(ts){
  if (ts==null) return null;
  let n = ts;
  if (typeof ts === 'string'){
    const num = Number(ts);
    if (Number.isFinite(num)) n = num;
  }
  const d = new Date(n);
  if (Number.isFinite(d.getTime())) return d;
  try {
    const d2 = new Date(String(ts));
    return Number.isFinite(d2.getTime()) ? d2 : null;
  } catch { return null; }
}
function pickName(stu){
  if (!stu) return '';
  const a = String(stu.first_name || stu.firstName || '').trim();
  const b = String(stu.last_name  || stu.lastName  || '').trim();
  const fallback = stu.full_name || stu.fullName || stu['Full Name*'] || '';
  return (a || b) ? `${a} ${b}`.trim() : String(fallback || '').trim();
}
function getGradYear(stu){
  const keys = [
    'High School Graduation Year*','High School Graduation Year','Graduation Year',
    'HS Grad Year','Grad Year','grad_year','graduation_year'
  ];
  for (const k of keys){ const v = stu?.[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return 'Unknown';
}
function uniq(arr){ return Array.from(new Set(arr)); }

// ======= Supabase data access ======================================
async function sbListCampaigns(){
  const { data, error } = await window.supabase
    .from('campaigns')
    .select('id,name,created_at')       // no "active" column
    .order('created_at', { ascending:false });
  if (error) throw error;
  return data || [];
}

/**
 * Preferred source: v_call_progress_latest
 * Fallback: call_progress (pick latest row per student per campaign)
 */
async function sbLoadProgressLatest(campaignId){
  const cid = String(campaignId);

  // try the view
  let viewErr = null;
  try {
    const { data, error } = await window.supabase
      .from('v_call_progress_latest')
      .select('*')
      .eq('campaign_id', cid);
    if (error) throw error;
    if (Array.isArray(data)) return { rows: data, from: 'view' };
  } catch(e){ viewErr = e; }

  // fallback: call_progress
  const { data, error } = await window.supabase
    .from('call_progress')
    .select('*')
    .eq('campaign_id', cid);
  if (error) throw error;

  const byStudent = new Map();
  for (const r of (data || [])){
    const sid = String(r.student_id ?? r.contact_id ?? r.studentId ?? r.contactId ?? '');
    if (!sid) continue;
    const at = Number(r.last_called_at ?? r.updated_at ?? r.created_at ?? 0) ||
               (toDateSafe(r.last_called_at || r.updated_at || r.created_at)?.getTime() || 0);
    const prev = byStudent.get(sid);
    if (!prev || at >= prev.__ts){ byStudent.set(sid, { ...r, __ts: at }); }
  }
  return { rows: Array.from(byStudent.values()), from: 'table', viewErr };
}

/** Latest survey answers (if not already present in progress rows) */
async function sbLatestSurveyAnswers(campaignId, studentIds){
  if (!studentIds.length) return new Map();
  const cid = String(campaignId);
  const ids = uniq(studentIds).filter(Boolean);
  const out = new Map();
  const CHUNK = 500;
  for (let i=0;i<ids.length;i+=CHUNK){
    const slice = ids.slice(i, i+CHUNK);
    const { data, error } = await window.supabase
      .from('survey_responses')
      .select('student_id,answer,created_at')
      .eq('campaign_id', cid)
      .in('student_id', slice);
    if (error) throw error;
    for (const r of (data || [])){
      const sid = String(r.student_id ?? r.contact_id ?? '');
      const ts = toDateSafe(r.created_at)?.getTime() || 0;
      const prev = out.get(sid);
      if (!prev || ts > prev.ts){ out.set(sid, { answer: r.answer, ts }); }
    }
  }
  return out;
}

/** Fetch students in bulk to enrich */
async function sbFetchStudentsByIds(studentIds){
  const ids = uniq(studentIds).filter(Boolean);
  if (!ids.length) return {};
  const out = {};
  const CHUNK = 1000;
  for (let i=0;i<ids.length;i+=CHUNK){
    const slice = ids.slice(i, i+CHUNK);
    // try 'id'
    const { data, error } = await window.supabase
      .from('students')
      .select('*')
      .in('id', slice);
    if (!error && Array.isArray(data) && data.length){
      for (const s of data) out[String(s.id)] = s;
      continue;
    }
    // fallback 'student_id'
    const alt = await window.supabase
      .from('students')
      .select('*')
      .in('student_id', slice);
    if (alt.error) throw alt.error;
    for (const s of (alt.data || [])) out[String(s.student_id)] = s;
  }
  return out;
}

// ======= Transform rows to chartable rows ===========================
function normalizeProgressRows(progressRows, latestSurveyMap, campaign){
  const rows = [];
  for (const r of (progressRows || [])){
    const sid = String(r.student_id ?? r.contact_id ?? r.studentId ?? r.contactId ?? '');
    if (!sid) continue;

    const outcome = (r.outcome ?? r.status ?? null);
    const survey_answer = (r.survey_answer ?? r.answer ?? latestSurveyMap.get(sid)?.answer ?? null);
    const response = survey_answer ?? outcome ?? null;

    const tsRaw = r.last_called_at ?? r.updated_at ?? r.created_at ?? r.at ?? null;
    const ts = toDateSafe(tsRaw)?.toISOString() || '';

    rows.push({
      studentId: sid,
      response,
      timestamp: ts,
      campaignId: String(campaign.id),
      campaignName: campaign.name || ''
    });
  }
  return rows;
}

// ======= Charts =====================================================
function overallResponseBar(ctx, counts) {
  const labels = Object.keys(counts);
  const data = labels.map(k => counts[k]);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Count', data }] },
    options: {
      responsive: true, maintainAspectRatio: false,
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
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
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
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
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
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

// ======= Empty state helpers =======================================
function showEmpty(text) {
  const host = document.querySelector('[data-insights-empty]');
  if (!host) return;
  host.textContent = text || 'No data.';
  host.style.margin = '8px 0 12px';
  host.style.color = '#64748b';
  host.style.fontSize = '14px';
}
function clearEmpty(){ const host=document.querySelector('[data-insights-empty]'); if (host) host.textContent=''; }

// ======= Main screen ===============================================
export async function Insights(root) {
  await ensureChart();

  // Shell
  root.innerHTML = '';
  const page = div('', { padding:'16px' });
  const header = div('', { display:'flex', justifyContent:'space-between', alignItems:'center', maxWidth:'980px', margin:'0 auto 8px' });
  const title = document.createElement('div');
  title.textContent = 'Insights';
  title.style.fontWeight = '800'; title.style.fontSize = '22px';

  const selectWrap = div('', { display:'flex', gap:'8px', alignItems:'center' });
  const label = document.createElement('label'); label.textContent = 'Campaign:'; label.style.fontWeight='600';
  const picker = document.createElement('select');
  picker.style.cssText='padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;';
  selectWrap.append(label, picker);
  header.append(title, selectWrap);

  const sectionWrap = div('', { maxWidth:'980px', margin:'0 auto' });
  sectionWrap.setAttribute('data-insights-section','1');

  const empty = document.createElement('div');
  empty.setAttribute('data-insights-empty','1');
  sectionWrap.append(empty);

  const desc = div('', { marginTop:'8px' });
  desc.append(h2('Descriptive Statistics'));

  const overallBlock = div('', { marginTop:'6px' });
  const overallTitle = document.createElement('div');
  overallTitle.textContent = 'Overall Response / Outcome Breakdown';
  overallTitle.style.cssText='font-weight:700;margin:8px 0';
  const overallCan = chartCanvas('overallResponsesChart');
  overallBlock.append(overallTitle, overallCan.wrap);

  const gyBlock = div('', { marginTop:'6px' });
  const gyTitle = document.createElement('div');
  gyTitle.textContent = 'Answered Distribution by High School Graduation Year*';
  gyTitle.style.cssText='font-weight:700;margin:8px 0';
  const gyCan = chartCanvas('responsesByGradYearChart');
  gyBlock.append(gyTitle, gyCan.wrap);

  desc.append(overallBlock, gyBlock);

  const calls = div('', { marginTop:'16px' });
  calls.append(h2('Call Statistics'));

  const todBlock = div('', { marginTop:'6px' });
  const todTitle = document.createElement('div');
  todTitle.textContent = 'Responses by Hour of Day';
  todTitle.style.cssText='font-weight:700;margin:8px 0';
  const todCan = chartCanvas('responsesByHourChart');
  todBlock.append(todTitle, todCan.wrap);

  const dowBlock = div('', { marginTop:'6px' });
  const dowTitle = document.createElement('div');
  dowTitle.textContent = 'Responses by Day of Week';
  dowTitle.style.cssText='font-weight:700;margin:8px 0';
  const dowCan = chartCanvas('responsesByDOWChart');
  dowBlock.append(dowTitle, dowCan.wrap);

  calls.append(todBlock, dowBlock);

  sectionWrap.append(desc, calls);
  page.append(header, sectionWrap);
  root.appendChild(page);

  // Track chart instances for cleanup
  let charts = { overall:null, gy:null, hour:null, dow:null };

  // Load campaigns
  let campaigns = [];
  try { campaigns = await sbListCampaigns(); }
  catch(e){ console.error('[Insights] failed to load campaigns', e); showEmpty('Could not load campaigns.'); return; }

  // Populate picker (no active filtering)
  picker.innerHTML = '';
  const active = campaigns; // as requested — no filtering
  if (!active.length){
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No campaigns';
    picker.appendChild(opt); picker.disabled = true;
    showEmpty('Create a campaign to see insights.');
    return;
  } else {
    for (const c of active){
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name || `Campaign ${c.id}`;
      picker.appendChild(opt);
    }
  }

  async function renderForCampaign(campaignIdRaw){
    clearEmpty();
    const campaignId = String(campaignIdRaw || '');
    if (!campaignId) return;

    const campaign = active.find(c => String(c.id) === campaignId) || { id: campaignId, name: '' };

    // Load latest progress (view -> fallback)
    let latest;
    try { latest = await sbLoadProgressLatest(campaignId); }
    catch(e){ console.error('[Insights] progress load failed', e); showEmpty('Could not load progress.'); return; }

    const progressRows = latest.rows || [];
    if (!progressRows.length){
      showEmpty('No call data yet — once you record outcomes, stats will appear here.');
      // Draw zeroed charts for clarity
      destroyChart(charts.overall); destroyChart(charts.gy); destroyChart(charts.hour); destroyChart(charts.dow);
      destroyChartOnCanvasId('overallResponsesChart'); destroyChartOnCanvasId('responsesByGradYearChart'); destroyChartOnCanvasId('responsesByHourChart'); destroyChartOnCanvasId('responsesByDOWChart');
      const zCounts = { answered:0, no_answer:0, unknown:0 };
      const overallCtx = ctxFor('overallResponsesChart'); if (overallCtx) charts.overall = overallResponseBar(overallCtx, zCounts);
      return;
    }

    // Supplement with latest survey answers when not present in rows
    const studentIds = progressRows.map(r => String(r.student_id ?? r.contact_id ?? r.studentId ?? r.contactId ?? '')).filter(Boolean);
    let latestSurvey = new Map();
    try {
      const hasSurveyField = progressRows.some(r => r.survey_answer != null || r.answer != null);
      if (!hasSurveyField) latestSurvey = await sbLatestSurveyAnswers(campaignId, studentIds);
    } catch(e){ console.warn('[Insights] survey fallback failed', e); }

    // Build normalized rows
    const normRows = normalizeProgressRows(progressRows, latestSurvey, campaign);

    // Fetch students for enrichment (grad year)
    let idToStudent = {};
    try { idToStudent = await sbFetchStudentsByIds(studentIds); }
    catch(e){ console.warn('[Insights] students fetch failed', e); }

    if (!normRows.length){
      showEmpty('No data after normalization.');
      return;
    }

    // Tally outcomes
    const counts = {};
    for (const r of normRows){
      const key = String(r.response ?? 'unknown').trim().toLowerCase() || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }

    // Rebuild charts
    destroyChart(charts.overall); destroyChart(charts.gy); destroyChart(charts.hour); destroyChart(charts.dow);
    destroyChartOnCanvasId('overallResponsesChart'); destroyChartOnCanvasId('responsesByGradYearChart'); destroyChartOnCanvasId('responsesByHourChart'); destroyChartOnCanvasId('responsesByDOWChart');

    const overallCtx = ctxFor('overallResponsesChart');
    const gyCtx      = ctxFor('responsesByGradYearChart');
    const hourCtx    = ctxFor('responsesByHourChart');
    const dowCtx     = ctxFor('responsesByDOWChart');

    if (overallCtx) charts.overall = overallResponseBar(overallCtx, counts);
    if (gyCtx)      charts.gy      = answeredByGradYearPie(gyCtx, normRows, idToStudent);
    if (hourCtx)    charts.hour    = responsesByHourLine(hourCtx, normRows);
    if (dowCtx)     charts.dow     = responsesByDOWLine(dowCtx, normRows);
  }

  // Initial render
  await renderForCampaign(picker.value || String(active[0].id));

  // Change handler
  picker.addEventListener('change', async () => {
    await renderForCampaign(picker.value);
  });

  // Cleanup on route change
  function cleanup(){
    destroyChart(charts.overall); destroyChart(charts.gy); destroyChart(charts.hour); destroyChart(charts.dow);
    destroyChartOnCanvasId('overallResponsesChart'); destroyChartOnCanvasId('responsesByGradYearChart'); destroyChartOnCanvasId('responsesByHourChart'); destroyChartOnCanvasId('responsesByDOWChart');
    charts = { overall:null, gy:null, hour:null, dow:null };
  }
  window.addEventListener('hashchange', cleanup, { once:true });
}
