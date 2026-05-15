'use strict';

const BASE_URL = 'https://api.render.com/v1';
const REQ_TIMEOUT_MS = 15_000;

function makeClient({ apiKey, ownerId, repo, fetchImpl }) {
  if (!apiKey) throw new Error('RENDER_API_KEY required');
  if (!ownerId) throw new Error('RENDER_OWNER_ID required');
  if (!repo) throw new Error('RENDER_GITHUB_REPO required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('fetch not available');

  async function request(path, init = {}, { retries = 2 } = {}) {
    const url = `${BASE_URL}${path}`;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let timer;
      try {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
        const res = await doFetch(url, {
          ...init,
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(init.headers || {}),
          },
        });
        if (res.status === 404) return { status: 404, body: null };
        const text = await res.text();
        let body = null;
        if (text) { try { body = JSON.parse(text); } catch { body = text; } }
        if (!res.ok) {
          const err = new Error(`Render API ${res.status}`);
          err.status = res.status;
          err.body = body;
          // Only retry transient 5xx + 429; 4xx is unfixable.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
          lastErr = err;
          if (attempt === retries) throw err;
        } else {
          return { status: res.status, body };
        }
      } catch (err) {
        if (err && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function spawnWorker({ sessionToken, internalToken, orchestratorUrl, megaEmail, megaPassword, clientOrigin, name }) {
    const serviceName = name || `mega-worker-${sessionToken.slice(0, 8)}`;
    const payload = {
      type: 'web_service',
      name: serviceName,
      ownerId,
      repo,
      autoDeploy: 'no',
      branch: 'main',
      rootDir: 'worker',
      serviceDetails: {
        env: 'node',
        plan: 'starter',
        region: 'oregon',
        envSpecificDetails: {
          buildCommand: 'npm install',
          startCommand: 'node index.js',
        },
        healthCheckPath: '/health',
      },
      envVars: [
        { key: 'SESSION_TOKEN', value: sessionToken },
        { key: 'INTERNAL_TOKEN', value: internalToken || sessionToken },
        { key: 'ORCHESTRATOR_URL', value: orchestratorUrl },
        { key: 'MEGA_EMAIL', value: megaEmail },
        { key: 'MEGA_PASSWORD', value: megaPassword },
        { key: 'CLIENT_ORIGIN', value: clientOrigin || '*' },
        { key: 'NODE_ENV', value: 'production' },
      ],
    };
    const res = await request('/services', { method: 'POST', body: JSON.stringify(payload) });
    const service = (res.body && (res.body.service || res.body)) || {};
    return {
      serviceId: service.id || (res.body && res.body.id) || null,
      url: service.serviceDetails && service.serviceDetails.url ? service.serviceDetails.url : (service.url || null),
      raw: res.body,
    };
  }

  async function killWorker(serviceId) {
    if (!serviceId) return { ok: false, reason: 'no-id' };
    const res = await request(`/services/${encodeURIComponent(serviceId)}`, { method: 'DELETE' }, { retries: 1 });
    if (res.status === 404) return { ok: true, alreadyGone: true };
    return { ok: true };
  }

  async function getService(serviceId) {
    const res = await request(`/services/${encodeURIComponent(serviceId)}`, { method: 'GET' });
    return res.body;
  }

  async function probeHealth(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const h = await doFetch(url.replace(/\/$/, '') + '/health', { method: 'GET', signal: ctrl.signal });
      return h.ok;
    } catch (_) { return false; } finally { clearTimeout(t); }
  }

  async function getWorkerStatus(serviceId, { timeoutMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
    const start = Date.now();
    let url = null;
    while (Date.now() - start < timeoutMs) {
      const svc = await getService(serviceId).catch(() => null);
      if (svc) {
        const details = svc.serviceDetails || svc;
        url = details.url || svc.url || url;
      }
      if (url && await probeHealth(url)) return { state: 'live', url };
      try {
        const deploysRes = await request(`/services/${encodeURIComponent(serviceId)}/deploys?limit=1`, { method: 'GET' }, { retries: 0 });
        const arr = Array.isArray(deploysRes.body) ? deploysRes.body : [];
        const last = arr[0] && (arr[0].deploy || arr[0]);
        if (last && (last.status === 'live' || last.status === 'active')) return { state: 'live', url };
        if (last && (last.status === 'update_failed' || last.status === 'build_failed' || last.status === 'canceled' || last.status === 'deactivated')) {
          return { state: 'failed', url };
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { state: 'timeout', url };
  }

  return { spawnWorker, killWorker, getService, getWorkerStatus, _request: request };
}

module.exports = { makeClient, BASE_URL };
