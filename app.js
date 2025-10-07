// app.js
// Simple hash router + Supabase Auth guard for ReachPoint

import { LoginScreen } from './screens/Login-Screen.js';
import { Dashboard } from './screens/dashboard.js';
import { CreateCampaign } from './screens/createCampaigns.js';
import { Call } from './screens/Call.js';
import { Execute as Execution } from './screens/execution.js'; // <-- alias existing export
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

  const now = () => Date.now();

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
    // local sign-out; flip to { global:true } to revoke refresh tokens across devices
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

  function onUserActivity() { setActivity(); }

  function bindActivityListeners() {
    if (bound) return;
    bound = true;
    const events = ['pointerdown','mousemove','wheel','keydown','touchstart','scroll','focus'];
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
    const events = ['pointerdown','mousemove','wheel','keydown','touchstart','scroll','focus'];
    events.forEach(ev => window.removeEventListener(ev, onUserActivity));
  }

  function start() {
    try { chan = new BroadcastChannel(CH_NAME); } catch { chan = null; }
    if (chan) {
      chan.onmessage = (msg) => {
        if (!msg || !msg.data) return;
        const { type } = msg.data;
        if (type === 'force-logout') {
          stop();
          location.hash = '#/login';
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

  // public API
  return { start, stop, touch: setActivity };
})();
/* ======================= end inactivity timeout block ======================= */


/* ----------------------------- config & routes ---------------------------- */

const ROUTES = {
  '#/login': LoginScreen,
  '#/dashboard': Dashboard,
  '#/create': CreateCampaign,
  '#/call': Call,
  '#/execution': Execution, // keep existing
  '#/execute': Execution,   // add alias so #/execute/<id> works with your screen's hash parser
  '#/insights': Insights,   // not gated per your request
};

// Screens that MUST be authenticated
const AUTH_ONLY = new Set(['#/dashboard', '#/create', '#/call', '#/execution', '#/execute', '#/insights']);

const DEFAULT_ROUTE = '#/dashboard';
const LOGIN_ROUTE = '#/login';

const root = document.getElementById('app');

/* --------------------------------- utils --------------------------------- */

function getHashRoute() {
  const h = location.hash || DEFAULT_ROUTE;
  // Only compare the base path (e.g., '#/execute') so deep-links like '#/execute/123' map correctly
  const key = Object.keys(ROUTES).find(k => h === k || h.startsWith(k + '/')) || DEFAULT_ROUTE;
  return key;
}

function setLoading(visible, msg = 'Loading…') {
  if (!visible) {
    const el = document.getElementById('rp-loading');
    if (el) el.remove();
    return;
  }
  root.innerHTML = `
    <div id="rp-loading" class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <div class="muted">${msg}</div>
    </div>
  `;
}

function setNavForAuth(isAuthed, userEmail = '') {
  const nav = document.querySelector('header .nav');
  if (!nav) return;

  nav.querySelectorAll('a[href^="#/"]').forEach((a) => {
    const href = a.getAttribute('href');
    const baseHref = href.replace(/^(#[^/]+\/[^/]+).*/, '$1');
    const shouldHide = AUTH_ONLY.has(href) || AUTH_ONLY.has(baseHref);
    a.style.display = (!isAuthed && shouldHide) ? 'none' : '';
  });

  let logoutLink = nav.querySelector('[data-logout]');
  if (isAuthed) {
    if (!logoutLink) {
      logoutLink = document.createElement('a');
      logoutLink.href = '#/login';
      logoutLink.textContent = userEmail ? `Logout (${userEmail})` : 'Logout';
      logoutLink.setAttribute('data-logout', 'true');
      nav.appendChild(logoutLink);
    } else {
      logoutLink.textContent = userEmail ? `Logout (${userEmail})` : 'Logout';
      logoutLink.style.display = '';
    }
  } else if (logoutLink) {
    logoutLink.remove();
  }
}

function setActiveNav(route) {
  const links = document.querySelectorAll('header .nav a[href^="#/"]');
  links.forEach((a) => {
    const href = a.getAttribute('href');
    const active = route === href || location.hash.startsWith(href + '/');
    if (active) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    } else {
      a.classList.remove('active');
      a.removeAttribute('aria-current');
    }
  });
}

/* ------------------------------- core router ------------------------------ */

async function guardAndRender() {
  setLoading(true, 'Checking session…');

  const route = getHashRoute();
  const session = await getSession().catch(() => null);
  const isAuthed = !!session;
  const user = isAuthed ? await getUser().catch(() => null) : null;

  // Start/stop idle watcher based on auth state
  if (isAuthed) {
    IdleTimeout.start();
  } else {
    IdleTimeout.stop();
  }

  setNavForAuth(isAuthed, user?.email || '');

  if (AUTH_ONLY.has(route) && !isAuthed) {
    try {
      const nextPath = location.hash || route;
      const key = 'reachpoint.nextPath';
      sessionStorage.setItem(key, nextPath);
    } catch {}
    location.hash = LOGIN_ROUTE;
    setLoading(false);
    return;
  }
  if (route === LOGIN_ROUTE && isAuthed) {
    let next = DEFAULT_ROUTE;
    try {
      const key = 'reachpoint.nextPath';
      const stored = sessionStorage.getItem(key);
      if (stored && (ROUTES[stored] || Object.keys(ROUTES).some(k => stored.startsWith(k + '/')))) {
        next = stored;
        sessionStorage.removeItem(key);
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
    // Pass root only; your Execution screen reads the campaign id from the hash itself.
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
    location.hash = '#/login';
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
const style = document.createElement('style');
style.textContent = `
.loading { padding: 36px; display: grid; gap: 10px; place-items: center; color: #64748B; }
.loading .spinner {
  width: 24px; height: 24px; border-radius: 999px;
  border: 3px solid #e5e7eb; border-top-color: #22c55e;
  animation: rp-spin 1s linear infinite;
}
@keyframes rp-spin { to { transform: rotate(360deg); } }
header .nav a.active { font-weight: 800; text-decoration: underline; text-underline-offset: 4px; }
`;
document.head.appendChild(style);
