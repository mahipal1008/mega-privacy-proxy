'use strict';

const BASE_URL = 'https://api.render.com/v1';

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
      try {
        const res = await doFetch(url, {
          ...init,
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
          throw err;
        }
        return { status: res.status, body };
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  async function spawnWorker({ sessionToken, orchestratorUrl, megaEmail, megaPassword, name }) {
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
        runtime: 'node',
        envSpecificDetails: {
          buildCommand: 'npm install',
          startCommand: 'node index.js',
        },
        healthCheckPath: '/health',
      },
      envVars: [
        { key: 'SESSION_TOKEN', value: sessionToken },
        { key: 'ORCHESTRATOR_URL', value: orchestratorUrl },
        { key: 'MEGA_EMAIL', value: megaEmail },
        { key: 'MEGA_PASSWORD', value: megaPassword },
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

  async function getWorkerStatus(serviceId, { timeoutMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
    const start = Date.now();
    let url = null;
    while (Date.now() - start < timeoutMs) {
      const svc = await getService(serviceId).catch(() => null);
      if (svc) {
        const details = svc.serviceDetails || svc;
        url = details.url || svc.url || url;
      }
      if (url) {
        try {
          const h = await doFetch(url.replace(/\/$/, '') + '/health', { method: 'GET' });
          if (h.ok) return { state: 'live', url };
        } catch {}
      }
      try {
        const deploysRes = await request(`/services/${encodeURIComponent(serviceId)}/deploys?limit=1`, { method: 'GET' }, { retries: 0 });
        const arr = Array.isArray(deploysRes.body) ? deploysRes.body : [];
        const last = arr[0] && (arr[0].deploy || arr[0]);
        if (last && (last.status === 'live' || last.status === 'active')) {
          return { state: 'live', url };
        }
        if (last && (last.status === 'update_failed' || last.status === 'build_failed' || last.status === 'canceled' || last.status === 'deactivated')) {
          return { state: 'failed', url };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { state: 'timeout', url };
  }

  return { spawnWorker, killWorker, getService, getWorkerStatus, _request: request };
}

module.exports = { makeClient, BASE_URL };
