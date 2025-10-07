// app.js (excerpt)
import { LoginScreen } from './screens/Login-Screen.js';
import { Dashboard } from './screens/dashboard.js';
import { CreateCampaign } from './screens/createCampaigns.js';
import { Call } from './screens/Call.js';
import { Execute as Execution } from './screens/execution.js';
import { Insights } from './screens/insights.js';

import {
  getSession,
  onAuthChange,
  signOut,
  getUser,
} from './auth-client.js';

/* ========================= 10-minute inactivity timeout =========================
   - Tracks last activity across tabs (localStorage + BroadcastChannel)
   - Resets on user events
   - Signs out + routes to #/login when idle expires
=============================================================================== */
const IdleTimeout = (() => {
  const KEY = 'reachpoint.lastActivityAt';
  const CH_NAME = 'reachpoint-auth';
  const TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes
  const CHECK_EVERY = 15 * 1000;      // poll cadence
  const THROTTLE_SET = 2000;          // avoid spamming storage on move/scroll

  let timer = null;
  let chan  = null;
  let bound = false;
  let lastSet = 0;

  function now() { return Date.now(); }

  function setActivity(ts = now()) {
    const n = now();
    if (n - lastSet < THROTTLE_SET) return;
    lastSet = n;
    try { localStorage.setItem(KEY, String(ts)); } catch {}
    if (chan) { chan.postMessage({ type: 'activity', ts }); }
  }

  function getLastActivity() {
    const v = localStorage.getItem(KEY);
    const t = v ? parseInt(v, 10) : 0;
    return Number.isFinite(t) ? t : 0;
  }

  function signOutIdle() {
    // sign out locally; choose global=true if you want to kill sessions on other devices too
    signOut({ global: false }).finally(() => {
      location.hash = '#/login';
      alert('You were signed out due to 10 minutes of inactivity.');
    });
    if (chan) { chan.postMessage({ type: 'force-logout' }); }
  }

  function check() {
    const last = getLastActivity();
    if (!last) return; // not initialized yet
    if (now() - last >= TIMEOUT_MS) {
      stop();
      signOutIdle();
    }
  }

  function onUserActivity() {
    setActivity();
  }

  function bindActivityListeners() {
    if (bound) return;
    bound = true;
    const events = [
      'pointerdown','mousemove','wheel','keydown','touchstart','scroll','focus'
    ];
    events.forEach(ev => window.addEventListener(ev, onUserActivity, { passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setActivity();
    });
    window.addEventListener('storage', (e) => {
      if (e.key === KEY) lastSet = 0; // allow immediate writes after external changes
    });
  }

  function unbindActivityListeners() {
    if (!bound) return;
    bound = false;
    const events = [
      'pointerdown','mousemove','wheel','keydown','touchstart','scroll','focus'
    ];
    events.forEach(ev => window.removeEventListener(ev, onUserActivity));
  }

  function start() {
    try { chan = new BroadcastChannel(CH_NAME); } catch { chan = null; }
    if (chan) {
      chan.onmessage = (msg) => {
        if (!msg || !msg.data) return;
        const { type } = msg.data;
        if (type === 'activity') {
          // another tab pinged; our poller will see localStorage too
          return;
        }
        if (type === 'force-logout') {
          stop();
          location.hash = '#/login';
          // optional: avoid double alerts if another tab already showed it
        }
      };
    }
    bindActivityListeners();
    setActivity();                 // initialize immediately
    timer = setInterval(check, CHECK_EVERY);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (chan) { try { chan.close(); } catch {} chan = null; }
    unbindActivityListeners();
  }

  return { start, stop, touch: setActivity };
})();
/* ======================= end inactivity timeout block ======================= */


/* ----------------------------- config & routes ---------------------------- */
const ROUTES = {
  '#/login': LoginScreen,
  '#/dashboard': Dashboard,
  '#/create': CreateCampaign,
  '#/call': Call,
  '#/execution': Execution,
  '#/execute': Execution,
  '#/insights': Insights,
};

// Screens that MUST be authenticated
const AUTH_ONLY = new Set(['#/dashboard', '#/create', '#/call', '#/execution', '#/execute', '#/insights']);

const DEFAULT_ROUTE = '#/dashboard';
const LOGIN_ROUTE = '#/login';

const root = document.getElementById('app');

/* --------------------------------- utils --------------------------------- */
// ... (your existing getHashRoute, setLoading, setNavForAuth, setActiveNav) ...

/* ------------------------------- core router ------------------------------ */
async function guardAndRender() {
  setLoading(true, 'Checking session…');

  const route = getHashRoute();
  const session = await getSession().catch(() => null);
  const isAuthed = !!session;
  const user = isAuthed ? await getUser().catch(() => null) : null;

  // START/STOP idle watcher based on auth
  if (isAuthed) {
    IdleTimeout.start();
  } else {
    IdleTimeout.stop();
  }

  setNavForAuth(isAuthed, user?.email || '');

  if (AUTH_ONLY.has(route) && !isAuthed) {
    try {
      const nextPath = location.hash || route;
      sessionStorage.setItem('reachpoint.nextPath', nextPath);
    } catch {}
    location.hash = LOGIN_ROUTE;
    setLoading(false);
    return;
  }
  if (route === LOGIN_ROUTE && isAuthed) {
    let next = DEFAULT_ROUTE;
    try {
      const stored = sessionStorage.getItem('reachpoint.nextPath');
      if (stored && (ROUTES[stored] || Object.keys(ROUTES).some(k => stored.startsWith(k + '/')))) {
        next = stored;
        sessionStorage.removeItem('reachpoint.nextPath');
      }
    } catch {}
    location.hash = next;
    setLoading(false);
    return;
  }

  const renderFn = ROUTES[route] || ROUTES[DEFAULT_ROUTE];
  try {
    setLoading(false);
    setActiveNav(route);
    renderFn(root);
  } catch (err) {
    console.error('[ReachPoint] Render error:', err);
    root.innerHTML = `
      <div class="error">
        <h2>Something went wrong</h2>
        <pre>${(err && err.message) || String(err)}</pre>
      </div>
    `;
  }
}

/* -------------------------- global event handlers ------------------------- */
window.addEventListener('hashchange', guardAndRender);

onAuthChange((session) => {
  // keep idle watcher aligned with live auth state
  if (session) IdleTimeout.start();
  else IdleTimeout.stop();
  guardAndRender();
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-logout]');
  if (!el) return;
  e.preventDefault();
  try {
    await signOut();
  } finally {
    IdleTimeout.stop();
    location.hash = LOGIN_ROUTE;
  }
});

/* ---------------------------------- boot ---------------------------------- */
(async function boot() {
  if (!location.hash || !location.hash.startsWith('#/')) {
    location.hash = DEFAULT_ROUTE;
  }
  await guardAndRender();
})();

/* --------------------------------- styles --------------------------------- */
// (keep your existing style injection)
