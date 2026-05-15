'use strict';

const crypto = require('crypto');
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
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== 'string') return '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Accept legacy (#!), modern file/, and folder/ links.
const MEGA_LINK_RE = /^https?:\/\/mega\.(nz|co\.nz)\/(file\/[A-Za-z0-9_-]{6,}#[A-Za-z0-9_-]{16,}|folder\/[A-Za-z0-9_-]{6,}#[A-Za-z0-9_-]{16,}|#![A-Za-z0-9_-]{6,}![A-Za-z0-9_-]{16,})/;

function buildApp(opts = {}) {
  const config = { ...CONFIG, ...(opts.config || {}) };

  // Refuse to start with wildcard CORS in production.
  if (config.NODE_ENV === 'production' && config.CLIENT_ORIGIN === '*') {
    throw new Error('CLIENT_ORIGIN must be set explicitly in production (no wildcard)');
  }

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
    bodyLimit: 4 * 1024,
    // trustProxy with hop count = 1 so req.ip = the original client IP behind
    // Render's single edge proxy. Do NOT trust the raw XFF blindly.
    trustProxy: 1,
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
    max: 60,
    timeWindow: '1 minute',
    // Use Fastify's parsed req.ip (honors trustProxy=1) — NOT raw XFF.
    keyGenerator: (req) => req.ip || 'unknown',
    // Do not rate-limit internal worker -> orchestrator traffic.
    skipOnError: true,
    allowList: () => false,
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': false,
    },
    // skip internal routes entirely
    onExceeding: () => {},
    onExceeded: () => {},
  });

  // Manually exempt /internal/* (rate-limit plugin doesn't have a simple skip).
  // Approach: register hook that bypasses rate-limit by deleting the marker
  // before the plugin runs. Simpler: register limit only on /api/* via guard.
  app.addHook('onRequest', async (req, _reply) => {
    if (req.url && req.url.startsWith('/internal/')) {
      // mark request as exempt — fastify/rate-limit honors req.routeOptions.config.rateLimit
      // but globally registered limits run before route resolution. We instead
      // attach a small flag the keyGenerator can check.
      req.__skipRateLimit = true;
    }
  });

  // Wrap rate-limit to honor __skipRateLimit. fastify/rate-limit v9 supports
  // a `skip` callback only at route-level. We achieve global skip by
  // overriding keyGenerator to return a unique key per internal request
  // (preventing any one source from hitting the bucket).
  // Replace registration above with a route-scoped approach instead:
  // (the global registration is still safe; below we override per-route.)

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err && err.statusCode === 429) {
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: err.code || 'bad_request' });
      return;
    }
    process.stderr.write('[orch:err]\n');
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

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/', { config: { rateLimit: false } }, async (_req, reply) => {
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
    pool.incInflight(worker.id);
    // Decrement after a generous window — we don't get a callback when the
    // browser actually finishes. This is a best-effort load balancer hint.
    setTimeout(() => pool.decInflight(worker.id), 5 * 60 * 1000).unref();
    return {
      workerUrl: worker.url,
      sessionToken: worker.sessionToken, // browser uses this for /meta and /stream
      workerId: worker.id,
      // NOTE: internalToken is NEVER returned to the client.
    };
  });

  // Worker -> orchestrator bandwidth reports. Authenticated with the
  // internalToken which is ONLY known to the spawned worker and the
  // orchestrator. The browser never sees this token.
  app.post('/internal/bandwidth', { config: { rateLimit: false } }, async (req, reply) => {
    const tok = extractBearer(req);
    // Constant-time lookup
    const worker = pool.getByInternalToken(tok);
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
      app.lifecycle.onStartup().catch(() => process.stderr.write('[orch] startup spawn err\n'));
      app.lifecycle.startPeriodicMaintenance(60000);
    } else {
      process.stderr.write('[orch] Render API not configured; workers will not auto-spawn.\n');
    }
  } catch (_) {
    process.stderr.write('[orch] listen err\n');
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { buildApp, CONFIG, MEGA_LINK_RE };
