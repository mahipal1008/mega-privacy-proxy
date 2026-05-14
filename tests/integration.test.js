'use strict';

jest.mock('../worker/mega-stream', () => {
  const { Readable } = require('stream');
  const TOTAL = 4096;
  return {
    authenticate: jest.fn(async () => ({})),
    getMeta: jest.fn(async () => ({ filename: 'integ.bin', fileSize: TOTAL, mimeType: 'application/octet-stream' })),
    streamFile: jest.fn((_link, start = 0, end = TOTAL - 1) => {
      const buf = Buffer.alloc(end - start + 1);
      for (let i = 0; i < buf.length; i++) buf[i] = (start + i) & 0xff;
      return Readable.from([buf]);
    }),
    __TOTAL: TOTAL,
  };
});

const { Pool, STATUS } = require('../orchestrator/pool');
const { buildApp: buildOrch } = require('../orchestrator/index');
const { buildApp: buildWorker } = require('../worker/index');

const PERSONAL = 'test-personal-token-1234567890abcdef';
const SESS = 'sess-integ-aaaaa';
const TOTAL = 4096;

function setupOrchestrator(workerUrl) {
  const pool = new Pool();
  pool.addWorker({ id: 'w1', sessionToken: SESS, url: workerUrl, status: STATUS.ACTIVE });
  return buildOrch({ pool, config: {
    PERSONAL_TOKEN: PERSONAL, MIN_WORKERS: 2, BW_LIMIT_BYTES: 1e12, BW_WARN_BYTES: 9e11,
    CLIENT_ORIGIN: '*', MEGA_EMAIL: 'x', MEGA_PASSWORD: 'y', ORCHESTRATOR_URL: 'http://orch',
  }});
}

describe('integration', () => {
  test('orchestrator -> worker -> bytes match', async () => {
    const worker = buildWorker({ config: { SESSION_TOKEN: SESS, ORCHESTRATOR_URL: '', MEGA_EMAIL: '', MEGA_PASSWORD: '', PORT: 0 } });
    await worker.listen({ port: 0, host: '127.0.0.1' });
    const addr = worker.server.address();
    const workerUrl = `http://127.0.0.1:${addr.port}`;
    const orch = setupOrchestrator(workerUrl);

    const r = await orch.inject({
      method: 'POST', url: '/api/download',
      headers: { Authorization: 'Bearer ' + PERSONAL, 'Content-Type': 'application/json' },
      payload: { megaLink: 'https://mega.nz/file/abcdef#0123456789abcdef0123' },
    });
    expect(r.statusCode).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.workerUrl).toBe(workerUrl);

    const resp = await fetch(j.workerUrl + '/stream?link=' + encodeURIComponent('any'), {
      headers: { Authorization: 'Bearer ' + j.sessionToken },
    });
    expect(resp.status).toBe(200);
    const buf = Buffer.from(await resp.arrayBuffer());
    expect(buf.length).toBe(TOTAL);
    for (let i = 0; i < TOTAL; i++) expect(buf[i]).toBe(i & 0xff);

    await worker.close();
  }, 30000);

  test('concurrent downloads do not mix bytes', async () => {
    const worker = buildWorker({ config: { SESSION_TOKEN: SESS, ORCHESTRATOR_URL: '', MEGA_EMAIL: '', MEGA_PASSWORD: '', PORT: 0 } });
    await worker.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${worker.server.address().port}`;
    const results = await Promise.all([1,2,3].map(async () => {
      const resp = await fetch(url + '/stream?link=any', { headers: { Authorization: 'Bearer ' + SESS } });
      return Buffer.from(await resp.arrayBuffer());
    }));
    for (const b of results) {
      expect(b.length).toBe(TOTAL);
      for (let i = 0; i < TOTAL; i++) expect(b[i]).toBe(i & 0xff);
    }
    await worker.close();
  }, 30000);
});
