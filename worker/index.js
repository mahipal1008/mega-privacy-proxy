'use strict';

const crypto = require('crypto');
const Fastify = require('fastify');
const helmet = require('@fastify/helmet');
const cors = require('@fastify/cors');

const megaStream = require('./mega-stream');

const CONFIG = {
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
  // Separate token for worker -> orchestrator bandwidth reports.
  // NEVER returned to browser. Injected by orchestrator at spawn.
  INTERNAL_TOKEN: process.env.INTERNAL_TOKEN || '',
  ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL || '',
  MEGA_EMAIL: process.env.MEGA_EMAIL || '',
  MEGA_PASSWORD: process.env.MEGA_PASSWORD || '',
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || '*',
  PORT: parseInt(process.env.PORT || '10000', 10),
};

// Defense-in-depth: same regex orchestrator uses. Reject anything else
// to prevent SSRF / mega-lib being called with attacker-controlled URLs.
const MEGA_LINK_RE = /^https?:\/\/mega\.(nz|co\.nz)\/(file\/[A-Za-z0-9_-]{6,}#[A-Za-z0-9_-]{16,}(\/file\/[A-Za-z0-9_-]+)?|folder\/[A-Za-z0-9_-]{6,}#[A-Za-z0-9_-]{16,}(\/folder\/[A-Za-z0-9_-]+|\/file\/[A-Za-z0-9_-]+)?|#![A-Za-z0-9_-]{6,}![A-Za-z0-9_-]{16,})/;

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

// RFC 7233 Range parsing. Returns { start, end, suffix } or null.
// Suffix `bytes=-N` => last N bytes (needs file size to resolve).
function parseRange(header, totalSize) {
  if (!header) return null;
  const m = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    // suffix range: last N bytes
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (!totalSize) return { start: 0, end: undefined, suffix: n };
    const start = Math.max(0, totalSize - n);
    return { start, end: totalSize - 1 };
  }
  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0) return null;
  let end;
  if (endStr !== '') {
    end = parseInt(endStr, 10);
    if (!Number.isFinite(end) || end < start) return null;
  } else if (totalSize) {
    end = totalSize - 1;
  }
  if (totalSize && typeof end === 'number') end = Math.min(end, totalSize - 1);
  if (totalSize && start >= totalSize) return null; // 416 trigger
  return { start, end };
}

