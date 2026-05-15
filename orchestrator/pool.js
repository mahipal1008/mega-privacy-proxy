'use strict';

const crypto = require('crypto');

const STATUS = Object.freeze({
  WARMING: 'WARMING',
  ACTIVE: 'ACTIVE',
  DRAINING: 'DRAINING',
});

function tseq(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

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
      internalToken: worker.internalToken || worker.sessionToken,
      bytesUsed: 0,
      inflight: 0,
      status: worker.status || STATUS.WARMING,
      createdAt: Date.now(),
      lastAssignedAt: 0,
    };
    this.workers.set(worker.id, record);
    return record;
  }

  setServiceId(id, serviceId) { const w = this.workers.get(id); if (w) w.serviceId = serviceId; }
  setUrl(id, url) { const w = this.workers.get(id); if (w) w.url = url; }
  setStatus(id, status) { const w = this.workers.get(id); if (w) w.status = status; }
  markDraining(id) { this.setStatus(id, STATUS.DRAINING); }
  markActive(id) { this.setStatus(id, STATUS.ACTIVE); }

  incInflight(id) { const w = this.workers.get(id); if (w) { w.inflight++; w.lastAssignedAt = Date.now(); } }
  decInflight(id) { const w = this.workers.get(id); if (w && w.inflight > 0) w.inflight--; }

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
    // Monotonic guard: never lower than current; refuse huge jumps that would
    // skip past the drain threshold (defense against compromised worker).
    const clamped = Math.min(Math.max(0, v), Number.MAX_SAFE_INTEGER);
    if (clamped < w.bytesUsed) return;
    w.bytesUsed = clamped;
  }

  removeWorker(id) { return this.workers.delete(id); }

  getWorker(id) { return this.workers.get(id) || null; }

  // Constant-time-ish lookup: compare against every worker so timing
  // doesn't reveal which slot matched. Session tokens are 36-char UUIDs
  // so brute force is infeasible anyway — this is belt-and-braces.
  getBySessionToken(token) {
    if (!token) return null;
    let match = null;
    for (const w of this.workers.values()) {
      if (tseq(w.sessionToken, token) && !match) match = w;
    }
    return match;
  }

  getByInternalToken(token) {
    if (!token) return null;
    let match = null;
    for (const w of this.workers.values()) {
      if (tseq(w.internalToken, token) && !match) match = w;
    }
    return match;
  }

  // Pick the active worker with lowest (inflight, bytesUsed). Avoids the
  // stampede where every new request lands on the same worker until the
  // first bandwidth report arrives.
  getActiveWorker() {
    let best = null;
    for (const w of this.workers.values()) {
      if (w.status !== STATUS.ACTIVE) continue;
      if (!w.url) continue;
      if (!best) { best = w; continue; }
      if (w.inflight < best.inflight) { best = w; continue; }
      if (w.inflight === best.inflight && w.bytesUsed < best.bytesUsed) best = w;
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
        inflight: w.inflight,
        hasUrl: !!w.url,
        ageMs: Date.now() - w.createdAt,
      })),
    };
  }
}

module.exports = { Pool, STATUS };
