// screens/execution.js
import { getAllStudents, applyFilters, getStudentId } from '../data/campaignsData.js';
import { loadOrInitProgress, recordOutcome, getSummary, recordSurveyResponse, getSurveyResponse } from '../data/campaignProgress.js';

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
    if (!currentId) mode = 'summary';
    render();
  }

  async function beginCalls(){ passStrategy='unattempted'; mode='running'; await advance('unattempted'); }
  async function beginMissed(){ passStrategy='missed'; mode='missed'; await advance('missed'); }

  async function onSelectSurvey(ans){
    if (!currentId) return;
    selectedSurveyAnswer = ans;
    await recordSurveyResponse(campaign.id, currentId, ans);
    render();
  }
  async function onOutcome(kind){
    if (!currentId) return;
    progress = await recordOutcome(campaign.id, currentId, kind);
    const skip = passStrategy==='missed' ? currentId : undefined;
    await advance(passStrategy, skip);
  }

  // ======= Keyboard shortcuts (cleanup on re-entry) =======
  const keyHandler = (e)=>{
    if (mode!=='running' && mode!=='missed') return;
    const k = (e.key || '').toLowerCase();
    if (k==='arrowleft' || k==='n') onOutcome('no_answer');
    if (k==='arrowright' || k==='a') onOutcome('answered');
  };
  window.addEventListener('keydown', keyHandler);

  // ======= Swipe (pointer) with guard so buttons still work =======
  function isNoSwipeTarget(ev){
    const t = ev.target;
    return !!(t && t.closest && t.closest('[data-noswipe="1"]'));
  }
  function attachSwipe(el){
    let startX = null, dx = 0;
    el.onpointerdown = (ev)=>{
      if (isNoSwipeTarget(ev)) return; // don't initiate swipe from interactive controls
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

  async function ensureSurveySelected() {
    if (!currentId) return;
    selectedSurveyAnswer = await getSurveyResponse(campaign.id, currentId);
  }

  function header() {
    const t = totals();
    const pctNum = Math.round(pct()*100);
    return div('',
      div('progressWrap',
        div('progressBar', div('progressFill'), { width: pctNum + '%' }),
        ptext(`${t.made}/${t.total} complete • ${t.answered} answered • ${t.missed} missed`,'progressText')
      )
    );
  }

  function render() {
    try {
      wrap.innerHTML = '';
      wrap.append(header());

      if (mode==='idle') {
        wrap.append(
          center(
            h1(campaign.name || 'Campaign'),
            ptext(`${queueIds.length} contact${queueIds.length===1?'':'s'} in this campaign`, 'muted'),
            button('Begin Calls','btn btn-primary', beginCalls)
          )
        );
      }

      if ((mode==='running' || mode==='missed') && currentId){
        ensureSurveySelected();
        const stu = idToStudent[currentId] || {};
        const phone = stu['Mobile Phone*'] ?? stu.phone ?? stu.phone_number ?? stu.mobile ?? '';

        const card = div('', { padding: '16px', paddingBottom:'36px' });
        const swipe = div('');
        attachSwipe(swipe);

        swipe.append(
          h1(`${String(stu.first_name ?? '')} ${String(stu.last_name ?? '')}`.trim() || 'Current contact'),
          ptext('Swipe right = Answered, Swipe left = No answer','hint'),
          phone ? callButton(phone) : disabledBtn('No phone number'),
          details(stu),
          surveyBlock(campaign.survey, selectedSurveyAnswer, onSelectSurvey),
          actionRow(
            // mark these controls as no-swipe and stop pointerdown propagation
            button('No Answer','btn no', ()=>onOutcome('no_answer')),
            button('Answered','btn yes', ()=>onOutcome('answered'))
          )
        );
        card.append(swipe);
        wrap.append(card);
      }

      if (mode==='summary') {
        summaryBlock(campaign.id, async ()=>{ await beginMissed(); }, ()=>{ location.hash='#/dashboard'; })
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
    window.removeEventListener('keydown', keyHandler);
  });

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

      // Heuristic: make phone-like fields clickable
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

  async function summaryBlock(campaignId, onMissed, onFinish){
    const t = await getSummary(campaignId);
    const allDone = t.missed===0 && t.made===t.total && t.total>0;
    const box = center(
      h1('Campaign Summary'),
      cardKV([['Total contacts',t.total],['Calls made',t.made],['Answered',t.answered],['Missed',t.missed]]),
      (!allDone && t.missed>0) ? button('Proceed to Missed Contacts','btn', onMissed) : null,
      button(allDone ? 'Done' : 'Finish for now','btn btn-primary', onFinish)
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
    const d = cleanDigits(raw).replace(/^\+?1/, ''); // trim +1 for display
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
        const ok = confirm(`Place a call to ${label} with your device?`);
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
        // treat plain objects as style objects
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
  function actionRow(...kids){ const r=div('actions'); kids.forEach(k=>k&&r.append(k)); return r; }
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
