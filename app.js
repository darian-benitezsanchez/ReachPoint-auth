// app.js
import { Dashboard } from './screens/dashboard.js';
import { CreateCampaign } from './screens/createCampaigns.js';
import { Execute } from './screens/execution.js';
import { Call } from './screens/Call.js';
import { getCampaignById } from './data/campaignsData.js';

const app = document.getElementById('app');

// Simple error splash so failures aren't silent
function showError(err) {
  console.error(err);
  app.innerHTML = `
    <div style="padding:16px;color:#ffb3b3">
      <h2 style="margin:0 0 8px">⚠️ Screen crashed</h2>
      <pre style="white-space:pre-wrap;background:#1a1f2b;border:1px solid #2b3b5f;padding:12px;border-radius:8px;max-width:100%;overflow:auto">
${(err && (err.stack || err.message)) || String(err)}
      </pre>
      <button class="btn" onclick="location.hash='#/dashboard'">Back to Dashboard</button>
    </div>`;
}

function normalizeHash() {
  if (!location.hash || !/^#\//.test(location.hash)) {
    location.hash = '#/dashboard';
  }
}

async function render() {
  try {
    normalizeHash();
    const path = location.hash.slice(1); // "/dashboard" | "/create" | "/execute/123" | "/call" | "/insights"
    const parts = path.split('/').filter(Boolean);
    const route = parts[0] || 'dashboard';
    const id = parts[1];

    // small loading placeholder
    app.innerHTML = `<div class="center"><div class="muted">Loading ${route}…</div></div>`;

    switch (route) {
      case 'dashboard':
        return Dashboard(app);

      case 'create':
        return CreateCampaign(app);

      case 'execute': {
        if (!id) throw new Error('Missing campaign id for /execute');
        const campaign = getCampaignById(id);
        if (!campaign) throw new Error('Campaign not found: ' + id);
        return Execute(app, campaign);
      }

      case 'call':
        return Call(app);

      case 'insights': {
        // Dynamic import keeps the rest of the app safe if insights.js has an error
        const mod = await import('./screens/insights.js'); // ensure filename/case matches your file exactly
        if (!mod || typeof mod.Insights !== 'function') {
          throw new Error('Insights screen not exported correctly from screens/insights.js');
        }
        return mod.Insights(app);
      }

      default:
        app.innerHTML = `<div class="center">
          <h1 class="title">Not found</h1>
          <p class="muted">Route: ${route}</p>
          <button class="btn" onclick="location.hash='#/dashboard'">Go to Dashboard</button>
        </div>`;
        return;
    }
  } catch (e) {
    showError(e);
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('load', () => {
  normalizeHash();
  render();
});