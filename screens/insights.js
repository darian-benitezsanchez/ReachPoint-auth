// screens/insights.js
/* ------------------------------------------------------------------ */
/* ReachPoint Insights — Direct Supabase queries (your table names)    */
/* Uses: campaigns, v_call_progress_latest, survey_responses, students */
/* ------------------------------------------------------------------ */

/* ===== Chart.js loader ===== */
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

/* ===== DOM helpers ===== */
function div(cls, style = {}) { const n=document.createElement('div'); if (cls) n.className=cls; Object.assign(n.style, style); return n; }
function h2(text) { const n=document.createElement('div'); n.textContent=text; n.style.cssText='font-size:18px;font-weight:800;margin:12px 0 8px'; return n; }
function chartCanvas(id) {
  const wrap = div('', { width:'100%', maxWidth:'980px', margin:'8px auto' });
  const c = document.createElement('canvas');
  c.id = id; c.style.width = '100%'; c.style.maxHeight = '360px';
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

/* ===== utils ===== */
const val = (o,k,alts=[]) => {
  if (o && k in o && o[k] != null) return o[k];
  for (const a of alts) if (o && a in o && o[a] != null) return o[a];
  return undefined;
};
const str = x => (x == null ? '' : String(x));
function toDateSafe(ts){ if (!ts) return null; const d = new Date(ts); return isNaN(d.getTime()) ? null : d; }
function uniq(arr){ return Array.from(new Set(arr)); }

/* ===== direct Supabase data ===== */
async function sbListCampaigns(){
  const { data, error } = await window.supabase.from('campaigns').select('*').order('created_at', { ascending:false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: str(val(r,'id',['campaign_id'])),
    name: str(val(r,'name',['title'])),
    created_at: val(r,'created_at',['createdAt','created'])
  })).filter(c => c.id);
}

async function sbLoadProgressLatest(campaignId){
  // v_call_progress_latest exists in your project
  const { data, error } = await window.supabase
    .from('v_call_progress_latest')
    .select('*')
    .eq('campaign_id', String(campaignId));
  if (error) throw error;
  return (data || []).map(r => ({
    campaign_id: str(val(r,'campaign_id',['campaignId'])),
    contact_id:  str(val(r,'contact_id',['student_id','studentId','contactId'])),
    outcome:     val(r,'outcome',['status']),
    survey_answer: val(r,'survey_answer',['answer']),
    last_called_at: val(r,'last_called_at',['updated_at','created_at','at'])
  })).filter(r => r.contact_id);
}

async function sbLatestSurveyAnswers(campaignId, contactIds){
  const ids = uniq(contactIds).filter(Boolean);
  if (!ids.length) return new Map();
  const out = new Map();
  const CHUNK = 500;
  for (let i=0;i<ids.length;i+=CHUNK){
    const slice = ids.slice(i, i+CHUNK);
    const { data, error } = await window.supabase
      .from('survey_responses')
      .select('*')
      .eq('campaign_id', String(campaignId))
      .in('contact_id', slice);            // your table uses contact_id (not student_id)
    if (error) throw error;
    for (const r of (data || [])){
      const sid = str(val(r,'contact_id',['student_id']));
      const ans = val(r,'answer',['survey_answer']);
      const ts  = toDateSafe(val(r,'created_at',['at']))?.getTime() || 0;
      const prev = out.get(sid);
      if (!prev || ts > prev.ts) out.set(sid, { answer: ans, ts });
    }
  }
  return out;
}

async function sbFetchStudentsByIds(contactIds){
  const ids = uniq(contactIds).filter(Boolean);
  if (!ids.length) return {};
  const out = {};
  const CHUNK = 1000;
  for (let i=0;i<ids.length;i+=CHUNK){
    const slice = ids.slice(i, i+CHUNK);
    // Try match on id first
    let { data, error } = await window.supabase.from('students').select('*').in('id', slice);
    if (error) data = [];
    if (!Array.isArray(data) || data.length === 0) {
      // Fallback to student_id
      const alt = await window.supabase.from('students').select('*').in('student_id', slice);
      if (!alt.error && Array.isArray(alt.data)) data = alt.data;
    }
    for (const s of (data || [])){
      const id = str(val(s,'id',['student_id']));
      const full = str(val(s,'full_name',['fullName','Full Name*','first_name'])) || (str(s.first_name||'')+' '+str(s.last_name||'')).trim();
      const gy = str(val(s,'High School Graduation Year*',[
        'High School Graduation Year','Graduation Year','HS Grad Year','Grad Year','grad_year','graduation_year'
      ])) || 'Unknown';
      out[id] = { id, full_name: full, grad_year: gy };
    }
  }
  return out;
}

