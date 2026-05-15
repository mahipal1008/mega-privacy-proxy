'use strict';

jest.mock('../worker/mega-stream', () => {
  const { Readable } = require('stream');
  const keyOf = (link) => (String(link).match(/\/file\/([A-Za-z0-9_-]+)#/) || [])[1] || '';
  return {
    authenticate: jest.fn(async () => ({})),
    getMeta: jest.fn(async (link) => {
      const k = keyOf(link);
      if (k === 'failxx') throw new Error('mega auth fail');
      return { filename: 'test.bin', fileSize: 1024, mimeType: 'application/octet-stream' };
    }),
    streamFile: jest.fn((_link, start = 0, end = 1023) => {
      const len = Math.max(0, end - start + 1);
      const buf = Buffer.alloc(len, 0x42);
      return Readable.from([buf]);
    }),
  };
});

const LINK_OK = 'https://mega.nz/file/okxxxx#0123456789abcdef0123';
const LINK_FAIL = 'https://mega.nz/file/failxx#0123456789abcdef0123';

const { buildApp } = require('../worker/index');

const CONFIG = { SESSION_TOKEN: 'sess_test_abc', ORCHESTRATOR_URL: '', MEGA_EMAIL: '', MEGA_PASSWORD: '', PORT: 0 };

describe('worker routes', () => {
  test('/health no auth', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  test('/meta requires session token', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({ method: 'GET', url: '/meta?link=' + encodeURIComponent(LINK_OK) });
    expect(r.statusCode).toBe(403);
  });

  test('/meta with valid token returns shape', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({
      method: 'GET', url: '/meta?link=' + encodeURIComponent(LINK_OK),
      headers: { Authorization: 'Bearer ' + CONFIG.SESSION_TOKEN },
    });
    expect(r.statusCode).toBe(200);
    const j = JSON.parse(r.body);
    expect(j).toEqual({ filename: 'test.bin', fileSize: 1024, mimeType: 'application/octet-stream' });
  });

  test('/meta mega fail => 502', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({
      method: 'GET', url: '/meta?link=' + encodeURIComponent(LINK_FAIL),
      headers: { Authorization: 'Bearer ' + CONFIG.SESSION_TOKEN },
    });
    expect(r.statusCode).toBe(502);
  });

  test('/meta non-MEGA URL rejected with 400 (defense-in-depth)', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({
      method: 'GET', url: '/meta?link=' + encodeURIComponent('https://evil.example.com/x'),
      headers: { Authorization: 'Bearer ' + CONFIG.SESSION_TOKEN },
    });
    expect(r.statusCode).toBe(400);
  });

  test('/stream with valid token streams bytes', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({
      method: 'GET', url: '/stream?link=' + encodeURIComponent(LINK_OK),
      headers: { Authorization: 'Bearer ' + CONFIG.SESSION_TOKEN },
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(1024);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
  });

  test('/stream wrong token => 403', async () => {
    const app = buildApp({ config: CONFIG });
    const r = await app.inject({
      method: 'GET', url: '/stream?link=' + encodeURIComponent(LINK_OK),
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(r.statusCode).toBe(403);
  });

  test('no fs disk-write APIs used in worker source', () => {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, '..', 'worker', 'mega-stream.js'), 'utf8');
    expect(code).not.toMatch(/\bwriteFile\s*\(/);
    expect(code).not.toMatch(/\bcreateWriteStream\s*\(/);
    expect(code).not.toMatch(/\bappendFile\s*\(/);
    expect(code).not.toMatch(/\bmkdtemp\s*\(/);
    expect(code).not.toMatch(/process\.tmpdir\s*\(/);
  });
});
