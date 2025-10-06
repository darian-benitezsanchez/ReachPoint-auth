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
  // normalize to known route or fallback
  // Only compare the base path (e.g., '#/execute') so deep-links like '#/execute/123' map correctly
  const base = h.replace(/^(#[^/]+\/[^/]+).*/, '$1'); // keep '#/x' or '#/x/y' start
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

onAuthChange(() => {
  guardAndRender();
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-logout]');
  if (!el) return;
  e.preventDefault();
  try {
    await signOut();
  } finally {
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
