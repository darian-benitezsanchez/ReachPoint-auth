// screens/dashboard.js
// Dashboard with exactly two export buttons per campaign + delete control in header.

import {
  listCampaigns,
  applyFilters,
  getStudentId,
  getAllStudents,
  deleteCampaign, // <= added back for deletion
} from '../data/campaignsData.js';

import {
  exportNotCalledCSV,
  removeProgress,
  persistFullExportRows,   // <-- keep this one
} from '../data/campaignProgress.js';


import { exportCsvSmart } from '../utils/exportReport.js';

export function Dashboard(root) {
  root.innerHTML = '';
  const page = el('div');

  // Header: adds "Call Anyone" while keeping "+ New"
  const header = el('div', 'row space',
    el('h1', 'title', 'Your Campaigns'),
    div('row gap-8',
      btn('Call Anyone', 'btn btn-ghost', () => location.hash = '#/call'),
      btn('+ New', 'btn btn-ghost', () => location.hash = '#/create'),
    )
  );
  page.appendChild(header);

  const toast = makeToast();

  (async () => {
    const campaigns = await listCampaigns();
    if (!campaigns.length) {
      page.appendChild(
        div('center',
          el('h1','title','No campaigns yet'),
          el('p','muted','Create a campaign to start calling.'),
          btn('Create Campaign','btn btn-primary',()=>location.hash='#/create')
        )
      );
      root.appendChild(page);
      return;
    }

    const students = await getAllStudents();

    const list = el('div','list');
    for (const c of campaigns) {
      const card = el('section','card');

      // Small delete icon in header (NOT an action button)
      const del = button('icon danger', async (e) => {
        e?.stopPropagation?.();
        if (!confirm(`Delete campaign "${c.name}"? This also clears its progress.`)) return;
        try {
          await deleteCampaign(c.id);
          await removeProgress(c.id);
          Dashboard(root); // rerender
        } catch (err) {
          toast.show('Delete failed: ' + (err?.message || err));
        }
      }, '🗑️');
      del.title = 'Delete campaign';

      const head = button('card-head', () => location.hash = `#/execute/${c.id}`,
        div('card-head-text',
          div('card-title', c.name),
          div('card-sub', `Created ${new Date(c.createdAt).toLocaleDateString()} • ${c.studentIds.length} students`),
          div('card-reminders', remindersLabel(c)),
        ),
        // place delete icon to the right
        div('spacer'),
        del
      );

      // Build queueIds and idToStudent for exports
      const filtered = applyFilters(students, c.filters || []);
      const queueIds = filtered.map((s,i)=>getStudentId(s,i));
      const idToStudent = {};
      filtered.forEach((s,i)=>{ idToStudent[getStudentId(s,i)] = s; });

      // Actions: ONLY TWO BUTTONS
      const actions = div('actions',
        btn('Export Full CSV','btn btn-small', async () => {
          try {
            const { headers, rows } = await buildSummaryCSVRows(c, students);

            // Store a carbon-copy of the JSON rows to Supabase (export_full_rows)
            await persistFullExportRows(c.id, rows);

            const csv = csvString(headers, rows);
            await exportCsvSmart(`campaign-${c.id}-full.csv`, csv);
            toast.show('Saved full CSV');
          } catch (e) {
            toast.show('Export failed: ' + (e?.message||e));
          }
        }),
        btn('Export Not Called','btn btn-small', async () => {
          try {
            const csv = await exportNotCalledCSV(c.id, queueIds, idToStudent);
            await exportCsvSmart(`campaign-${c.id}-not-called.csv`, csv);
            toast.show('Saved Not Called CSV');
          } catch (e) {
            toast.show('Export failed: ' + (e?.message||e));
          }
        })
      );

      card.append(head, actions);
      list.appendChild(card);
    }

    page.appendChild(list);
    root.appendChild(page);
    root.appendChild(toast.node);
  })();
}

/* ---------- helpers ---------- */

function remindersLabel(c) {
  if (!c.reminders?.length) return 'Reminders: —';
  const set = new Set();
  for (const r of c.reminders) for (const d of (r.dates||[])) set.add(d);
  const list = Array.from(set).sort();
  return list.length ? `Reminders: ${list.join(', ')}` : 'Reminders: —';
}

/**
 * Build Full CSV rows with headers aligned to Supabase-normalized student columns,
 * plus call-progress fields.
 */