/* ===== normalization (rows → chart rows) ===== */
function normalizeRows(progressRows, latestSurveyMap, campaign){
  const out = [];
  for (const r of (progressRows || [])){
    const sid = str(r.contact_id);
    if (!sid) continue;
    const response = (r.survey_answer ?? latestSurveyMap.get(sid)?.answer ?? r.outcome ?? null);
    const ts = toDateSafe(r.last_called_at)?.toISOString() || '';
    out.push({ studentId: sid, response, timestamp: ts, campaignId: campaign.id, campaignName: campaign.name || '' });
  }
  return out;
}

/* ===== charts ===== */
function overallResponseBar(ctx, counts) {
  const labels = Object.keys(counts);
  const data = labels.map(k => counts[k]);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Count', data }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}
function answeredByGradYearPie(ctx, rows, idToStudent) {
  const answered = rows.filter(r => String(r.response).toLowerCase() === 'answered');
  const bucket = {};
  for (const r of answered) {
    const gy = (idToStudent[r.studentId]?.grad_year) || 'Unknown';
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

/* ===== empty-state helpers ===== */
function showEmpty(text) {
  const host = document.querySelector('[data-insights-empty]');
  if (!host) return;
  host.textContent = text || 'No data.';
  host.style.margin = '8px 0 12px';
  host.style.color = '#64748b';
  host.style.fontSize = '14px';
}
function clearEmpty(){ const host=document.querySelector('[data-insights-empty]'); if (host) host.textContent=''; }

/* ===== main ===== */
export async function Insights(root) {
  await ensureChart();

  // Shell
  root.innerHTML = '';
  const page = div('', { padding:'16px' });
  const header = div('', { display:'flex', justifyContent:'space-between', alignItems:'center', maxWidth:'980px', margin:'0 auto 8px' });
  const title = document.createElement('div'); title.textContent='Insights'; title.style.fontWeight='800'; title.style.fontSize='22px';

  const selectWrap = div('', { display:'flex', gap:'8px', alignItems:'center' });
  const label = document.createElement('label'); label.textContent='Campaign:'; label.style.fontWeight='600';
  const picker = document.createElement('select');
  picker.style.cssText='padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;';
  selectWrap.append(label, picker);
  header.append(title, selectWrap);

  const sectionWrap = div('', { maxWidth:'980px', margin:'0 auto' });
  sectionWrap.setAttribute('data-insights-section','1');

  const empty = document.createElement('div'); empty.setAttribute('data-insights-empty','1');
  sectionWrap.append(empty);

  const desc = div('', { marginTop:'8px' });
  desc.append(h2('Descriptive Statistics'));

  const overallBlock = div('', { marginTop:'6px' });
  const overallTitle = document.createElement('div'); overallTitle.textContent='Overall Response / Outcome Breakdown'; overallTitle.style.cssText='font-weight:700;margin:8px 0';
  const overallCan = chartCanvas('overallResponsesChart');
  overallBlock.append(overallTitle, overallCan.wrap);

  const gyBlock = div('', { marginTop:'6px' });
  const gyTitle = document.createElement('div'); gyTitle.textContent='Answered Distribution by High School Graduation Year*'; gyTitle.style.cssText='font-weight:700;margin:8px 0';
  const gyCan = chartCanvas('responsesByGradYearChart');
  gyBlock.append(gyTitle, gyCan.wrap);

  desc.append(overallBlock, gyBlock);

  const calls = div('', { marginTop:'16px' });
  calls.append(h2('Call Statistics'));

  const todBlock = div('', { marginTop:'6px' });
  const todTitle = document.createElement('div'); todTitle.textContent='Responses by Hour of Day'; todTitle.style.cssText='font-weight:700;margin:8px 0';
  const todCan = chartCanvas('responsesByHourChart');
  todBlock.append(todTitle, todCan.wrap);

  const dowBlock = div('', { marginTop:'6px' });
  const dowTitle = document.createElement('div'); dowTitle.textContent='Responses by Day of Week'; dowTitle.style.cssText='font-weight:700;margin:8px 0';
  const dowCan = chartCanvas('responsesByDOWChart');
  dowBlock.append(dowTitle, dowCan.wrap);

  calls.append(todBlock, dowBlock);

  sectionWrap.append(desc, calls);
  page.append(header, sectionWrap);
  root.appendChild(page);

  // Track chart instances for cleanup
  let charts = { overall:null, gy:null, hour:null, dow:null };

  // Load campaigns from your "campaigns" table (select * then normalize)
  let campaigns = [];
  try { campaigns = await sbListCampaigns(); }
  catch(e){ console.error('[Insights] failed to load campaigns', e); showEmpty('Could not load campaigns.'); return; }

  // Populate picker
  picker.innerHTML = '';
  if (!campaigns.length){
    const opt = document.createElement('option'); opt.value=''; opt.textContent='No campaigns';
    picker.appendChild(opt); picker.disabled = true;
    showEmpty('Create a campaign to see insights.');
    return;
  } else {
    for (const c of campaigns){
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name || `Campaign ${c.id}`;
      picker.appendChild(opt);
    }
  }

  async function renderForCampaign(campaignId){
    clearEmpty();
    const campaign = campaigns.find(c => String(c.id) === String(campaignId)) || { id: campaignId, name: '' };

    // Load latest progress rows from your view
    let rows = [];
    try { rows = await sbLoadProgressLatest(campaign.id); }
    catch(e){ console.error('[Insights] progress load failed', e); showEmpty('Could not load progress.'); return; }

    if (!rows.length){
      showEmpty('No call data yet — once outcomes/responses are recorded, stats will appear here.');
      destroyChart(charts.overall); destroyChart(charts.gy); destroyChart(charts.hour); destroyChart(charts.dow);
      destroyChartOnCanvasId('overallResponsesChart'); destroyChartOnCanvasId('responsesByGradYearChart'); destroyChartOnCanvasId('responsesByHourChart'); destroyChartOnCanvasId('responsesByDOWChart');
      const zCtx = ctxFor('overallResponsesChart'); if (zCtx) charts.overall = overallResponseBar(zCtx, { answered:0, no_answer:0, unknown:0 });
      return;
    }

    const contactIds = rows.map(r => r.contact_id).filter(Boolean);

    // If survey_answer missing, pull latest from survey_responses (uses contact_id)
    let latestSurvey = new Map();
    const hasSurvey = rows.some(r => r.survey_answer != null);
    if (!hasSurvey) {
      try { latestSurvey = await sbLatestSurveyAnswers(campaign.id, contactIds); }
      catch(e){ console.warn('[Insights] survey fallback failed', e); }
    }

    // Normalize
    const normRows = normalizeRows(rows, latestSurvey, campaign);

    // Fetch students (grad year, etc.)
    let idToStudent = {};
    try { idToStudent = await sbFetchStudentsByIds(contactIds); }
    catch(e){ console.warn('[Insights] students fetch failed', e); }

    if (!normRows.length){
      showEmpty('No data after normalization.');
      return;
    }

    // Counts
    const counts = {};
    for (const r of normRows){
      const key = String(r.response ?? 'unknown').trim().toLowerCase() || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }

    // Rebuild charts cleanly
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

  // Initial + change handler
  await renderForCampaign(picker.value || String(campaigns[0].id));
  picker.addEventListener('change', async () => { await renderForCampaign(picker.value); });

  // Cleanup on route change
  function cleanup(){
    destroyChart(charts.overall); destroyChart(charts.gy); destroyChart(charts.hour); destroyChart(charts.dow);
    destroyChartOnCanvasId('overallResponsesChart'); destroyChartOnCanvasId('responsesByGradYearChart'); destroyChartOnCanvasId('responsesByHourChart'); destroyChartOnCanvasId('responsesByDOWChart');
    charts = { overall:null, gy:null, hour:null, dow:null };
  }
  window.addEventListener('hashchange', cleanup, { once:true });
}
