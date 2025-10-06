// app.js
// Simple hash router + Supabase Auth guard for ReachPoint

import { LoginScreen } from './screens/Login-Screen.js';
import { Dashboard } from './screens/dashboard.js';
import { CreateCampaign } from './screens/createCampaigns.js';
import { Call } from './screens/Call.js';
import Execution from './screens/execution.js';
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
  '#/execution': Execution,
  '#/insights': Insights, // not gated per your request
};

// Screens that MUST be authenticated
const AUTH_ONLY = new Set(['#/dashboard', '#/create', '#/call', '#/execution']);

const DEFAULT_ROUTE = '#/dashboard';
const LOGIN_ROUTE = '#/login';

const root = document.getElementById('app');

/* --------------------------------- utils --------------------------------- */

function getHashRoute() {
  const h = location.hash || DEFAULT_ROUTE;
  // normalize to known route or fallback
  return ROUTES[h] ? h : DEFAULT_ROUTE;
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
  // Toggle nav links based on auth (if they exist in the DOM)
  const nav = document.querySelector('header .nav');
  if (!nav) return;

  // Gate the links in AUTH_ONLY
  nav.querySelectorAll('a[href^="#/"]').forEach((a) => {
    const href = a.getAttribute('href');
    const shouldHide = AUTH_ONLY.has(href) && !isAuthed;
    a.style.display = shouldHide ? 'none' : '';
  });

  // Add/remove a Logout link (data-logout) dynamically if you want
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
    if (a.getAttribute('href') === route) {
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

  // Get current route & session
  const route = getHashRoute();
  const session = await getSession().catch(() => null);
  const isAuthed = !!session;
  const user = isAuthed ? await getUser().catch(() => null) : null;

  // Reflect auth in nav
  setNavForAuth(isAuthed, user?.email || '');

  // Route-level guard
  if (AUTH_ONLY.has(route) && !isAuthed) {
    // stash the intended route (optional)
    try {
      const nextPath = route;
      const key = 'reachpoint.nextPath';
      sessionStorage.setItem(key, nextPath);
    } catch {}
    location.hash = LOGIN_ROUTE;
    setLoading(false);
    return;
  }
  if (route === LOGIN_ROUTE && isAuthed) {
    // If we came from a gated route earlier, send them back there
    let next = DEFAULT_ROUTE;
    try {
      const key = 'reachpoint.nextPath';
      const stored = sessionStorage.getItem(key);
      if (stored && ROUTES[stored]) {
        next = stored;
        sessionStorage.removeItem(key);
      }
    } catch {}
    location.hash = next;
    setLoading(false);
    return;
  }

  // Render the route
  const renderFn = ROUTES[route] || ROUTES[DEFAULT_ROUTE];
  try {
    // Clear loading then render
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

// Hash routing
window.addEventListener('hashchange', guardAndRender);

// Auth state changes (login/logout/token refresh)
onAuthChange(() => {
  // Always re-evaluate guards & UI when auth changes
  guardAndRender();
});

// Logout click (delegated)
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
  // Ensure there is a default route
  if (!location.hash || !location.hash.startsWith('#/')) {
    location.hash = DEFAULT_ROUTE;
  }
  await guardAndRender();
})();

/* --------------------------------- styles --------------------------------- */
/* Optional tiny styles for loading; keep if you want */
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
