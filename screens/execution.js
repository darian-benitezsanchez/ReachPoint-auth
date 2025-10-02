// screens/execution.js
import {
  getAllStudents,
  applyFilters,
  getStudentId,
  getCampaignById,
} from '../data/campaignsData.js';

import {
  loadProgressSnapshotFromSupabase,
  subscribeToCampaignProgress,
  recordOutcome,
  recordSurveyResponse,
  recordNote,
  loadOrInitProgress,
  getSurveyResponse,
  getNote,
  getSummary,
} from "../data/campaignProgress.js";

/* ------------ tiny hash helper: #/execute/<id> ------------- */
function hashCampaignId() {
  try {
    const m = (location.hash || '').match(/#\/execute\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/* ------------ robust campaign hydration -------------------- */
async function resolveCampaign(campaignMaybe) {
  if (campaignMaybe && typeof campaignMaybe.then === 'function') {
    campaignMaybe = await campaignMaybe;
  }
  if (campaignMaybe?.id && (campaignMaybe.name || campaignMaybe.filters || campaignMaybe.student_ids)) {
    return campaignMaybe;
  }
  const id = campaignMaybe?.id || hashCampaignId();
  if (!id) return null;
  const fresh = await getCampaignById(id);
  return fresh || { id, name: '(unknown)', filters: [], student_ids: null };
}

export async function Execute(root, campaignInput) {
  const campaign = await resolveCampaign(campaignInput);
  if (!campaign?.id) { location.hash = '#/dashboard'; return; }

  root.innerHTML = '';
  const wrap = document.createElement('div');

  let students = [];
  let filtered = [];
  let queueIds = [];
  const idToStudent = {};

  let progress = null;
  let mode = 'idle';                // 'idle' | 'running' | 'summary' | 'missed'
  let passStrategy = 'unattempted'; // 'unattempted' | 'missed'
  let currentId = undefined;
  let selectedSurveyAnswer = null;
  let currentNotes = '';

  const undoStack = [];

  // ======= BOOT (server-first with fallback) =======
  let unsubscribe = null;
  try {
    students = await getAllStudents();

    // 1) Filter
    filtered = applyFilters(students, campaign.filters || []);

    // 2) Intersect with campaign.student_ids if present
    const studentIds = (() => {
      const sids = campaign.student_ids;
      if (!sids) return null;
      if (Array.isArray(sids)) return sids.map(String);
      if (typeof sids === 'string') {
        try {
          const arr = JSON.parse(sids);
          return Array.isArray(arr) ? arr.map(String) : null;
        } catch { return null; }
      }
      return null;
    })();

    if (studentIds && studentIds.length) {
      const set = new Set(studentIds.map(String));
      const primaryKey = (s) => String(s?.id ?? s?.student_id ?? s?.uuid ?? '');
      filtered = filtered.filter((s, i) => {
        return set.has(primaryKey(s)) || set.has(getStudentId(s, i));
      });
    }

    // 3) Build queue + id map
    queueIds = filtered.map((s, i) => getStudentId(s, i));
    filtered.forEach((s, i) => { idToStudent[getStudentId(s, i)] = s; });

    // Snapshots
    const remote = await loadProgressSnapshotFromSupabase(campaign.id);
    const local  = await loadOrInitProgress(campaign.id, queueIds);
    progress = remote ? mergeProgress(local, remote) : local;

    // Live updates
    if (typeof subscribeToCampaignProgress === 'function') {
      unsubscribe = subscribeToCampaignProgress(campaign.id, async () => {
        try {
          const r = await loadProgressSnapshotFromSupabase(campaign.id);
          if (r) { progress = mergeProgress(progress, r); render(); }
        } catch (e) { console.warn('[Execute] live refresh failed', e); }
      });
    }
  } catch (err) {
    showError(err);
    return;
  }

  function totals() { return (progress && progress.totals) || { total:0, made:0, answered:0, missed:0 }; }
  function pct() { const t=totals(); return t.total ? t.made / t.total : 0; }

  function pickNextId(p, strategy, skipId){
    if (!p) return undefined;
    if (strategy === 'unattempted'){
      for (const id of queueIds){
        if (id === skipId) continue;
        const c = p.contacts[id];
        if (!c || c.attempts === 0) return id;
      }
      return undefined;
    }
    for (const id of queueIds){
      if (id === skipId) continue;
      const c = p.contacts[id];
      if (c?.outcome === 'no_answer') return id;
    }
    return undefined;
  }

  async function advance(strategy, skipId){
    try {
      const r = await loadProgressSnapshotFromSupabase(campaign.id);
      if (r) progress = mergeProgress(progress, r);
      else   progress = await loadOrInitProgress(campaign.id, queueIds);
    } catch {
      progress = await loadOrInitProgress(campaign.id, queueIds);
    }

    currentId = pickNextId(progress, strategy, skipId);
    selectedSurveyAnswer = null;
    currentNotes = '';
    if (!currentId) mode = 'summary';
    render();
  }

  async function beginCalls(){ passStrategy='unattempted'; mode='running'; await advance('unattempted'); }
  async function beginMissed(){ passStrategy='missed'; mode='missed'; await advance('missed'); }

  async function onSelectSurvey(ans){
    if (!currentId) return;
    const prev = await getSurveyResponse(campaign.id, currentId);
    undoStack.push({ type:'survey', campaignId: campaign.id, studentId: currentId, prev, next: ans });

    selectedSurveyAnswer = ans;
    await recordSurveyResponse(campaign.id, currentId, ans);

    try {
      const r = await loadProgressSnapshotFromSupabase(campaign.id);
      if (r) progress = mergeProgress(progress, r);
    } catch {}

    render();
  }

  async function onOutcome(kind){
    if (!currentId) return;
    undoStack.push({
      type: 'outcome',
      campaignId: campaign.id,
      studentId: currentId,
      prevMode: mode,
      prevStrategy: passStrategy
    });

    progress = await recordOutcome(campaign.id, currentId, kind);

    try {
      const r = await loadProgressSnapshotFromSupabase(campaign.id);
      if (r) progress = mergeProgress(progress, r);
    } catch {}

    const skip = passStrategy==='missed' ? currentId : undefined;
    await advance(passStrategy, skip);
  }

  async function onBack() {
    if (!undoStack.length) return;

    const last = undoStack.pop();

    if (last.type === 'survey') {
      await recordSurveyResponse(last.campaignId, last.studentId, last.prev ?? null);
      currentId = last.studentId;
      selectedSurveyAnswer = last.prev ?? null;
      if (mode!=='running' && mode!=='missed') mode = 'running';
      currentNotes = await getNote(last.campaignId, last.studentId);

      try {
        const r = await loadProgressSnapshotFromSupabase(campaign.id);
        if (r) progress = mergeProgress(progress, r);
      } catch {}

      render();
      return;
    }

    if (last.type === 'outcome' || last.type === 'nav') {
      mode = last.prevMode || 'running';
      passStrategy = last.prevStrategy || passStrategy;
      currentId = last.studentId;
      await ensureSurveyAndNotesLoaded();
      render();
      return;
    }
  }

  // ======= NO SWIPE: remove all gesture handlers; buttons only =======
  // (Intentionally no attachSwipe / pointer handlers.)

  // ======= Lazy-load current contact's survey & notes =======
  async function ensureSurveyAndNotesLoaded() {
    if (!currentId) return;
    selectedSurveyAnswer = await getSurveyResponse(campaign.id, currentId);
    currentNotes = await getNote(campaign.id, currentId);
  }

  function header() {
    const t = totals();
    const pctNum = Math.round(pct()*100);

    return div('',
      div('topHeader',
        div('headerLeft'),
        div('progressWrap',
          div('progressBar', div('progressFill'), { width: pctNum + '%' }),
          ptext(`${t.made}/${t.total} complete • ${t.answered} answered • ${t.missed} missed`,'progressText')
        )
      )
    );
  }

  function render() {
    try {
      wrap.innerHTML = '';
      wrap.append(header());

      if (mode === 'idle') {
        const idleBox = center(
          h1(campaign.name || 'Campaign'),
          ptext(`${queueIds.length} contact${queueIds.length===1?'':'s'} in this campaign`, 'muted'),
          button('Begin Calls', 'btn btn-primary', beginCalls)
        );
        wrap.append(idleBox);

        const summaryMount = div('', { margin: '6px auto 0', maxWidth: '800px' });
        wrap.append(summaryMount);

        summaryBlock(
          campaign.id,
          async () => { await beginMissed(); },
          () => { location.hash = '#/dashboard'; },
          { hideActions: true, compact: true }
        )
          .then(node => summaryMount.append(node))
          .catch(err => summaryMount.append(errorBox(err)));
      }

      if ((mode==='running' || mode==='missed') && currentId){
        ensureSurveyAndNotesLoaded();
        const stu = idToStudent[currentId] || {};
        const card = div('', { padding: '16px', paddingBottom:'36px' });

        // Header
        const headerBox = div('', {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          marginTop: '4px',
          marginBottom: '12px'
        });

        const nameNode = h1(`${String(stu.full_name ?? '')}`.trim() || 'Current contact');
        nameNode.style.textAlign = 'center';
        nameNode.style.fontWeight = '800';

        const hintNode = ptext('Use the buttons below to record the outcome.', 'hint');
        hintNode.style.textAlign = 'center';

        headerBox.append(nameNode, hintNode);

        const backBtn = button('← Back', 'btn backBtn', onBack);
        backBtn.disabled = undoStack.length === 0;
        if (backBtn.disabled) backBtn.style.opacity = '.6';

        const actions = actionRow(
          backBtn,
          button('No Answer','btn no', ()=>onOutcome('no_answer')),
          button('Answered','btn yes', ()=>onOutcome('answered'))
        );

        // Pretty details + survey + notes
        card.append(
          headerBox,
          prettyDetails(stu),
          surveyBlock(campaign.survey, selectedSurveyAnswer, onSelectSurvey),
          notesBlock(currentNotes, onChangeNotes),
          actions
        );

        wrap.append(card);
      }

      if (mode==='summary') {
        summaryBlock(
          campaign.id,
          async ()=>{ await beginMissed(); },
          ()=>{ location.hash='#/dashboard'; }
        )
          .then(b=>wrap.append(b))
          .catch(err=>wrap.append(errorBox(err)));
      }

      root.innerHTML=''; root.append(wrap);
    } catch (err) {
      showError(err);
    }
  }

  render();

  // ======= teardown on route change (and unmount) =======
  window.addEventListener('hashchange', () => {
    try { unsubscribe && unsubscribe(); } catch {}
  });

  /* ---------------- Notes UI & Handlers ---------------- */
  function debounce(fn, delay=400) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  const debouncedSaveNotes = debounce(async (cid, sid, text) => {
    try { await recordNote(cid, sid, text); } catch{}
  }, 400);

  async function onChangeNotes(text) {
    if (!currentId) return;
    currentNotes = text;
    debouncedSaveNotes(campaign.id, currentId, currentNotes);
  }

  function notesBlock(value, onChange){
    const container = div('notesCard');
    const title = h2('Notes from this call', 'notesTitle');
    title.style.marginTop = '6px';
    title.style.fontWeight = '700';

    const ta = document.createElement('textarea');
    ta.value = value || '';
    ta.rows = 4;
    ta.placeholder = 'Type any important notes here...';
    ta.style.width = '100%';
    ta.style.padding = '10px';
    ta.style.border = '1px solid #d1d5db';
    ta.style.borderRadius = '8px';
    ta.style.fontFamily = 'inherit';
    ta.style.fontSize = '14px';

    ta.addEventListener('input', () => onChange(ta.value));
    ta.addEventListener('blur', () => onChange(ta.value));

    container.append(title, ta);
    return container;
  }

  /* ---- PRETTY DETAILS CARD ---- */
  function prettyDetails(stu) {
    const v = (x) => (x==null ? '' : String(x).trim());
    const pick = (variants=[]) => {
      for (const key of Object.keys(stu||{})) {
        for (const alias of variants) {
          if (key.toLowerCase() === alias.toLowerCase()) {
            const val = v(stu[key]);
            if (val) return { key, val };
          }
        }
      }
      // fuzzy contains if exact not found
      for (const key of Object.keys(stu||{})) {
        for (const alias of variants) {
          if (key.toLowerCase().includes(alias.toLowerCase())) {
            const val = v(stu[key]);
            if (val) return { key, val };
          }
        }
      }
      return null;
    };

    const phoneVal = pick(['Mobile Phone*','Mobile Number*','mobile','phone_number','phone','Cell Phone','Student Phone']);
    const emailVal = pick(['Student Email','Email','email','Primary Email','Student Email Address']);
    const schoolVal = pick(['School','School Name']);
    const gradeVal = pick(['Grade','Current Grade','Grade Level']);
    const parentName = pick(['Parent Name','Guardian Name','Parent/Guardian Name']);
    const parentPhone = pick(['Parent Phone','Guardian Phone','Parent/Guardian Phone','Parent Mobile']);
    const parentEmail = pick(['Parent Email','Guardian Email','Parent/Guardian Email']);
    const addr = pick(['Mailing Street Address','Address','Home Address']);
    const city = pick(['Mailing City','City']);
    const state = pick(['Mailing State/Province','State']);
    const zip = pick(['Mailing Zip/Postal Code','Zip','Postal Code']);

    const summaryRows = [];
    if (schoolVal) summaryRows.push(['School', schoolVal.val]);
    if (gradeVal)  summaryRows.push(['Grade', gradeVal.val]);

    // Contact row blocks
    if (phoneVal) summaryRows.push(['Phone', phoneLinkOrText(phoneVal.val)]);
    if (emailVal) summaryRows.push(['Email', emailLink(emailVal.val)]);

    if (parentName || parentPhone || parentEmail) {
      const lines = [];
      if (parentName)  lines.push(escapeText(parentName.val));
      if (parentPhone) lines.push(nodeToString(phoneLinkOrText(parentPhone.val)));
      if (parentEmail) lines.push(nodeToString(emailLink(parentEmail.val)));
      summaryRows.push(['Parent/Guardian', htmlLines(lines)]);
    }

    const addressParts = [addr?.val, city?.val, [state?.val, zip?.val].filter(Boolean).join(' ')].filter(Boolean);
    if (addressParts.length) {
      summaryRows.push(['Address', addressParts.join(', ')]);
    }

    // Build summary card
    const card = div('detailsCard');
    card.style.width = '100%';

    for (const [k,vNodeOrText] of summaryRows) {
      const row = div('kv');
      row.append(div('k', k));
      const vCell = div('v');
      if (vNodeOrText instanceof Node) vCell.append(vNodeOrText);
      else if (typeof vNodeOrText === 'string') vCell.textContent = vNodeOrText;
      else vCell.append(vNodeOrText); // can be fragment
      row.append(vCell);
      card.append(row);
    }

    // Remaining fields (expandable)
    const knownKeys = new Set(
      [phoneVal,emailVal,schoolVal,gradeVal,parentName,parentPhone,parentEmail,addr,city,state,zip]
        .filter(Boolean)
        .map(x => x.key)
    );

    const extras = [];
    for (const k of Object.keys(stu||{})) {
      if (knownKeys.has(k)) continue;
      const val = v(stu[k]);
      if (!val) continue;
      extras.push([k, val]);
    }

    if (extras.length) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'More details';
      sum.style.cursor = 'pointer';
      det.append(sum);

      const extraCard = div('detailsCard');
      extraCard.style.marginTop = '8px';

      for (const [k,val] of extras.slice(0, 40)) {
        const row = div('kv');
        row.append(div('k', prettifyLabel(k)));
        row.append(div('v', val));
        extraCard.append(row);
      }
      det.append(extraCard);
      card.append(det);
    }

    // Top call button (if we have a phone)
    const topBtnWrap = div('', { display:'flex', justifyContent:'center', margin:'8px 0 12px' });
    const phoneRaw = phoneVal?.val || '';
    const callBtnNode = phoneRaw ? callButton(phoneRaw) : disabledBtn('No phone number');
    topBtnWrap.append(callBtnNode);

    // Return assembled block
    const outer = div('', { maxWidth:'900px', margin:'0 auto' });
    outer.append(topBtnWrap, card);
    return outer;
  }

  /* ---- Survey ---- */
  function surveyBlock(survey, sel, onPick){
    if (!survey || !survey.question || !Array.isArray(survey.options) || !survey.options.length) return div('');
    const options = survey.options.map(opt => {
      const c = chip(opt, 'surveyChip'+(sel===opt?' sel':''), ()=>onPick(opt));
      return c;
    });
    const box = div('surveyCard',
      h2(survey.question,'surveyTitle'),
      chipRow(options),
      ptext(sel ? `Saved: ${sel}` : 'Tap an option to record a response', sel ? 'surveySaved' : 'surveyHint')
    );
    return box;
  }

  // Supports options { hideActions, compact }
  async function summaryBlock(campaignId, onMissed, onFinish, opts = {}) {
    const { hideActions = false, compact = false } = opts;
    const t = await getSummary(campaignId);
    const allDone = t.missed===0 && t.made===t.total && t.total>0;

    const statsCard = cardKV([
      ['Total contacts', t.total],
      ['Calls made', t.made],
      ['Answered', t.answered],
      ['Missed', t.missed]
    ]);

    let box;
    if (compact) {
      box = div('', { margin: '6px auto 0', maxWidth: '800px' });
      const title = h2('Campaign Summary', 'summaryTitle');
      title.style.fontWeight = '800';
      title.style.textAlign = 'center';
      title.style.margin = '8px 0';
      statsCard.style.width = '100%';
      statsCard.style.margin = '0 auto';
      box.append(title, statsCard);
      if (!hideActions) {
        const actions = actionRow(
          (!allDone && t.missed>0) ? button('Proceed to Missed Contacts','btn', onMissed) : null,
          button(allDone ? 'Done' : 'Finish for now','btn btn-primary', onFinish)
        );
        actions.style.marginTop = '10px';
        box.append(actions);
      }
      return box;
    }

    box = center(
      h1('Campaign Summary'),
      statsCard,
      hideActions ? null :
        ((!allDone && t.missed>0) ? button('Proceed to Missed Contacts','btn', onMissed) : null),
      hideActions ? null : button(allDone ? 'Done' : 'Finish for now','btn btn-primary', onFinish)
    );
    return box;
  }

  /* ===== tel / email helpers ===== */
  function cleanDigits(s) { return String(s || '').replace(/[^\d+]/g, ''); }
  function toTelHref(raw, defaultCountry = '+1') {
    let n = cleanDigits(raw);
    if (!n) return null;
    if (!n.startsWith('+')) {
      if (n.length === 10) n = defaultCountry + n;
      else if (defaultCountry && !n.startsWith(defaultCountry)) n = defaultCountry + n;
    }
    return 'tel:' + n;
  }
  function humanPhone(raw) {
    const d = cleanDigits(raw).replace(/^\+?1/, '');
    if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    return String(raw);
  }
  function callButton(rawPhone) {
    const href = toTelHref(rawPhone);
    const label = humanPhone(rawPhone);
    const a = document.createElement('a');
    a.className = 'callBtn';
    a.href = href || '#';
    a.textContent = href ? `Call ${label}` : 'No phone number';
    a.style.pointerEvents = href ? 'auto' : 'none';
    a.style.opacity = href ? '1' : '.6';
    if (href) {
      a.addEventListener('click', (e) => {
        const ok = confirm(`Place a call to ${label}?`);
        if (!ok) { e.preventDefault(); return; }
        e.preventDefault();
        window.location.href = href;
      });
    }
    return a;
  }
  function phoneLinkOrText(val) {
    const href = toTelHref(val);
    if (!href) return document.createTextNode(String(val ?? ''));
    const a = document.createElement('a');
    a.href = href;
    a.textContent = humanPhone(val);
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = href;
    });
    return a;
  }
  function emailLink(val) {
    const a = document.createElement('a');
    a.href = `mailto:${String(val||'').trim()}`;
    a.textContent = String(val||'').trim();
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    return a;
  }
  function prettifyLabel(k) {
    return String(k)
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (m)=>m.toUpperCase());
  }
  function escapeText(t){ const s=document.createElement('span'); s.textContent=String(t); return s.textContent; }
  function nodeToString(n){
    const t = document.createElement('div'); t.append(n); return t.innerHTML;
  }
  function htmlLines(lines){
    const frag = document.createElement('div');
    frag.style.display = 'flex';
    frag.style.flexDirection = 'column';
    lines.forEach(line => {
      const p = document.createElement('div');
      p.innerHTML = line;
      frag.append(p);
    });
    return frag;
  }

  /* dom utilities */
  function div(cls, ...args) {
    const n = document.createElement('div');
    if (cls) n.className = cls;
    for (const a of args) {
      if (a == null) continue;
      if (typeof a === 'object' && !(a instanceof Node) && !Array.isArray(a)) {
        Object.assign(n.style, a);
      } else {
        n.append(a instanceof Node ? a : document.createTextNode(String(a)));
      }
    }
    return n;
  }
  function h1(t){ const n=document.createElement('div'); n.className='title'; n.textContent=t; return n; }
  function h2(t,cls){ const n=document.createElement('div'); if (cls) n.className=cls; n.textContent=t; return n; }
  function ptext(t,cls){ const n=document.createElement('div'); if (cls) n.className=cls; n.textContent=t; return n; }
  function center(...kids){ const n=div('center'); kids.forEach(k=>k && n.append(k)); return n; }
  function button(text, cls, on){
    const b=document.createElement('button');
    b.className=cls;
    b.textContent=text;
    b.onclick=on;
    return b;
  }
  function actionRow(...kids){
    const r=div('actions');
    r.style.display = 'flex';
    r.style.gap = '8px';
    r.style.marginTop = '12px';
    r.style.justifyContent = 'center';
    kids.forEach(k=>k&&r.append(k));
    return r;
  }
  function disabledBtn(text){
    const b=document.createElement('button');
    b.className='callBtn';
    b.textContent=text;
    b.disabled=true;
    b.style.opacity=.6;
    return b;
  }
  function chip(label, cls, on){
    const c=document.createElement('button');
    c.className=cls;
    c.textContent=label;
    c.onclick=on;
    return c;
  }
  function chipRow(arr){ const r=div('surveyChips'); arr.forEach(x=>r.append(x)); return r; }
  function cardKV(entries){
    const card = div('detailsCard'); card.style.width='90%';
    for (const [k,v] of entries){
      const row = div('kv');
      row.append(div('k', k), div('v', String(v)));
      card.append(row);
    }
    return card;
  }

  function errorBox(err){
    const pre = document.createElement('pre');
    pre.style.whiteSpace='pre-wrap';
    pre.style.background='#1a1f2b';
    pre.style.border='1px solid #2b3b5f';
    pre.style.padding='12px';
    pre.style.borderRadius='8px';
    pre.textContent = (err && (err.stack || err.message)) || String(err);
    const box = div('', { padding:'16px', color:'#ffb3b3' });
    box.append(h2('⚠️ Execution screen error'), pre);
    return box;
  }
  function showError(err){
    root.innerHTML = '';
    root.append(errorBox(err));
  }
}

