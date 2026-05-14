'use strict';

jest.mock('../worker/mega-stream', () => {
  const { Readable } = require('stream');
  return {
    authenticate: jest.fn(async () => ({})),
    getMeta: jest.fn(async (link) => {
      if (link === 'authfail') throw new Error('auth');
      if (link === 'zero') return { filename: 'z', fileSize: 0, mimeType: 'application/octet-stream' };
      return { filename: 'x', fileSize: 16, mimeType: 'application/octet-stream' };
    }),
    streamFile: jest.fn((_link, start = 0, end = 15) => {
      if (_link === 'zero') return Readable.from([]);
      if (_link === 'neterr') {
        const r = new Readable({ read(){} });
        process.nextTick(() => r.destroy(new Error('network drop')));
        return r;
      }
      return Readable.from([Buffer.alloc(end - start + 1, 0x55)]);
    }),
  };
});

const { Pool, STATUS } = require('../orchestrator/pool');
const { buildApp: buildOrch } = require('../orchestrator/index');
const { buildApp: buildWorker } = require('../worker/index');
const { createLifecycle } = require('../orchestrator/lifecycle');

const TOK = 'test-personal-token-1234567890abcdef';

describe('edge cases', () => {
  test('zero-byte file streams empty body', async () => {
    const w = buildWorker({ config: { SESSION_TOKEN: 's', PORT: 0 } });
    const r = await w.inject({ method: 'GET', url: '/stream?link=zero', headers: { Authorization: 'Bearer s' } });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(0);
  });

  test('malformed MEGA link rejected at orchestrator', async () => {
    const pool = new Pool();
    pool.addWorker({ id: 'w', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    const app = buildOrch({ pool, config: { PERSONAL_TOKEN: TOK, CLIENT_ORIGIN: '*', MIN_WORKERS: 1, BW_LIMIT_BYTES: 1, BW_WARN_BYTES: 1 } });
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
      payload: { megaLink: 'http://evil.com/x' },
    });
    expect(r.statusCode).toBe(400);
  });

  test('SQL-injection-shaped token still 403', async () => {
    const pool = new Pool();
    pool.addWorker({ id: 'w', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    const app = buildOrch({ pool, config: { PERSONAL_TOKEN: TOK, CLIENT_ORIGIN: '*' } });
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: "Bearer ' OR 1=1;--" },
      payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' },
    });
    expect(r.statusCode).toBe(403);
  });

  test('timing-safe token comparison: ~constant time', async () => {
    const pool = new Pool();
    pool.addWorker({ id: 'w', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    const app = buildOrch({ pool, config: { PERSONAL_TOKEN: TOK, CLIENT_ORIGIN: '*' } });
    async function timeIt(tok) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 30; i++) {
        await app.inject({ method: 'GET', url: '/api/status', headers: { Authorization: 'Bearer ' + tok } });
      }
      return Number(process.hrtime.bigint() - t0);
    }
    const a = await timeIt('x'.repeat(TOK.length));
    const b = await timeIt('y'.repeat(TOK.length));
    const ratio = Math.max(a, b) / Math.min(a, b);
    expect(ratio).toBeLessThan(5);
  });

  test('large body (>64KB) rejected', async () => {
    const pool = new Pool();
    pool.addWorker({ id: 'w', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    const app = buildOrch({ pool, config: { PERSONAL_TOKEN: TOK, CLIENT_ORIGIN: '*' } });
    const big = { megaLink: 'A'.repeat(200000) };
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
      payload: big,
    });
    expect([400, 413, 500]).toContain(r.statusCode);
    expect(r.statusCode).not.toBe(200);
  });

  test('bandwidth counter overflow handled', () => {
    const p = new Pool();
    p.addWorker({ id: 'a', sessionToken: 't', url: 'u', status: STATUS.ACTIVE });
    p.updateBytes('a', Number.MAX_SAFE_INTEGER);
    p.updateBytes('a', 100);
    expect(p.getWorker('a').bytesUsed).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('Render API spawn retries with backoff', async () => {
    const { createLifecycle } = require('../orchestrator/lifecycle');
    const pool = new Pool();
    let n = 0;
    const renderApi = {
      spawnWorker: jest.fn(async () => { n++; if (n < 3) throw new Error('flaky'); return { serviceId: 's', url: 'https://w' }; }),
      killWorker: jest.fn(async () => ({ ok: true })),
      getWorkerStatus: jest.fn(async () => ({ state: 'live', url: 'https://w' })),
    };
    const lc = createLifecycle({ pool, renderApi, config: { MIN_WORKERS: 1, BW_LIMIT_BYTES: 1, BW_WARN_BYTES: 1, ORCHESTRATOR_URL: 'u', MEGA_EMAIL: 'e', MEGA_PASSWORD: 'p' } });
    await lc.spawnOneWithRetry(3);
    expect(renderApi.spawnWorker).toHaveBeenCalledTimes(3);
  });

  test('no workers => /api/download 503', async () => {
    const app = buildOrch({ pool: new Pool(), config: { PERSONAL_TOKEN: TOK, CLIENT_ORIGIN: '*' } });
    const r = await app.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' },
      payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' },
    });
    expect(r.statusCode).toBe(503);
  });
});
