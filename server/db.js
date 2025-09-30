// server/db.js
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'reachpoint.db');

export const db = new Database(DB_PATH);

// create tables if not exist
const schema = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('Karla','Aracely','Darian')),
  notes TEXT DEFAULT '',
  at INTEGER NOT NULL
);

-- Optional: campaign progress (to sync execution screen too)
CREATE TABLE IF NOT EXISTS campaign_outcomes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('answered','no_answer')),
  attempts INTEGER DEFAULT 1,
  last_called_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_surveys (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_notes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  notes TEXT DEFAULT '',
  updated_at INTEGER NOT NULL
);
`;
db.exec(schema);
