// data/singleCallProgress.js

const K = {
  SINGLE_CALL_KEY: 'reachpoint.singleCall.progress' // backing store (JSON array)
};

/**
 * Shape of a single call record:
 * {
 *   id: string,             // unique id for the log entry
 *   studentId: string,
 *   full_name: string,      // denormalized for convenience
 *   caller: 'Karla' | 'Aracely' | 'Darian',
 *   notes: string,
 *   at: number              // ms epoch
 * }
 */

function loadAllRaw() {
  try {
    const raw = localStorage.getItem(K.SINGLE_CALL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAllRaw(arr) {
  localStorage.setItem(K.SINGLE_CALL_KEY, JSON.stringify(arr || []));
}

/** Returns the full array of call logs (newest first). */
export async function listSingleCalls() {
  const arr = loadAllRaw();
  // newest first
  arr.sort((a,b) => (b.at||0) - (a.at||0));
  return arr;
}

/**
 * Add or update a single call record.
 * If `id` is provided and matches an existing record, it is updated; otherwise a new record is appended.
 */
export async function recordSingleCall({ id, studentId, full_name, caller, notes, at = Date.now() }) {
  const arr = loadAllRaw();
  if (id) {
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], studentId, full_name, caller, notes, at };
      saveAllRaw(arr);
      return arr[idx];
    }
  }
  const newRec = {
    id: cryptoRandomId(),
    studentId: String(studentId || ''),
    full_name: String(full_name || ''),
    caller: String(caller || ''),
    notes: String(notes || ''),
    at
  };
  arr.push(newRec);
  saveAllRaw(arr);
  return newRec;
}

/** Remove all single-call logs (optional maintenance). */
export async function clearSingleCalls() {
  saveAllRaw([]);
}

/** Export current logs as a JSON string, intended filename: singleCall_progress.json */
export async function exportSingleCallsJSON() {
  const data = await listSingleCalls();
  return JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), data }, null, 2);
}

/** Utility: generate a simple random id */
function cryptoRandomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
