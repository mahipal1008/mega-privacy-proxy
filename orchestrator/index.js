'use strict';

const crypto = require('crypto');
const path = require('path');
const Fastify = require('fastify');
const helmet = require('@fastify/helmet');
const cors = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');

const { Pool, STATUS } = require('./pool');
const { makeClient } = require('./render-api');
const { createLifecycle } = require('./lifecycle');

const CONFIG = {
  MEGA_EMAIL: process.env.MEGA_EMAIL || '',
  MEGA_PASSWORD: process.env.MEGA_PASSWORD || '',
  PERSONAL_TOKEN: process.env.PERSONAL_TOKEN || '',
  RENDER_API_KEY: process.env.RENDER_API_KEY || '',
  RENDER_OWNER_ID: process.env.RENDER_OWNER_ID || '',
  RENDER_GITHUB_REPO: process.env.RENDER_GITHUB_REPO || '',
  ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL || '',
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || '*',
  MIN_WORKERS: parseInt(process.env.MIN_WORKERS || '2', 10),
  BW_LIMIT_BYTES: parseInt(process.env.BW_LIMIT_BYTES || `${4 * 1024 * 1024 * 1024}`, 10),
  BW_WARN_BYTES: parseInt(process.env.BW_WARN_BYTES || `${Math.floor(3.8 * 1024 * 1024 * 1024)}`, 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '10000', 10),
};

function timingSafeEqStr(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== 'string') return '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

const MEGA_LINK_RE = /^https?:\/\/mega\.(nz|co\.nz)\/(file\/[A-Za-z0-9_-]{6,}#[A-Za-z0-9_-]{16,}|#![A-Za-z0-9_-]{6,}![A-Za-z0-9_-]{16,})/;

function buildApp(opts = {}) {
  const config = { ...CONFIG, ...(opts.config || {}) };
  const pool = opts.pool || new Pool();
  const renderApi = opts.renderApi || (
    config.RENDER_API_KEY && config.RENDER_OWNER_ID && config.RENDER_GITHUB_REPO
      ? makeClient({ apiKey: config.RENDER_API_KEY, ownerId: config.RENDER_OWNER_ID, repo: config.RENDER_GITHUB_REPO })
      : null
  );
  const lifecycle = opts.lifecycle || (renderApi ? createLifecycle({ pool, renderApi, config }) : null);

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  app.register(helmet, {
    global: true,
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
    crossOriginEmbedderPolicy: false,
  });
  app.register(cors, {
    origin: config.CLIENT_ORIGIN === '*' ? true : config.CLIENT_ORIGIN.split(','),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.register(rateLimit, {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
    allowList: () => false,
    addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': false },
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err && err.statusCode === 429) {
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    process.stderr.write(`[orch:err] ${err && err.message}\n`);
    reply.code(500).send({ error: 'internal' });
  });

  function requirePersonalToken(req, reply) {
    const tok = extractBearer(req);
    if (!timingSafeEqStr(tok, config.PERSONAL_TOKEN) || !config.PERSONAL_TOKEN) {
      reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return 'mega-privacy-proxy orchestrator';
  });

  app.post('/api/download', async (req, reply) => {
    if (!requirePersonalToken(req, reply)) return;
    const body = req.body || {};
    const megaLink = typeof body.megaLink === 'string' ? body.megaLink.trim() : '';
    if (!megaLink || !MEGA_LINK_RE.test(megaLink)) {
      reply.code(400).send({ error: 'invalid_link' });
      return;
    }
    const worker = pool.getActiveWorker();
    if (!worker) {
      reply.code(503).send({ error: 'no_workers' });
      return;
    }
    return {
      workerUrl: worker.url,
      sessionToken: worker.sessionToken,
      workerId: worker.id,
    };
  });

  app.post('/internal/bandwidth', async (req, reply) => {
    const tok = extractBearer(req);
    const worker = pool.getBySessionToken(tok);
    if (!worker) { reply.code(403).send({ error: 'forbidden' }); return; }
    const body = req.body || {};
    const bytesUsed = Number(body.bytesUsed);
    if (!Number.isFinite(bytesUsed) || bytesUsed < 0) { reply.code(400).send({ error: 'bad_bytes' }); return; }
    if (lifecycle) {
      lifecycle.onBandwidthReport(worker.id, bytesUsed).catch(() => {});
    } else {
      pool.setBytes(worker.id, bytesUsed);
    }
    return { status: 'ok' };
  });

  app.get('/api/status', async (req, reply) => {
    if (!requirePersonalToken(req, reply)) return;
    return { workers: pool.getPoolStats(), uptimeMs: Date.now() - pool.startedAt };
  });

  app.decorate('pool', pool);
  app.decorate('lifecycle', lifecycle);
  app.decorate('config', config);

  return app;
}

async function start() {
  const app = buildApp();
  try {
    await app.listen({ port: CONFIG.PORT, host: '0.0.0.0' });
    process.stderr.write(`[orch] listening :${CONFIG.PORT}\n`);
    if (app.lifecycle && CONFIG.RENDER_API_KEY) {
      app.lifecycle.onStartup().catch((e) => process.stderr.write(`[orch] startup spawn err ${e && e.message}\n`));
      app.lifecycle.startPeriodicMaintenance(60000);
    } else {
      process.stderr.write('[orch] Render API not configured; workers will not auto-spawn.\n');
    }
  } catch (err) {
    process.stderr.write(`[orch] listen err ${err && err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { buildApp, CONFIG };
