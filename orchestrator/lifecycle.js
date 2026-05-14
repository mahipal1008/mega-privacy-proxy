'use strict';

const { randomUUID } = require('crypto');
const { STATUS } = require('./pool');

function createLifecycle({ pool, renderApi, config, logger }) {
  const log = logger || ((...a) => process.stderr.write(a.map(String).join(' ') + '\n'));
  const inFlight = new Set();

  async function spawnOne() {
    const sessionToken = randomUUID();
    const id = `w_${sessionToken.slice(0, 8)}`;
    const record = pool.addWorker({ id, sessionToken, status: STATUS.WARMING });
    inFlight.add(id);
    try {
      const { serviceId, url } = await renderApi.spawnWorker({
        sessionToken,
        orchestratorUrl: config.ORCHESTRATOR_URL,
        megaEmail: config.MEGA_EMAIL,
        megaPassword: config.MEGA_PASSWORD,
      });
      record.serviceId = serviceId;
      if (url) pool.setUrl(id, url);
      if (serviceId) {
        const status = await renderApi.getWorkerStatus(serviceId);
        if (status.url) pool.setUrl(id, status.url);
        if (status.state === 'live') pool.markActive(id);
      }
      return record;
    } catch (err) {
      log('[lifecycle] spawn failed', err && err.message);
      pool.removeWorker(id);
      throw err;
    } finally {
      inFlight.delete(id);
    }
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
    if (worker.status === STATUS.ACTIVE && newBytesUsed >= config.BW_WARN_BYTES) {
      const active = pool.countByStatus(STATUS.ACTIVE) + pool.countByStatus(STATUS.WARMING);
      if (active <= config.MIN_WORKERS) {
        spawnOneWithRetry(3).catch((e) => log('[lifecycle] prewarm spawn failed', e && e.message));
      }
    }
    if (newBytesUsed >= config.BW_LIMIT_BYTES && worker.status !== STATUS.DRAINING) {
      pool.markDraining(workerId);
      setTimeout(() => {
        renderApi.killWorker(worker.serviceId)
          .catch((e) => log('[lifecycle] kill failed', e && e.message))
          .finally(() => pool.removeWorker(workerId));
      }, 30000);
    }
  }

  async function ensureMinWorkers() {
    const haveOrComing = pool.countByStatus(STATUS.ACTIVE) + pool.countByStatus(STATUS.WARMING);
    const deficit = config.MIN_WORKERS - haveOrComing;
    if (deficit <= 0) return [];
    const results = [];
    for (let i = 0; i < deficit; i++) {
      results.push(spawnOneWithRetry(3).catch((e) => { log('[lifecycle] ensureMin spawn fail', e && e.message); return null; }));
    }
    return Promise.all(results);
  }

  function startPeriodicMaintenance(intervalMs = 60000) {
    const handle = setInterval(() => { ensureMinWorkers().catch(() => {}); }, intervalMs);
    handle.unref && handle.unref();
    return () => clearInterval(handle);
  }

  return { spawnOne, spawnOneWithRetry, onStartup, onBandwidthReport, ensureMinWorkers, startPeriodicMaintenance };
}

module.exports = { createLifecycle };
