'use strict';

const crypto = require('crypto');
const Fastify = require('fastify');
const helmet = require('@fastify/helmet');

const megaStream = require('./mega-stream');

const CONFIG = {
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
  ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL || '',
  MEGA_EMAIL: process.env.MEGA_EMAIL || '',
  MEGA_PASSWORD: process.env.MEGA_PASSWORD || '',
  PORT: parseInt(process.env.PORT || '10000', 10),
};

function timingSafeEqStr(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h) return '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function parseRange(header, totalSize) {
  if (!header) return null;
  const m = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : (totalSize ? totalSize - 1 : undefined);
  if (!Number.isFinite(start) || start < 0) return null;
  return { start, end };
}

let inflight = 0;
let shuttingDown = false;

function buildApp(opts = {}) {
  const config = { ...CONFIG, ...(opts.config || {}) };
  const stream = opts.megaStream || megaStream;

  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 64 * 1024, trustProxy: false });
  app.register(helmet, { global: true, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } });

  app.addHook('onRequest', async (req, reply) => {
    if (req.raw && req.raw.socket && req.raw.socket.remoteAddress) {
      // Intentionally do nothing with IP. Never log, never store.
    }
    reply.header('Cache-Control', 'no-store, no-cache, no-transform');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // CORS — browser hits workers directly for /meta and /stream
    const origin = req.headers && req.headers.origin;
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
      reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      reply.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, X-File-Size');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    process.stderr.write(`[worker:err] ${err && err.message}\n`);
    if (!reply.sent) reply.code(500).send({ error: 'internal' });
  });

  function requireSession(req, reply) {
    const tok = extractBearer(req);
    if (!config.SESSION_TOKEN || !timingSafeEqStr(tok, config.SESSION_TOKEN)) {
      reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  let totalBytesPiped = 0;
  let bytesSinceReport = 0;
  const REPORT_EVERY = 50 * 1024 * 1024;

  async function reportBandwidth(final = false) {
    if (!config.ORCHESTRATOR_URL) return;
    try {
      const url = config.ORCHESTRATOR_URL.replace(/\/$/, '') + '/internal/bandwidth';
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.SESSION_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bytesUsed: totalBytesPiped, final: !!final }),
      });
    } catch (e) {
      process.stderr.write(`[worker] bw report err ${e && e.message}\n`);
    }
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/meta', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const megaLink = String((req.query && req.query.link) || '').trim();
    const childId = String((req.query && req.query.child) || '').trim() || undefined;
    if (!megaLink) { reply.code(400).send({ error: 'missing_link' }); return; }
    try {
      const meta = await stream.getMeta(megaLink, childId);
      return meta;
    } catch (err) {
      process.stderr.write(`[worker] meta err ${err && err.message}\n`);
      reply.code(502).send({ error: 'mega_error', detail: String(err && err.message || '').slice(0, 80) });
    }
  });

  app.get('/stream', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const megaLink = String((req.query && req.query.link) || '').trim();
    const childId = String((req.query && req.query.child) || '').trim() || undefined;
    if (!megaLink) { reply.code(400).send({ error: 'missing_link' }); return; }
    let meta;
    try { meta = await stream.getMeta(megaLink, childId); } catch (e) {
      process.stderr.write(`[worker] meta err ${e && e.message}\n`);
      reply.code(502).send({ error: 'mega_error' });
      return;
    }
    if (meta.type === 'folder') { reply.code(400).send({ error: 'folder_link_needs_child' }); return; }
    const range = parseRange(req.headers && req.headers.range, meta.fileSize);
    const start = range ? range.start : 0;
    const end = range && typeof range.end === 'number' ? range.end : (meta.fileSize ? meta.fileSize - 1 : undefined);
    const length = (typeof end === 'number' ? (end - start + 1) : meta.fileSize);

    reply.raw.statusCode = range ? 206 : 200;
    reply.raw.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    reply.raw.setHeader('Transfer-Encoding', 'chunked');
    reply.raw.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.filename || 'download.bin')}"`);
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    if (range && typeof end === 'number' && meta.fileSize) {
      reply.raw.setHeader('Content-Range', `bytes ${start}-${end}/${meta.fileSize}`);
    }
    if (length) reply.raw.setHeader('X-File-Size', String(meta.fileSize));

    inflight++;
    const src = stream.streamFile(megaLink, start, end, childId);
    src.on('data', (chunk) => {
      totalBytesPiped += chunk.length;
      bytesSinceReport += chunk.length;
      if (bytesSinceReport >= REPORT_EVERY) {
        bytesSinceReport = 0;
        reportBandwidth(false);
      }
    });
    src.on('error', (err) => {
      process.stderr.write(`[worker] stream err ${err && err.message}\n`);
      try { reply.raw.destroy(err); } catch {}
      inflight--;
    });
    src.on('end', async () => {
      inflight--;
      await reportBandwidth(true);
      if (shuttingDown && inflight === 0) process.exit(0);
    });
    req.raw.on('close', () => { try { src.destroy(); } catch {} });
    src.pipe(reply.raw);
    return reply;
  });

  return app;
}

async function start() {
  const app = buildApp();
  try {
    await app.listen({ port: CONFIG.PORT, host: '0.0.0.0' });
    process.stderr.write(`[worker] listening :${CONFIG.PORT}\n`);
    if (CONFIG.MEGA_EMAIL && CONFIG.MEGA_PASSWORD) {
      megaStream.authenticate({ email: CONFIG.MEGA_EMAIL, password: CONFIG.MEGA_PASSWORD })
        .catch((e) => process.stderr.write(`[worker] mega auth fail ${e && e.message}\n`));
    }
  } catch (err) {
    process.stderr.write(`[worker] listen err ${err && err.message}\n`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  shuttingDown = true;
  if (inflight === 0) process.exit(0);
  setTimeout(() => process.exit(0), 120000).unref();
});

if (require.main === module) start();

module.exports = { buildApp, CONFIG };
