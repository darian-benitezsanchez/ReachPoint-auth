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

  // ======= NO SWIPE: buttons only =======

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


  function getDbStudentId(idFromQueue) {
  // Map your queue id to the DB student id used in your tables
  const stu = idToStudent[idFromQueue] || {};
  return stu.id ?? stu.student_id ?? stu.uuid ?? idFromQueue;
  }

  async function loadAndRenderInteractions(mount, contactId) {
    mount.innerHTML = '';
    const box = document.createElement('details');
    box.open = false;

    const sum = document.createElement('summary');
    sum.textContent = 'Interaction History';
    Object.assign(sum.style, {
      cursor: 'pointer',
      fontWeight: '700',
      padding: '8px 10px',
      border: '1px solid #e5e7eb',
      borderRadius: '10px',
      background: '#f9fafb'
    });
    box.append(sum);

    const body = div('', { padding: '10px 0' });
    box.append(body);
    mount.append(box);

    const loading = ptext('Loading interactions…', 'muted');
    Object.assign(loading.style, { padding: '8px 2px' });
    body.append(loading);

    try {
      const cid = getDbStudentId(contactId);

      // ---------- call_progress (by contact_id) ----------
      const { data: cpRows, error: cpErr } = await window.supabase
        .from('call_progress')
        .select('campaign_id, attempts, outcome, last_called_at')
        .eq('contact_id', cid)
        .order('last_called_at', { ascending: false })
        .limit(100);
      if (cpErr) throw cpErr;

      // Campaign names for those campaign_ids (filter to UUIDs only)
      const rawCampaignIds = [...new Set((cpRows || []).map(r => r.campaign_id).filter(Boolean))];
      const uuidCampaignIds = rawCampaignIds.filter(isUuid);

      let campNameById = new Map();
      if (uuidCampaignIds.length) {
        const { data: campRows, error: campErr } = await window.supabase
          .from('campaigns')
          .select('id,name')
          .in('id', uuidCampaignIds);
        if (campErr) throw campErr;
        campNameById = new Map((campRows || []).map(r => [r.id, r.name]));
      }
      // Non-UUID ids won’t be found; we’ll fall back to showing the id itself.


      // Survey answers (by contact_id + campaign_id)
      const { data: srRows, error: srErr } = campaignIds.length
        ? await window.supabase.from('survey_responses')
            .select('campaign_id, contact_id, answer')
            .eq('contact_id', cid)
            .in('campaign_id', campaignIds)
        : { data: [], error: null };
      if (srErr) throw srErr;
      const answerByCamp = new Map((srRows || []).map(r => [r.campaign_id, r.answer]));

      // ---------- single_calls (by student_id) ----------
      const { data: scRows, error: scErr } = await window.supabase
        .from('single_calls')
        .select('caller, occurred_at, notes')
        .eq('student_id', cid) // ⬅️ IMPORTANT: student_id (not contact_id)
        .order('occurred_at', { ascending: false })
        .limit(100);
      if (scErr) throw scErr;

      // ---------- Render: call_progress ----------
      body.innerHTML = '';
      body.append(h2('Campaign call activity', 'summaryTitle'));
      const cpTable = document.createElement('table');
      cpTable.style.width = '100%';
      cpTable.style.borderCollapse = 'collapse';
      cpTable.style.marginBottom = '10px';
      cpTable.style.background = '#fff';
      cpTable.style.border = '1px solid #e5e7eb';
      cpTable.style.borderRadius = '10px';
      cpTable.style.overflow = 'hidden';
      cpTable.createTHead().innerHTML = `
        <tr style="background:#f3f4f6;text-align:left">
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Campaign</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Attempts</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Outcome</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Answer</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Last Called</th>
        </tr>
      `;
      const cpBody = cpTable.createTBody();

      (cpRows || []).forEach(r => {
        const tr = cpBody.insertRow();
        const td = (text) => {
          const cell = tr.insertCell();
          cell.style.padding = '8px 10px';
          cell.textContent = text ?? '—';
          return cell;
        };
        td(campNameById.get(r.campaign_id) || r.campaign_id);
        td(String(r.attempts ?? '—'));
        td(r.outcome || '—');
        td(answerByCamp.get(r.campaign_id) || '—');
        td(r.last_called_at ? new Date(r.last_called_at).toLocaleString() : '—');
      });

      if (!cpRows || cpRows.length === 0) {
        body.append(ptext('No campaign call activity found for this contact.', 'muted'));
      } else {
        body.append(cpTable);
      }

      // ---------- Render: single_calls ----------
      body.append(h2('Direct calls', 'summaryTitle'));
      const scTable = document.createElement('table');
      scTable.style.width = '100%';
      scTable.style.borderCollapse = 'collapse';
      scTable.style.background = '#fff';
      scTable.style.border = '1px solid #e5e7eb';
      scTable.style.borderRadius = '10px';
      scTable.style.overflow = 'hidden';
      scTable.createTHead().innerHTML = `
        <tr style="background:#f3f4f6;text-align:left">
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Caller</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Occurred At</th>
          <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Notes</th>
        </tr>
      `;
      const scBody = scTable.createTBody();

      (scRows || []).forEach(r => {
        const tr = scBody.insertRow();
        const td = (nodeOrText) => {
          const cell = tr.insertCell();
          cell.style.padding = '8px 10px';
          if (nodeOrText instanceof Node) cell.append(nodeOrText);
          else cell.textContent = nodeOrText ?? '—';
          return cell;
        };
        td(r.caller || '—');
        td(r.occurred_at ? new Date(r.occurred_at).toLocaleString() : '—');

        const notes = String(r.notes || '').trim();
        if (!notes) { td('—'); }
        else if (notes.length <= 140) { td(notes); }
        else {
          const d = document.createElement('details');
          const s = document.createElement('summary');
          s.textContent = notes.slice(0, 140) + '…';
          d.append(s, document.createTextNode(notes));
          td(d);
        }
      });

      if (!scRows || scRows.length === 0) {
        body.append(ptext('No direct call records found for this contact.', 'muted'));
      } else {
        body.append(scTable);
      }
    } catch (err) {
      body.innerHTML = '';
      const errBox = div('', { color: '#b91c1c', padding: '6px 2px' },
        `Could not load interaction history.`
      );
      body.append(errBox);
      console.warn('[interactions] load error', err);
    }
  }



  // ─── render is async so survey/notes are present BEFORE drawing ───
  async function render() {
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
        // ⬇️ wait for survey+notes before building UI
        await ensureSurveyAndNotesLoaded();

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
        const interactionsMount = div('', { margin: '8px 0 10px' }); // ⬅️ NEW

        card.append(
          headerBox,
          prettyDetails(stu),
          interactionsMount, // ⬅️ NEW: interactions dropdown goes here
          surveyBlock(campaign.survey, selectedSurveyAnswer, onSelectSurvey),
          notesBlock(currentNotes, onChangeNotes),
          actions
        );

        function isUuid(v) {
          return typeof v === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
        }

        
        // Load interactions async (don’t block UI)
        loadAndRenderInteractions(interactionsMount, currentId).catch(()=>{ /* no-op */ }); // ⬅️ NEW


        wrap.append(card);
      }

      if (mode==='summary') {
        summaryBlock(
          campaign.id,
          async ()=>{ await beginMissed(); },
          ()=>{ location.hash='#/dashboard'; }
        )
          .then(b => {
            wrap.append(b);
            // ⬇️ New: Follow Up panel (uses local 'progress' + 'idToStudent' only)
            const panel = buildFollowUpPanel(progress, idToStudent, campaign);
            wrap.append(panel);
          })
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
    if (phoneVal)  summaryRows.push(['Phone', phoneLinkOrText(phoneVal.val)]);
    if (emailVal)  summaryRows.push(['Email', emailLink(emailVal.val)]);

    if (parentName || parentPhone || parentEmail) {
      const lines = [];
      if (parentName)  lines.push(escapeText(parentName.val));
      if (parentPhone) lines.push(nodeToString(phoneLinkOrText(parentPhone.val)));
      if (parentEmail) lines.push(nodeToString(emailLink(parentEmail.val)));
      summaryRows.push(['Parent/Guardian', htmlLines(lines)]);
    }

    const addressParts = [addr?.val, city?.val, [state?.val, zip?.val].filter(Boolean).join(' ')].filter(Boolean);
    if (addressParts.length) summaryRows.push(['Address', addressParts.join(', ')]);

    const card = div('detailsCard');
    card.style.width = '100%';

    for (const [k,vNodeOrText] of summaryRows) {
      const row = div('kv');
      row.append(div('k', k));
      const vCell = div('v');
      if (vNodeOrText instanceof Node) vCell.append(vNodeOrText);
      else if (typeof vNodeOrText === 'string') vCell.textContent = vNodeOrText;
      else vCell.append(vNodeOrText);
      row.append(vCell);
      card.append(row);
    }

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

    const topBtnWrap = div('', { display:'flex', justifyContent:'center', margin:'8px 0 12px' });
    const phoneRaw = phoneVal?.val || '';
    const callBtnNode = phoneRaw ? callButton(phoneRaw) : disabledBtn('No phone number');
    topBtnWrap.append(callBtnNode);

    const outer = div('', { maxWidth:'900px', margin:'0 auto' });
    outer.append(topBtnWrap, card);
    return outer;
  }

  /* ---- Survey ---- */
  function surveyBlock(survey, sel, onPick){
    if (!survey || !survey.question || !Array.isArray(survey.options) || !survey.options.length) return div('');
    const options = survey.options.map(opt => {
      const isSel = sel === opt;
      const c = chip(opt, 'surveyChip' + (isSel ? ' sel' : ''), ()=>onPick(opt));
      c.setAttribute('aria-pressed', String(isSel));
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

  /* ======================= Follow Up panel (no new Supabase calls) ======================= */
function buildFollowUpPanel(progressSnapshot, idToStudent, campaign) {
  const container = div('', { maxWidth: '950px', margin: '16px auto 32px', width: '100%' });

  const title = h2('Follow Up', 'summaryTitle');
  title.style.fontWeight = '800';
  title.style.textAlign = 'center';
  title.style.margin = '20px 0 10px';

  // Controls
  const controls = div('', {
    display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '10px'
  });

  const outcomeSel = document.createElement('select');
  outcomeSel.innerHTML = `
    <option value="">Any outcome</option>
    <option value="answered">Answered</option>
    <option value="no_answer">No answer</option>
  `;
  outcomeSel.style.padding = '8px 10px';
  outcomeSel.style.border = '1px solid #d1d5db';
  outcomeSel.style.borderRadius = '8px';

  const surveyInp = document.createElement('input');
  surveyInp.type = 'text';
  surveyInp.placeholder = 'Survey answer contains… (optional)';
  Object.assign(surveyInp.style, {
    padding: '8px 10px',
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    minWidth: '240px'
  });

  const resultInfo = ptext('', 'muted');

  const createBtn = button('Create Follow-Up Campaign', 'btn btn-primary', async () => {
    const rows = computeMatches();
    if (!rows.length) {
      alert('No matching contacts for follow-up.');
      return;
    }

    const originalName = campaign?.name || '(Unnamed Campaign)';
    const newName = `[Follow Up] ${originalName}`;
    const student_ids = rows.map(r => String(r.id));

    try {
      // Build a lean payload that won't reference non-existent columns.
      const payload = {
        name: newName,
        student_ids,                      // jsonb/array column (must exist)
        // If your table *does* have a `filters` jsonb column, keep the next line;
        // if it doesn't, comment it out:
        filters: [
          { field: 'outcome', op: '=', value: outcomeSel.value || 'any' },
          { field: 'surveyAnswer', op: 'contains', value: surveyInp.value || '' }
        ],
        // created_at: new Date().toISOString(), // only if you don't have a DEFAULT on created_at
      };

      const { data, error } = await window.supabase
        .from('campaigns')
        .insert(payload)
        .select()
        .single();

      if (error) throw error;

      alert(`✅ Created new follow-up campaign:\n${data.name}`);
      // Navigate to it
      location.hash = `#/execute/${data.id}`;
    } catch (err) {
      console.error('[FollowUp] failed to create campaign', err);
      alert('❌ Could not create follow-up campaign. Check console for details.');
    }
  });



  controls.append(outcomeSel, surveyInp, createBtn);

  // Results table
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.background = '#fff';
  table.style.border = '1px solid #e5e7eb';
  table.style.borderRadius = '12px';
  table.style.overflow = 'hidden';
  table.createTHead().innerHTML = `
    <tr style="background:#f9fafb;text-align:left;">
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Name</th>
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Phone</th>
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Outcome</th>
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Answer</th>
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Last Called</th>
      <th style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">Call</th>
    </tr>
  `;
  const tbody = table.createTBody();

  function computeMatches() {
    const contacts = (progressSnapshot && progressSnapshot.contacts) || {};
    const wantOutcome = outcomeSel.value;
    const q = surveyInp.value.trim().toLowerCase();

    const rows = [];
    for (const [id, c] of Object.entries(contacts)) {
      if (wantOutcome && c.outcome !== wantOutcome) continue;
      if (q && !String(c.surveyAnswer || '').toLowerCase().includes(q)) continue;

      const stu = idToStudent[id] || {};
      rows.push({
        id,
        name: String(stu.full_name || stu.name || '').trim() || '(Unnamed)',
        phone: guessPhoneFromStudent(stu),
        outcome: c.outcome || '',
        answer: c.surveyAnswer || '',
        lastCalledAt: c.lastCalledAt || 0
      });
    }
    return rows.sort((a,b)=>(b.lastCalledAt||0) - (a.lastCalledAt||0));
  }

  function renderRows() {
    const rows = computeMatches();
    resultInfo.textContent = `${rows.length} contact${rows.length===1?'':'s'} match the filter`;
    tbody.innerHTML = '';
    rows.slice(0, 200).forEach(r => {
      const tr = tbody.insertRow();

      const tdName = tr.insertCell();
      tdName.style.padding = '10px 12px';
      tdName.textContent = r.name;

      const tdPhone = tr.insertCell();
      tdPhone.style.padding = '10px 12px';
      const tel = toTelHref(r.phone);
      tdPhone.textContent = r.phone ? humanPhone(r.phone) : '—';

      const tdOutcome = tr.insertCell();
      tdOutcome.style.padding = '10px 12px';
      tdOutcome.textContent = r.outcome || '—';

      const tdAns = tr.insertCell();
      tdAns.style.padding = '10px 12px';
      tdAns.textContent = r.answer || '—';

      const tdTime = tr.insertCell();
      tdTime.style.padding = '10px 12px';
      tdTime.textContent = r.lastCalledAt ? new Date(r.lastCalledAt).toLocaleString() : '—';

      const tdCall = tr.insertCell();
      tdCall.style.padding = '10px 12px';
      if (tel) {
        const a = document.createElement('a');
        a.href = tel;
        a.textContent = 'Call';
        a.className = 'btn';
        a.addEventListener('click', (e)=>{ e.preventDefault(); window.location.href = tel; });
        tdCall.append(a);
      } else {
        tdCall.textContent = '—';
      }
    });
  }

  outcomeSel.addEventListener('change', renderRows);
  surveyInp.addEventListener('input', renderRows);

  renderRows();

  const top = div('', { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px' });
  const left = div('', { fontWeight:'700' }, 'Filter follow-ups by outcome and/or survey answer');
  top.append(left, resultInfo);

  container.append(title, top, controls, table);
  return container;
}

/* Heuristic: try to find a phone field on the student object */
function guessPhoneFromStudent(stu) {
  const keys = Object.keys(stu||{});
  const pri = ['mobile_phone','phone','phone_number','Mobile Phone*','Cell Phone','Student Phone'];
  for (const k of pri) if (stu[k]) return stu[k];
  for (const k of keys) if (/phone|mobile|cell/i.test(k) && stu[k]) return stu[k];
  return '';
}

/* Build a tiny CSV from rows returned by computeMatches() */
function followUpCsv(rows) {
  const headers = ['name','phone','outcome','answer','last_called_at','student_id'];
  const esc = (v)=> {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => [
    esc(r.name),
    esc(r.phone),
    esc(r.outcome||''),
    esc(r.answer||''),
    esc(r.lastCalledAt ? new Date(r.lastCalledAt).toISOString() : ''),
    esc(r.id)
  ].join(',')).join('\n');
  return head + '\n' + body;
}
/* ===================== end Follow Up panel helpers ===================== */

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

