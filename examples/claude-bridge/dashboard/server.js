'use strict';

const path = require('node:path');
const express = require('express');
const { buildSystemPrompt, promptInfo } = require('../lib/company');
const { createStore } = require('../lib/store');
const { exportCompany } = require('../lib/export');
const openwa = require('../lib/openwa');
const { httpError } = require('../lib/errors');

const PORT = 3100;
const LABELS = { sessionId: 'sesión', webhookUrl: 'URL del webhook', secret: 'OPENWA_WEBHOOK_SECRET' };

function createApp({ rootDir, port }) {
  const store = createStore(rootDir);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const app = express();

  // Only this machine: reject any Host but our own, which also stops DNS-rebinding pages.
  app.use((req, res, next) =>
    allowedHosts.has(req.headers.host) ? next() : res.status(403).json({ error: 'host no permitido' }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const route = handler => async (req, res) => {
    try {
      res.json(await handler(req, res));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[dashboard]', err);
      res.status(status).json({ error: err.message, errors: err.errors });
    }
  };

  /** The saved homologación settings and keys needed to call OpenWA, or a 400 naming what is missing. */
  function homologation(id, needed = []) {
    const env = store.read(id).environments.homologacion;
    const secrets = store.rawSecrets(id);
    const missing = [
      !env.openwaUrl && 'URL de OpenWA',
      !secrets.OPENWA_API_KEY && 'OPENWA_API_KEY',
      ...needed.filter(k => (k === 'secret' ? !secrets.OPENWA_WEBHOOK_SECRET : !env[k])).map(k => LABELS[k]),
    ].filter(Boolean);
    if (missing.length) throw httpError(400, `falta guardar en homologación: ${missing.join(', ')}`);
    return { conn: { openwaUrl: env.openwaUrl, apiKey: secrets.OPENWA_API_KEY }, env, secrets };
  }

  app.get('/api/companies', route(() => store.list()));
  app.post(
    '/api/companies',
    route((req, res) => {
      const body = req.body || {};
      const company = store.create(body.id, body.copyFrom || null);
      res.status(201);
      return company;
    }),
  );
  app.get('/api/companies/:id', route(req => store.read(req.params.id)));
  app.put(
    '/api/companies/:id',
    route(req => ({
      company: store.write(req.params.id, req.body),
      restart: `npm run dev -- --company ${req.params.id} --env homologacion`,
    })),
  );
  app.delete('/api/companies/:id', route(req => ({ trashedTo: store.remove(req.params.id) })));

  app.get('/api/companies/:id/secrets', route(req => store.readSecrets(req.params.id, req.query.reveal === '1')));
  app.put('/api/companies/:id/secrets', route(req => store.writeSecrets(req.params.id, req.body)));

  app.post(
    '/api/companies/:id/prompt-preview',
    route(req => {
      const prompt = buildSystemPrompt(req.body || {});
      return { prompt, ...promptInfo(prompt) };
    }),
  );

  app.get('/api/companies/:id/openwa/sessions', route(req => openwa.listSessions(homologation(req.params.id).conn)));
  app.post(
    '/api/companies/:id/openwa/webhook',
    route(req => {
      const { conn, env, secrets } = homologation(req.params.id, ['sessionId', 'webhookUrl', 'secret']);
      return openwa.ensureWebhook(conn, {
        sessionId: env.sessionId,
        webhookUrl: env.webhookUrl,
        secret: secrets.OPENWA_WEBHOOK_SECRET,
      });
    }),
  );
  app.post(
    '/api/companies/:id/openwa/test',
    route(async req => {
      const { conn, env } = homologation(req.params.id, ['sessionId', 'webhookUrl']);
      const hook = await openwa.findWebhook(conn, env.sessionId, env.webhookUrl);
      if (!hook) throw httpError(404, 'el webhook todavía no está registrado; usá "Registrar webhook"');
      return openwa.testWebhook(conn, { sessionId: env.sessionId, webhookId: hook.id });
    }),
  );

  app.post(
    '/api/companies/:id/export',
    route(req => exportCompany({ rootDir, id: req.params.id, overwrite: (req.body || {}).overwrite === true })),
  );

  return app;
}

if (require.main === module) {
  createApp({ rootDir: path.join(__dirname, '..'), port: PORT }).listen(PORT, '127.0.0.1', () => {
    console.log(`[dashboard] http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createApp };
