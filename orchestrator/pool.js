'use strict';

const STATUS = Object.freeze({
  WARMING: 'WARMING',
  ACTIVE: 'ACTIVE',
  DRAINING: 'DRAINING',
});

class Pool {
  constructor() {
    this.workers = new Map();
    this.startedAt = Date.now();
  }

  addWorker(worker) {
    if (!worker || !worker.id) throw new Error('worker.id required');
    const record = {
      id: worker.id,
      serviceId: worker.serviceId || null,
      url: worker.url || null,
      sessionToken: worker.sessionToken,
      bytesUsed: 0,
      status: worker.status || STATUS.WARMING,
      createdAt: Date.now(),
    };
    this.workers.set(worker.id, record);
    return record;
  }

  setUrl(id, url) {
    const w = this.workers.get(id);
    if (w) w.url = url;
  }

  setStatus(id, status) {
    const w = this.workers.get(id);
    if (w) w.status = status;
  }

  markDraining(id) { this.setStatus(id, STATUS.DRAINING); }
  markActive(id) { this.setStatus(id, STATUS.ACTIVE); }

  updateBytes(id, delta) {
    const w = this.workers.get(id);
    if (!w) return;
    const next = w.bytesUsed + Number(delta || 0);
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
      w.bytesUsed = Number.MAX_SAFE_INTEGER;
    } else {
      w.bytesUsed = Math.max(0, next);
    }
  }

  setBytes(id, bytes) {
    const w = this.workers.get(id);
    if (!w) return;
    const v = Number(bytes);
    if (!Number.isFinite(v)) return;
    w.bytesUsed = Math.min(Math.max(0, v), Number.MAX_SAFE_INTEGER);
  }

  removeWorker(id) { return this.workers.delete(id); }

  getWorker(id) { return this.workers.get(id) || null; }

  getBySessionToken(token) {
    if (!token) return null;
    for (const w of this.workers.values()) {
      if (w.sessionToken === token) return w;
    }
    return null;
  }

  getActiveWorker() {
    let best = null;
    for (const w of this.workers.values()) {
      if (w.status !== STATUS.ACTIVE) continue;
      if (!w.url) continue;
      if (!best || w.bytesUsed < best.bytesUsed) best = w;
    }
    return best;
  }

  getAllWorkers() { return Array.from(this.workers.values()); }

  countByStatus(status) {
    let n = 0;
    for (const w of this.workers.values()) if (w.status === status) n++;
    return n;
  }

  getPoolStats() {
    const arr = this.getAllWorkers();
    return {
      total: arr.length,
      active: this.countByStatus(STATUS.ACTIVE),
      warming: this.countByStatus(STATUS.WARMING),
      draining: this.countByStatus(STATUS.DRAINING),
      workers: arr.map((w) => ({
        id: w.id,
        status: w.status,
        bytesUsed: w.bytesUsed,
        hasUrl: !!w.url,
        ageMs: Date.now() - w.createdAt,
      })),
    };
  }
}

module.exports = { Pool, STATUS };
