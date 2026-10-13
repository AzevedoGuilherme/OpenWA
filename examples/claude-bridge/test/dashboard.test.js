'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../dashboard/server');
const { tempRoot } = require('./helpers');

async function startDashboard(t) {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.on('request', createApp({ rootDir: tempRoot(), port }));
  t.after(() => server.close());
  return port;
}

/** http.request, because fetch does not let us choose the Host header. */
function request(port, { method = 'GET', path, body, host = `127.0.0.1:${port}` }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { host, ...(payload ? { 'content-type': 'application/json' } : {}) } },
      res => {
        let text = '';
        res.on('data', d => (text += d)).on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('refuses any Host other than its own (DNS rebinding)', async t => {
  const port = await startDashboard(t);
  const res = await request(port, { path: '/api/companies', host: `evil.example:${port}` });
  assert.equal(res.status, 403);
  const ok = await request(port, { path: '/api/companies', host: `localhost:${port}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map(c => c.id), ['rocabianca']);
});

test('invalid ids answer 400, unknown ones 404', async t => {
  const port = await startDashboard(t);
  assert.equal((await request(port, { path: '/api/companies/BAD' })).status, 400);
  assert.equal((await request(port, { path: '/api/companies/nope' })).status, 404);
});

test('save returns field errors, then the restart command', async t => {
  const port = await startDashboard(t);
  const company = (await request(port, { path: '/api/companies/rocabianca' })).body;
  company.bridge.timeZone = 'Nowhere/Land';
  const bad = await request(port, { method: 'PUT', path: '/api/companies/rocabianca', body: company });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors, [{ field: 'bridge.timeZone', message: 'zona horaria IANA inválida' }]);
  company.bridge.timeZone = 'America/Argentina/Cordoba';
  const good = await request(port, { method: 'PUT', path: '/api/companies/rocabianca', body: company });
  assert.equal(good.status, 200);
  assert.equal(good.body.restart, 'npm run dev -- --company rocabianca --env homologacion');
});

test('secrets come back masked; the preview uses the unsaved draft', async t => {
  const port = await startDashboard(t);
  await request(port, { method: 'PUT', path: '/api/companies/rocabianca/secrets', body: { OPENWA_API_KEY: 'owa_k1_abcdefgh' } });
  const secrets = (await request(port, { path: '/api/companies/rocabianca/secrets' })).body;
  assert.deepEqual(secrets.OPENWA_API_KEY, { set: true, value: 'owa_••••gh' });
  const draft = (await request(port, { path: '/api/companies/rocabianca' })).body;
  draft.business.name = 'Borrador';
  const preview = await request(port, { method: 'POST', path: '/api/companies/rocabianca/prompt-preview', body: draft });
  assert.match(preview.body.prompt, /^Sos el asistente de WhatsApp de Borrador\./);
  assert.equal(preview.body.sha256.length, 12);
});

test('OpenWA actions explain what is missing; export explains what production needs', async t => {
  const port = await startDashboard(t);
  const sessions = await request(port, { path: '/api/companies/rocabianca/openwa/sessions' });
  assert.equal(sessions.status, 400);
  assert.match(sessions.body.error, /OPENWA_API_KEY/);
  const exported = await request(port, { method: 'POST', path: '/api/companies/rocabianca/export' });
  assert.equal(exported.status, 400);
  assert.equal(exported.body.errors.length, 3);
});

test('create, then delete moves the company to the trash', async t => {
  const port = await startDashboard(t);
  const created = await request(port, { method: 'POST', path: '/api/companies', body: { id: 'nueva', copyFrom: null } });
  assert.equal(created.status, 201);
  assert.equal(created.body.environments.homologacion.port, 3002);
  const removed = await request(port, { method: 'DELETE', path: '/api/companies/nueva' });
  assert.equal(removed.status, 200);
  assert.match(removed.body.trashedTo, /\.trash/);
});