async function buildSummaryCSVRows(campaign, allStudents) {
  const filtered = applyFilters(allStudents, campaign.filters || []);
  const idToStudent = {};
  filtered.forEach((s,i)=>{ idToStudent[getStudentId(s,i)] = s; });

  // Pull from progress store for outcomes/responses/timestamps/notes
  const snap = await loadProgressSnapshotFromSupabase(campaign.id);
  const contacts = snap?.contacts || {};

  // CSV headers aligned to Supabase-normalized student columns
  const headers = [
    'full_name',
    'camper_email',
    'camper_high_school_middle_school',
    'high_school_graduation_year',
    'birthdate',
    'mobile_phone',
    'gpa',
    'mailing_street_address',
    'mailing_city',
    'mailing_state_province',
    'mailing_zip_postal_code',
    'camper_status',
    'parent_guardian_name',
    'parent_guardian_relation',
    'parent_guardian_number',
    'parent_guardian_email',
    'emergency_contact_name',
    'emergency_contact_type',
    'emergency_contact_number',
    'preferred_language',
    'major',
    'college',
    'jr_snr_wknd',
    // progress fields appended:
    'outcome',
    'response',
    'notes',
    'timestamp',
    'student_id',
    'campaign_id',
    'campaign_name',
  ];

  const rows = [];

  filtered.forEach((student, idx) => {
    const sid = getStudentId(student, idx);
    const st = idToStudent[sid];

    // Prefer normalized keys; fall back to common legacy variants so older data still works.
    const norm = (k, ...alts) => {
      if (st && st[k] != null && st[k] !== '') return st[k];
      for (const a of alts) if (st && st[a] != null && st[a] !== '') return st[a];
      return '';
    };

    // full_name best-effort resolution
    const fullName =
      norm('full_name',
          'fullName','Full Name*','Full Name','name') ||
      // compose from first/last if present
      `${(st?.first_name||'').trim()} ${(st?.last_name||'').trim()}`.trim();

    const cp = contacts[sid] || {};
    const outcome = cp.outcome || '';
    const response = cp.surveyAnswer || '';
    const notes = cp.notes || '';
    const tCall = cp.lastCalledAt || 0;
    let tResp = 0;
    if (Array.isArray(cp.surveyLogs)) {
      for (let i = cp.surveyLogs.length-1; i>=0; i--) {
        if (cp.surveyLogs[i]?.answer === response) { tResp = cp.surveyLogs[i].at||0; break; }
      }
    }
    const iso = (tCall || tResp) ? new Date(Math.max(tCall, tResp)).toISOString() : '';

    // Build row with normalized student fields + progress fields
    const row = {
      full_name: fullName,
      camper_email: norm('camper_email','Camper Email*','email','Email'),
      camper_high_school_middle_school: norm('camper_high_school_middle_school','Camper High School/Middle School','school'),
      high_school_graduation_year: norm('high_school_graduation_year','High School Graduation Year*','graduation_year','grad_year'),
      birthdate: norm('birthdate','Birthdate','dob'),
      mobile_phone: norm('mobile_phone','Mobile Phone*','phone','Phone'),
      gpa: norm('gpa','GPA*','GPA'),
      mailing_street_address: norm('mailing_street_address','Mailing Street Address','street','address'),
      mailing_city: norm('mailing_city','Mailing City','city'),
      mailing_state_province: norm('mailing_state_province','Mailing State/Province','state'),
      mailing_zip_postal_code: norm('mailing_zip_postal_code','Mailing Zip/Postal Code','zip'),
      camper_status: norm('camper_status','Camper Status*','status'),
      parent_guardian_name: norm('parent_guardian_name','Parent/Guardian Name'),
      parent_guardian_relation: norm('parent_guardian_relation','Parent/Guardian Relation'),
      parent_guardian_number: norm('parent_guardian_number','Parent/Guardian Number'),
      parent_guardian_email: norm('parent_guardian_email','Parent/Guardian Email ','Parent/Guardian Email'),
      emergency_contact_name: norm('emergency_contact_name','Emergency Contact Name*'),
      emergency_contact_type: norm('emergency_contact_type','Emergency Contact Type*'),
      emergency_contact_number: norm('emergency_contact_number','Emergency Contact Number*'),
      preferred_language: norm('preferred_language','Preferred Language','language'),
      major: norm('major','Major'),
      college: norm('college','College'),
      jr_snr_wknd: norm('jr_snr_wknd','JR-SNR WKND'),

      // progress fields
      outcome,
      response,
      notes,
      timestamp: iso,
      student_id: sid,
      campaign_id: campaign.id,
      campaign_name: campaign.name,
    };

    rows.push(row);
  });

  return { headers, rows };
}

function deriveFullName(stu) {
  const cands = [
    String(stu?.full_name || '').trim(),
    String(stu?.fullName || '').trim(),
    String(stu?.['Full Name*'] || '').trim(),
    `${(stu?.first_name||'').trim()} ${(stu?.last_name||'').trim()}`.trim(),
    `${(stu?.FirstName||'').trim()} ${(stu?.LastName||'').trim()}`.trim(),
    `${(stu?.['First Name']||'').trim()} ${(stu?.['Last Name']||'').trim()}`.trim(),
    String(stu?.name||'').trim(),
    String(stu?.['Full Name']||'').trim(),
  ].filter(Boolean);
  return cands[0] || '';
}

/* DOM utils */
function el(tag, className, ...children) {
  const n = document.createElement(tag);
  if (typeof className === 'string') { n.className = className; }
  else { children = [className, ...children]; }
  for (const c of children) if (c!=null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}
function div(cls,...kids){ return el('div',cls,...kids); }
function button(cls, onClick, ...kids){
  const b = el('button',cls,...kids);
  b.onclick = (e) => { e?.preventDefault?.(); onClick?.(e); };
  return b;
}
function btn(label, cls, onClick){ return button(cls, onClick, label); }

function csvString(headers, rows) {
  const esc = (v)=> {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => headers.map(h=>esc(r[h])).join(',')).join('\n');
  return head + '\n' + body;
}

function makeToast() {
  const node = div('toast'); node.style.display='none';
  let t=null;
  return {
    node,
    show(msg){ node.textContent = msg; node.style.display='block'; clearTimeout(t); t = setTimeout(()=>node.style.display='none', 2400); }
  };
}
