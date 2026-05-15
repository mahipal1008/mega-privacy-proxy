'use strict';

const path = require('path');
const { Pool, STATUS } = require('../orchestrator/pool');
const { makeClient } = require('../orchestrator/render-api');
const { createLifecycle } = require('../orchestrator/lifecycle');
const { buildApp } = require('../orchestrator/index');

const TEST_CONFIG = {
  PERSONAL_TOKEN: 'test-personal-token-1234567890abcdef',
  MEGA_EMAIL: 'a@b.c',
  MEGA_PASSWORD: 'p',
  ORCHESTRATOR_URL: 'http://orch.test',
  CLIENT_ORIGIN: '*',
  MIN_WORKERS: 2,
  BW_LIMIT_BYTES: 4 * 1024 * 1024 * 1024,
  BW_WARN_BYTES: Math.floor(3.8 * 1024 * 1024 * 1024),
  RENDER_API_KEY: '',
  RENDER_OWNER_ID: '',
  RENDER_GITHUB_REPO: '',
  NODE_ENV: 'test',
};

describe('Pool', () => {
  test('add/get/update/remove', () => {
    const p = new Pool();
    p.addWorker({ id: 'a', sessionToken: 't1', url: 'u', status: STATUS.ACTIVE });
    p.addWorker({ id: 'b', sessionToken: 't2', url: 'u2', status: STATUS.ACTIVE });
    p.updateBytes('a', 1000); p.updateBytes('b', 500);
    expect(p.getActiveWorker().id).toBe('b');
    p.markDraining('b');
    expect(p.getActiveWorker().id).toBe('a');
    expect(p.getBySessionToken('t1').id).toBe('a');
    p.removeWorker('a');
    expect(p.getWorker('a')).toBeNull();
    expect(p.getPoolStats().total).toBe(1);
  });
  test('empty pool returns null active', () => { expect(new Pool().getActiveWorker()).toBeNull(); });
  test('bytes counter clamps at MAX_SAFE_INTEGER', () => {
    const p = new Pool();
    p.addWorker({ id: 'a', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    p.updateBytes('a', Number.MAX_SAFE_INTEGER);
    p.updateBytes('a', Number.MAX_SAFE_INTEGER);
    expect(p.getWorker('a').bytesUsed).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('render-api', () => {
  test('spawnWorker posts and parses', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, text: async () => JSON.stringify({ service: { id: 'srv_1', serviceDetails: { url: 'https://w.onrender.com' } } }) };
    };
    const client = makeClient({ apiKey: 'k', ownerId: 'o', repo: 'r', fetchImpl });
    const out = await client.spawnWorker({ sessionToken: 'aaaaaaaa-bbbb', orchestratorUrl: 'u', megaEmail: 'm', megaPassword: 'p' });
    expect(out.serviceId).toBe('srv_1');
    expect(out.url).toBe('https://w.onrender.com');
    expect(calls[0].url).toMatch(/\/services$/);
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
  });
  test('killWorker returns alreadyGone on 404', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' });
    const client = makeClient({ apiKey: 'k', ownerId: 'o', repo: 'r', fetchImpl });
    const r = await client.killWorker('srv');
    expect(r.ok).toBe(true); expect(r.alreadyGone).toBe(true);
  });
  test('spawnWorker retries on network error', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; if (n < 2) throw new Error('net'); return { ok: true, status: 201, text: async () => '{"service":{"id":"x"}}' }; };
    const client = makeClient({ apiKey: 'k', ownerId: 'o', repo: 'r', fetchImpl });
    const out = await client.spawnWorker({ sessionToken: 's', orchestratorUrl: 'u', megaEmail: 'm', megaPassword: 'p' });
    expect(out.serviceId).toBe('x');
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('lifecycle', () => {
  function fakeRender(opts = {}) {
    return {
      spawnWorker: jest.fn(async ({ sessionToken }) => ({ serviceId: 'svc_' + sessionToken.slice(0, 4), url: 'https://w.test' })),
      killWorker: jest.fn(async () => ({ ok: true })),
      getWorkerStatus: jest.fn(async () => ({ state: 'live', url: 'https://w.test' })),
      ...opts,
    };
  }

  test('onStartup spawns MIN_WORKERS', async () => {
    const pool = new Pool();
    const rapi = fakeRender();
    const lc = createLifecycle({ pool, renderApi: rapi, config: TEST_CONFIG });
    await lc.onStartup();
    await lc.waitForPromotions();
    expect(rapi.spawnWorker).toHaveBeenCalledTimes(2);
    expect(pool.countByStatus(STATUS.ACTIVE)).toBe(2);
  });

  test('onBandwidthReport: WARN triggers spawn, LIMIT triggers drain+kill', async () => {
    jest.useFakeTimers();
    const pool = new Pool();
    const rapi = fakeRender();
    const lc = createLifecycle({ pool, renderApi: rapi, config: TEST_CONFIG });
    await lc.onStartup();
    jest.useRealTimers();
    await lc.waitForPromotions();
    jest.useFakeTimers();
    rapi.spawnWorker.mockClear();
    const w = pool.getActiveWorker();
    await lc.onBandwidthReport(w.id, TEST_CONFIG.BW_WARN_BYTES);
    expect(rapi.spawnWorker).toHaveBeenCalled();
    await lc.onBandwidthReport(w.id, TEST_CONFIG.BW_LIMIT_BYTES);
    expect(pool.getWorker(w.id).status).toBe(STATUS.DRAINING);
    jest.advanceTimersByTime(30001);
    await Promise.resolve(); await Promise.resolve();
    jest.useRealTimers();
  });

  test('ensureMinWorkers fills deficit', async () => {
    const pool = new Pool();
    const rapi = fakeRender();
    const lc = createLifecycle({ pool, renderApi: rapi, config: TEST_CONFIG });
    await lc.ensureMinWorkers();
    await lc.waitForPromotions();
    expect(pool.getAllWorkers().length).toBe(2);
  });
});

describe('orchestrator routes', () => {
  function build() {
    const pool = new Pool();
    pool.addWorker({ id: 'w1', sessionToken: 'st_w1', internalToken: 'it_w1', url: 'https://w.test', status: STATUS.ACTIVE });
    return buildApp({ pool, config: TEST_CONFIG });
  }

  test('GET /health no auth', async () => {
    const app = build();
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  test('POST /api/download missing token => 403', async () => {
    const app = build();
    const r = await app.inject({ method: 'POST', url: '/api/download', payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' } });
    expect(r.statusCode).toBe(403);
  });

  test('POST /api/download valid token returns assignment', async () => {
    const app = build();
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TEST_CONFIG.PERSONAL_TOKEN, 'Content-Type': 'application/json' },
      payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' },
    });
    expect(r.statusCode).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.workerUrl).toBe('https://w.test');
    expect(j.sessionToken).toBe('st_w1');
  });

  test('POST /api/download malformed link => 400', async () => {
    const app = build();
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TEST_CONFIG.PERSONAL_TOKEN, 'Content-Type': 'application/json' },
      payload: { megaLink: "'; DROP TABLE users;--" },
    });
    expect(r.statusCode).toBe(400);
  });

  test('POST /internal/bandwidth requires internal token', async () => {
    const app = build();
    const r = await app.inject({ method: 'POST', url: '/internal/bandwidth', payload: { bytesUsed: 1 } });
    expect(r.statusCode).toBe(403);
    // Session token should NOT be accepted for internal bandwidth reports
    const r0 = await app.inject({
      method: 'POST', url: '/internal/bandwidth',
      headers: { Authorization: 'Bearer st_w1', 'Content-Type': 'application/json' },
      payload: { bytesUsed: 1234 },
    });
    expect(r0.statusCode).toBe(403);
    // Internal token (set in build()) is accepted
    const r2 = await app.inject({
      method: 'POST', url: '/internal/bandwidth',
      headers: { Authorization: 'Bearer it_w1', 'Content-Type': 'application/json' },
      payload: { bytesUsed: 1234 },
    });
    expect(r2.statusCode).toBe(200);
  });

  test('GET /api/status requires personal token', async () => {
    const app = build();
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    expect(r.statusCode).toBe(403);
  });

  test('503 when no active workers', async () => {
    const pool = new Pool();
    const app = buildApp({ pool, config: TEST_CONFIG });
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TEST_CONFIG.PERSONAL_TOKEN, 'Content-Type': 'application/json' },
      payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' },
    });
    expect(r.statusCode).toBe(503);
  });
});