/* ---------- merge helper: reconciles local + remote ---------- */
function mergeProgress(local, remote) {
  const L = local  && typeof local  === 'object' ? local  : { campaignId: remote?.campaignId, totals:{total:0,made:0,answered:0,missed:0}, contacts:{} };
  const R = remote && typeof remote === 'object' ? remote : { campaignId: L.campaignId, totals:{total:0,made:0,answered:0,missed:0}, contacts:{} };

  const out = { campaignId: L.campaignId || R.campaignId, totals: { ...L.totals }, contacts: { ...L.contacts } };

  for (const [id, rc] of Object.entries(R.contacts || {})) {
    const lc = out.contacts[id] || {};
    const attempts = Math.max(Number(lc.attempts||0), Number(rc.attempts||0));
    const lastCalledAt = Math.max(Number(lc.lastCalledAt||0), Number(rc.lastCalledAt||0)) || 0;
    const outcome = rc.outcome ?? lc.outcome;

    const lLogs = Array.isArray(lc.surveyLogs) ? lc.surveyLogs : [];
    const rLogs = Array.isArray(rc.surveyLogs) ? rc.surveyLogs : [];
    const mergedLogs = [...lLogs, ...rLogs].sort((a,b)=>(a?.at||0)-(b?.at||0));
    const surveyAnswer = mergedLogs.length ? mergedLogs[mergedLogs.length-1].answer : (rc.surveyAnswer ?? lc.surveyAnswer);

    const lNoteAt = (lc.notesLogs && lc.notesLogs[lc.notesLogs.length-1]?.at) || 0;
    const rNoteAt = (rc.notesLogs && rc.notesLogs[rc.notesLogs.length-1]?.at) || 0;
    const useR = rNoteAt >= lNoteAt;
    const notes = useR ? (rc.notes ?? lc.notes) : (lc.notes ?? rc.notes);
    const notesLogs = [...(lc.notesLogs||[]), ...(rc.notesLogs||[])].sort((a,b)=>(a?.at||0)-(b?.at||0)).slice(-10);

    out.contacts[id] = { attempts, lastCalledAt, outcome, surveyAnswer, surveyLogs: mergedLogs, notes, notesLogs };
  }

  const seen = Object.values(out.contacts);
  out.totals.made = seen.reduce((n,c)=>n + (c.attempts>0?1:0), 0);
  out.totals.answered = seen.reduce((n,c)=>n + (c.outcome==='answered'?1:0), 0);
  out.totals.missed = seen.reduce((n,c)=>n + (c.outcome==='no_answer'?1:0), 0);
  out.totals.total = L.totals?.total ?? R.totals?.total ?? 0;

  return out;
}