function buildApp(opts = {}) {
  const config = { ...CONFIG, ...(opts.config || {}) };
  const stream = opts.megaStream || megaStream;

  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 4 * 1024, trustProxy: false });
  app.register(helmet, {
    global: true,
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
    // Allow browser fetch from client origin to download bytes.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  app.register(cors, {
    origin: config.CLIENT_ORIGIN === '*' ? true : config.CLIENT_ORIGIN.split(','),
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'X-File-Size', 'Content-Disposition'],
  });

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, no-transform');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  app.setErrorHandler((err, _req, reply) => {
    // Do NOT echo err.message — may contain link/credentials from megajs.
    process.stderr.write('[worker:err]\n');
    if (!reply.sent) reply.code(err && err.statusCode ? err.statusCode : 500).send({ error: 'internal' });
  });

  function requireSession(req, reply) {
    const tok = extractBearer(req);
    if (!config.SESSION_TOKEN || !timingSafeEqStr(tok, config.SESSION_TOKEN)) {
      reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  // Per-app state (was module-global before — bad for tests + correctness).
  let inflight = 0;
  let shuttingDown = false;
  let totalBytesPiped = 0;
  let bytesSinceReport = 0;
  const REPORT_EVERY = 50 * 1024 * 1024;

  async function reportBandwidth(final = false) {
    if (!config.ORCHESTRATOR_URL || !config.INTERNAL_TOKEN) return;
    try {
      const url = config.ORCHESTRATOR_URL.replace(/\/$/, '') + '/internal/bandwidth';
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.INTERNAL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bytesUsed: totalBytesPiped, final: !!final }),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
    } catch (_) {
      // intentionally silent — no user data
    }
  }

  app.decorate('reportBandwidth', reportBandwidth);
  app.decorate('shutdown', () => {
    shuttingDown = true;
    if (inflight === 0) process.exit(0);
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/meta', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const megaLink = String((req.query && req.query.link) || '').trim();
    const childId = String((req.query && req.query.child) || '').trim() || undefined;
    if (!megaLink) { reply.code(400).send({ error: 'missing_link' }); return; }
    if (!MEGA_LINK_RE.test(megaLink)) { reply.code(400).send({ error: 'invalid_link' }); return; }
    try {
      return await stream.getMeta(megaLink, childId);
    } catch (_) {
      reply.code(502).send({ error: 'mega_error' });
    }
  });

  app.get('/stream', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const megaLink = String((req.query && req.query.link) || '').trim();
    const childId = String((req.query && req.query.child) || '').trim() || undefined;
    if (!megaLink) { reply.code(400).send({ error: 'missing_link' }); return; }
    if (!MEGA_LINK_RE.test(megaLink)) { reply.code(400).send({ error: 'invalid_link' }); return; }
    let meta;
    try { meta = await stream.getMeta(megaLink, childId); } catch (_) {
      reply.code(502).send({ error: 'mega_error' });
      return;
    }
    if (meta.type === 'folder') { reply.code(400).send({ error: 'folder_link_needs_child' }); return; }

    const range = parseRange(req.headers && req.headers.range, meta.fileSize);
    if (range && meta.fileSize && range.start >= meta.fileSize) {
      reply.code(416).header('Content-Range', `bytes */${meta.fileSize}`).send();
      return;
    }
    const start = range ? range.start : 0;
    const end = range && typeof range.end === 'number'
      ? range.end
      : (meta.fileSize ? meta.fileSize - 1 : undefined);
    const haveLength = typeof end === 'number';
    const length = haveLength ? (end - start + 1) : undefined;

    // If we cannot compute Content-Range, fall back to 200 (don't send invalid 206).
    const useRange = !!range && haveLength && !!meta.fileSize;
    reply.raw.statusCode = useRange ? 206 : 200;
    reply.raw.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    if (useRange) {
      reply.raw.setHeader('Content-Range', `bytes ${start}-${end}/${meta.fileSize}`);
    }
    if (typeof length === 'number') {
      reply.raw.setHeader('Content-Length', String(length));
    } else {
      reply.raw.setHeader('Transfer-Encoding', 'chunked');
    }
    reply.raw.setHeader('Accept-Ranges', 'bytes');
    reply.raw.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    reply.raw.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename || 'download.bin')}`);
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    if (meta.fileSize) reply.raw.setHeader('X-File-Size', String(meta.fileSize));

    inflight++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inflight--;
      if (shuttingDown && inflight === 0) process.exit(0);
    };

    const src = stream.streamFile(megaLink, start, end, childId);
    src.on('data', (chunk) => {
      totalBytesPiped += chunk.length;
      bytesSinceReport += chunk.length;
      if (bytesSinceReport >= REPORT_EVERY) {
        bytesSinceReport = 0;
        reportBandwidth(false);
      }
    });
    src.on('error', () => {
      try { reply.raw.destroy(); } catch (_) {}
      settle();
    });
    src.on('end', () => {
      reportBandwidth(true);
      settle();
    });
    req.raw.on('close', () => {
      try { src.destroy(); } catch (_) {}
      settle();
    });
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
        .catch(() => process.stderr.write('[worker] mega auth failed\n'));
    }
  } catch (_) {
    process.stderr.write('[worker] listen err\n');
    process.exit(1);
  }
  process.on('SIGTERM', () => { app.shutdown && app.shutdown(); });
}

if (require.main === module) start();

module.exports = { buildApp, CONFIG };
