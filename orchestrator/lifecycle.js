'use strict';

const crypto = require('crypto');
const { STATUS } = require('./pool');

const WARMING_DEADLINE_MS = 8 * 60 * 1000; // 8 min — Render starter cold builds

function createLifecycle({ pool, renderApi, config, logger }) {
  const log = logger || (() => process.stderr.write('[lifecycle]\n'));
  const inFlight = new Set();
  const promoters = new Set();

  // Synchronous-ish spawn: POST /services, register WARMING, return.
  // A background promoter polls health and flips to ACTIVE.
  async function spawnOne() {
    const sessionToken = crypto.randomUUID();
    const internalToken = crypto.randomUUID();
    const id = `w_${sessionToken.slice(0, 8)}`;
    const record = pool.addWorker({ id, sessionToken, internalToken, status: STATUS.WARMING });
    inFlight.add(id);

    let serviceId = null;
    try {
      const spawned = await renderApi.spawnWorker({
        sessionToken,
        internalToken,
        orchestratorUrl: config.ORCHESTRATOR_URL,
        megaEmail: config.MEGA_EMAIL,
        megaPassword: config.MEGA_PASSWORD,
        clientOrigin: config.CLIENT_ORIGIN || '*',
      });
      serviceId = spawned.serviceId || null;
      record.serviceId = serviceId;
      pool.setServiceId(id, serviceId);
      if (spawned.url) pool.setUrl(id, spawned.url);
    } catch (err) {
      log('[lifecycle] spawn POST failed', err && err.message);
      pool.removeWorker(id);
      inFlight.delete(id);
      throw err;
    }

    // Background promotion (does NOT block). On terminal failure, cleans up.
    const promoter = (async () => {
      try {
        const status = await renderApi.getWorkerStatus(serviceId, { timeoutMs: WARMING_DEADLINE_MS });
        if (status.url) pool.setUrl(id, status.url);
        const cur = pool.getWorker(id);
        if (!cur) return; // removed externally
        if (status.state === 'live') {
          pool.markActive(id);
        } else {
          // failed or timeout — release and delete the Render service
          log('[lifecycle] warming->failed', id, status.state);
          pool.removeWorker(id);
          try { await renderApi.killWorker(serviceId); } catch (_) {}
        }
      } catch (e) {
        log('[lifecycle] promoter err', e && e.message);
        if (pool.getWorker(id)) {
          pool.removeWorker(id);
          try { await renderApi.killWorker(serviceId); } catch (_) {}
        }
      } finally {
        inFlight.delete(id);
      }
    })();
    promoters.add(promoter);
    promoter.finally(() => promoters.delete(promoter));

    return record;
  }

  async function spawnOneWithRetry(retries = 3) {
    let last;
    for (let i = 0; i < retries; i++) {
      try { return await spawnOne(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
    throw last;
  }

  async function onStartup() {
    const needed = Math.max(0, config.MIN_WORKERS - pool.getAllWorkers().length);
    const results = await Promise.allSettled(
      Array.from({ length: needed }, () => spawnOneWithRetry(3))
    );
    return results;
  }

  async function onBandwidthReport(workerId, newBytesUsed) {
    const worker = pool.getWorker(workerId);
    if (!worker) return;
    pool.setBytes(workerId, newBytesUsed);
    const after = pool.getWorker(workerId);
    if (!after) return;
    if (after.status === STATUS.ACTIVE && after.bytesUsed >= config.BW_WARN_BYTES) {
      const active = pool.countByStatus(STATUS.ACTIVE) + pool.countByStatus(STATUS.WARMING);
      if (active <= config.MIN_WORKERS) {
        spawnOneWithRetry(3).catch((e) => log('[lifecycle] prewarm fail', e && e.message));
      }
    }
    if (after.bytesUsed >= config.BW_LIMIT_BYTES && after.status !== STATUS.DRAINING) {
      pool.markDraining(workerId);
      const sid = after.serviceId;
      setTimeout(() => {
        renderApi.killWorker(sid)
          .catch((e) => log('[lifecycle] kill failed', e && e.message))
          .finally(() => pool.removeWorker(workerId));
      }, 30000);
    }
  }

  async function ensureMinWorkers() {
    // Gate by in-flight to prevent double-spawn on overlapping ticks.
    const haveOrComing = pool.countByStatus(STATUS.ACTIVE) + pool.countByStatus(STATUS.WARMING);
    const pending = inFlight.size;
    const deficit = config.MIN_WORKERS - Math.max(haveOrComing, pending);
    if (deficit <= 0) return [];
    const results = [];
    for (let i = 0; i < deficit; i++) {
      results.push(spawnOneWithRetry(3).catch((e) => { log('[lifecycle] ensureMin fail', e && e.message); return null; }));
    }
    return Promise.all(results);
  }

  // Reap stuck WARMING workers older than deadline.
  async function reapStuckWarming() {
    const now = Date.now();
    for (const w of pool.getAllWorkers()) {
      if (w.status === STATUS.WARMING && (now - w.createdAt) > WARMING_DEADLINE_MS && !inFlight.has(w.id)) {
        pool.removeWorker(w.id);
        if (w.serviceId) { try { await renderApi.killWorker(w.serviceId); } catch (_) {} }
      }
    }
  }

  function startPeriodicMaintenance(intervalMs = 60000) {
    const h1 = setInterval(() => { ensureMinWorkers().catch(() => {}); }, intervalMs);
    const h2 = setInterval(() => { reapStuckWarming().catch(() => {}); }, intervalMs);
    h1.unref && h1.unref(); h2.unref && h2.unref();
    return () => { clearInterval(h1); clearInterval(h2); };
  }

  return {
    spawnOne, spawnOneWithRetry, onStartup, onBandwidthReport,
    ensureMinWorkers, reapStuckWarming, startPeriodicMaintenance,
    // Wait for all background promotions to settle (used by tests).
    waitForPromotions: async () => { while (promoters.size) await Promise.allSettled([...promoters]); },
    _inFlight: inFlight,
    _promoters: promoters,
  };
}

module.exports = { createLifecycle };
