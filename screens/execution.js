// screens/execution.js
import { getAllStudents, applyFilters, getStudentId } from '../data/campaignsData.js';
import {
  loadOrInitProgress,
  recordOutcome,
  getSummary,
  recordSurveyResponse,
  getSurveyResponse,
  recordNote,            // <= NEW
  getNote                // <= NEW
} from '../data/campaignProgress.js';

export async function Execute(root, campaign) {
  if (!campaign) { location.hash = '#/dashboard'; return; }

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
  let currentNotes = '';            // <= NEW

  // Simple undo stack
  const undoStack = [];

  // ======= BOOT (with error splash) =======
  try {
    students = await getAllStudents();
    filtered = applyFilters(students, campaign.filters || []);
    queueIds = filtered.map((s, i) => getStudentId(s, i));
    filtered.forEach((s, i) => { idToStudent[getStudentId(s, i)] = s; });

    progress = await loadOrInitProgress(campaign.id, queueIds);
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
    progress = await loadOrInitProgress(campaign.id, queueIds);
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

  // ======= Keyboard shortcuts (disabled) =======
  // (Keep teardown guard below in case you add it back later.)

  // ======= Swipe (pointer) with guard so buttons still work =======
  function isNoSwipeTarget(ev){
    const t = ev.target;
    return !!(t && t.closest && t.closest('[data-noswipe="1"]'));
  }
  function attachSwipe(el){
    let startX = null, dx = 0;
    el.onpointerdown = (ev)=>{
      if (isNoSwipeTarget(ev)) return;
      startX = ev.clientX; dx = 0;
      try { el.setPointerCapture && el.setPointerCapture(ev.pointerId); } catch{}
    };
    el.onpointermove = (ev)=>{
      if (startX==null) return;
      dx = ev.clientX - startX;
      el.style.transform = `translateX(${dx}px) rotate(${dx/30}deg)`;
    };
    el.onpointerup = (ev)=> {
      if (startX==null) return;
      if (!isNoSwipeTarget(ev)) {
        if (dx > 80) onOutcome('answered');
        else if (dx < -80) onOutcome('no_answer');
      }
      el.style.transform = '';
      startX=null; dx=0;
    };
  }

  // ======= Lazy-load current contact's survey & notes =======
  async function ensureSurveyAndNotesLoaded() {
    if (!currentId) return;
    selectedSurveyAnswer = await getSurveyResponse(campaign.id, currentId);
    currentNotes = await getNote(campaign.id, currentId);
  }
  async function ensureSurveySelected() {
    if (!currentId) return;
    selectedSurveyAnswer = await getSurveyResponse(campaign.id, currentId);
  }

  function header() {
    const t = totals();
    const pctNum = Math.round(pct()*100);

    // Top bar WITHOUT a back button now (we move it to the bottom action row)
    return div('',
      div('topHeader',
        div('headerLeft'), // empty spacer
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
        // Main idle section with title, count, and Begin button
        const idleBox = center(
          h1(campaign.name || 'Campaign'),
          ptext(`${queueIds.length} contact${queueIds.length===1?'':'s'} in this campaign`, 'muted'),
          button('Begin Calls', 'btn btn-primary', beginCalls)
        );
        wrap.append(idleBox);

        // Compact summary directly under the Begin button with tight spacing
        const summaryMount = div('', { margin: '6px auto 0', maxWidth: '800px' });
        wrap.append(summaryMount);

        // Build and insert the summary (async) — hide actions on idle, compact spacing
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
        const phone = stu['mobile_phone'] ?? stu.phone ?? stu.phone_number ?? stu.mobile ?? '';

        const card = div('', { padding: '16px', paddingBottom:'36px' });
        const swipe = div('');
        attachSwipe(swipe);

        // === Centered contact header (name + hint + call button) ===
        const headerBox = div('', {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          marginTop: '4px',
          marginBottom: '12px'
        });

        const nameNode = h1(
          `${String(stu.full_name ?? '')}`.trim() || 'Current contact'
        );
        nameNode.style.textAlign = 'center';
        nameNode.style.fontWeight = '800';

        const hintNode = ptext('Swipe right = Answered, Swipe left = No answer', 'hint');
        hintNode.style.textAlign = 'center';

        const callBtnNode = phone ? callButton(phone) : disabledBtn('No phone number');
        callBtnNode.style.marginTop = '6px';

        headerBox.append(nameNode, hintNode, callBtnNode);

        // Bottom action row WITH Back button
        const backBtn = button('← Back', 'btn backBtn', onBack);
        backBtn.disabled = undoStack.length === 0;
        if (backBtn.disabled) backBtn.style.opacity = '.6';

        const actions = actionRow(
          backBtn,
          button('No Answer','btn no', ()=>onOutcome('no_answer')),
          button('Answered','btn yes', ()=>onOutcome('answered'))
        );

        swipe.append(
          headerBox,
          details(stu),
          surveyBlock(campaign.survey, selectedSurveyAnswer, onSelectSurvey),
          notesBlock(currentNotes, onChangeNotes),
          actions
        );
        card.append(swipe);
        wrap.append(card);
      }

      if (mode==='summary') {
        // Full summary with actions (unchanged)
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

  // ======= teardown on route change (optional) =======
  window.addEventListener('hashchange', () => {
    // Safe even if keyHandler was never defined/attached
    if (typeof keyHandler === 'function') {
      window.removeEventListener('keydown', keyHandler);
    }
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
    ta.setAttribute('data-noswipe','1');
    ta.addEventListener('pointerdown', e => e.stopPropagation());

    ta.addEventListener('input', () => onChange(ta.value));
    ta.addEventListener('blur', () => onChange(ta.value));

    container.append(title, ta);
    return container;
  }

  /* ---- tiny view helpers ---- */
  function details(stu){
    const card = div('detailsCard');
    const keys = Object.keys(stu || {});
    if (!keys.length) card.append(ptext('No student fields available','muted'));
    for (const k of keys) {
      const vRaw = stu[k];
      const row = div('kv');
      const keyNode = div('k', k);
      const valNode = div('v');

      const looksPhoneKey = /phone/i.test(k) || /\bmobile\b/i.test(k);
      const looksPhoneVal = typeof vRaw === 'string' && cleanDigits(vRaw).length >= 10;

      if (looksPhoneKey || looksPhoneVal) valNode.append(phoneLinkOrText(vRaw));
      else valNode.append(document.createTextNode(String(vRaw)));

      row.append(keyNode, valNode);
      card.append(row);
    }
    return card;
  }

  function surveyBlock(survey, sel, onPick){
    if (!survey || !survey.question || !Array.isArray(survey.options) || !survey.options.length) return div('');
    const options = survey.options.map(opt => {
      const c = chip(opt, 'surveyChip'+(sel===opt?' sel':''), ()=>onPick(opt));
      c.setAttribute('data-noswipe','1');
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

  /* ===== tel: helpers (click-to-call) ===== */
  function cleanDigits(s) {
    return String(s || '').replace(/[^\d+]/g, '');
  }
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
    a.setAttribute('data-noswipe','1');
    a.addEventListener('pointerdown', e => e.stopPropagation());
    if (href) {
      a.addEventListener('click', (e) => {
        const ok = confirm(`Place a call to ${label}?`);
        if (!ok) { e.preventDefault(); return; }
        e.preventDefault();
        window.location.href = href; // Safari-friendly
      });
    }
    return a;
  }
  function phoneLinkOrText(val) {
    const href = toTelHref(val);
    if (!href) return document.createTextNode(String(val));
    const a = document.createElement('a');
    a.href = href;
    a.textContent = humanPhone(val);
    a.style.color = 'inherit';
    a.style.textDecoration = 'underline';
    a.setAttribute('data-noswipe','1');
    a.addEventListener('pointerdown', e => e.stopPropagation());
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = href;
    });
    return a;
  }

  /* dom utilities (SAFE VARIADIC VERSION) */
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
  function h2(t,cls){ const n=document.createElement('div'); n.className=cls||''; n.textContent=t; return n; }
  function ptext(t,cls){ const n=document.createElement('div'); n.className=cls||''; n.textContent=t; return n; }
  function center(...kids){ const n=div('center'); kids.forEach(k=>k && n.append(k)); return n; }
  function button(text, cls, on){
    const b=document.createElement('button');
    b.className=cls;
    b.textContent=text;
    b.onclick=on;
    b.setAttribute('data-noswipe','1');
    b.addEventListener('pointerdown', e => e.stopPropagation());
    return b;
  }
  function actionRow(...kids){
    const r=div('actions');
    r.style.display = 'flex';
    r.style.gap = '8px';
    r.style.marginTop = '12px';
    kids.forEach(k=>k&&r.append(k));
    return r;
  }
  function disabledBtn(text){ const b=document.createElement('button'); b.className='callBtn'; b.textContent=text; b.disabled=true; b.style.opacity=.6; b.setAttribute('data-noswipe','1'); b.addEventListener('pointerdown', e => e.stopPropagation()); return b; }
  function chip(label, cls, on){
    const c=document.createElement('button');
    c.className=cls;
    c.textContent=label;
    c.onclick=on;
    c.setAttribute('data-noswipe','1');
    c.addEventListener('pointerdown', e => e.stopPropagation());
    return c;
  }
  function chipRow(arr){ const r=div('surveyChips'); arr.forEach(x=>r.append(x)); return r; }
  function cardKV(entries){
    const card = div('detailsCard'); card.style.width='90%';
    for (const [k,v] of entries){ const row = div('kv'); row.append(div('k', k), div('v', String(v))); card.append(row); }
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
