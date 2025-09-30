// server/server.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { db } from './db.js';
import { nanoid } from 'nanoid';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------------- SINGLE CALLS (Call.js) ---------------- */
// List calls (newest first)
app.get('/api/calls', (req, res) => {
  const rows = db.prepare(`SELECT * FROM calls ORDER BY at DESC`).all();
  res.json(rows);
});

// Create a call log
app.post('/api/calls', (req, res) => {
  const { studentId, full_name, caller, notes, at } = req.body || {};
  if (!studentId || !full_name || !caller) {
    return res.status(400).json({ error: 'studentId, full_name, caller are required' });
  }
  const id = nanoid();
  const ts = Number(at || Date.now());
  db.prepare(`INSERT INTO calls (id, student_id, full_name, caller, notes, at)
              VALUES (@id, @studentId, @full_name, @caller, @notes, @at)`)
    .run({ id, studentId: String(studentId), full_name: String(full_name), caller: String(caller), notes: String(notes || ''), at: ts });
  res.status(201).json({ id, studentId, full_name, caller, notes: notes || '', at: ts });
});

/* ---------------- OPTIONAL: CAMPAIGN SYNC ---------------- */
// Upsert outcome
app.post('/api/campaigns/:campaignId/outcome', (req, res) => {
  const { campaignId } = req.params;
  const { contactId, outcome, attempts = 1, lastCalledAt } = req.body || {};
  if (!contactId || !outcome) return res.status(400).json({ error: 'contactId and outcome required' });
  const id = `${campaignId}:${contactId}`;
  const ts = Number(lastCalledAt || Date.now());

  const exists = db.prepare(`SELECT id FROM campaign_outcomes WHERE id=?`).get(id);
  if (exists) {
    db.prepare(`UPDATE campaign_outcomes
                SET outcome=@outcome, attempts=@attempts, last_called_at=@ts
                WHERE id=@id`)
      .run({ id, outcome, attempts, ts });
  } else {
    db.prepare(`INSERT INTO campaign_outcomes (id, campaign_id, contact_id, outcome, attempts, last_called_at)
                VALUES (@id, @campaignId, @contactId, @outcome, @attempts, @ts)`)
      .run({ id, campaignId, contactId, outcome, attempts, ts });
  }
  res.json({ ok: true });
});

// Record survey response
app.post('/api/campaigns/:campaignId/survey', (req, res) => {
  const { campaignId } = req.params;
  const { contactId, answer, at } = req.body || {};
  if (!contactId || typeof answer === 'undefined') return res.status(400).json({ error: 'contactId and answer required' });
  const id = nanoid();
  const ts = Number(at || Date.now());
  db.prepare(`INSERT INTO campaign_surveys (id, campaign_id, contact_id, answer, at)
              VALUES (@id, @campaignId, @contactId, @answer, @ts)`)
    .run({ id, campaignId, contactId, answer: String(answer), ts });
  res.status(201).json({ id, campaignId, contactId, answer, at: ts });
});

// Upsert notes
app.post('/api/campaigns/:campaignId/notes', (req, res) => {
  const { campaignId } = req.params;
  const { contactId, notes } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const id = `${campaignId}:${contactId}`;
  const ts = Date.now();
  const exists = db.prepare(`SELECT id FROM campaign_notes WHERE id=?`).get(id);
  if (exists) {
    db.prepare(`UPDATE campaign_notes SET notes=@notes, updated_at=@ts WHERE id=@id`)
      .run({ id, notes: String(notes || ''), ts });
  } else {
    db.prepare(`INSERT INTO campaign_notes (id, campaign_id, contact_id, notes, updated_at)
                VALUES (@id, @campaignId, @contactId, @notes, @ts)`)
      .run({ id, campaignId, contactId, notes: String(notes || ''), ts });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
