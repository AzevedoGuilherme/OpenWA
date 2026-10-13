'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const openwa = require('../lib/openwa');

/** A fake OpenWA: 401 without the right key, one session, an in-memory webhook list. */
async function fakeOpenWA() {
  const hooks = [];
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d)).on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers['x-api-key'] !== 'good') return send(401, { message: 'Invalid API key', statusCode: 401 });
      if (req.url === '/api/sessions') return send(200, [{ id: 's1', name: 'demo', status: 'ready', phone: '549' }]);
      if (req.url === '/api/sessions/s1/webhooks' && req.method === 'GET') return send(200, hooks);
      if (req.url === '/api/sessions/s1/webhooks' && req.method === 'POST') {
        const hook = { id: `w${hooks.length + 1}`, active: true, ...JSON.parse(body) };
        hooks.push(hook);
        return send(201, hook);
      }
      if (req.url === '/api/sessions/s1/webhooks/w1/test') return send(200, { success: true, statusCode: 200 });
      return send(404, { message: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const openwaUrl = `http://127.0.0.1:${server.address().port}/`;
  return { openwaUrl, hooks, calls, close: () => server.close() };
}

test('listSessions maps the session list', async t => {
  const fake = await fakeOpenWA();
  t.after(fake.close);
  assert.deepEqual(await openwa.listSessions({ openwaUrl: fake.openwaUrl, apiKey: 'good' }), [
    { id: 's1', name: 'demo', status: 'ready', phone: '549' },
  ]);
});

test('ensureWebhook creates once, then reuses; testWebhook posts to the test route', async t => {
  const fake = await fakeOpenWA();
  t.after(fake.close);
  const conn = { openwaUrl: fake.openwaUrl, apiKey: 'good' };
  const args = { sessionId: 's1', webhookUrl: 'http://host.docker.internal:3001/webhook', secret: '0123456789abcdef' };
  const first = await openwa.ensureWebhook(conn, args);
  assert.deepEqual(first, { created: true, id: 'w1', events: ['message.received'], active: true });
  assert.equal(fake.hooks[0].secret, '0123456789abcdef');
  const second = await openwa.ensureWebhook(conn, args);
  assert.equal(second.created, false);
  assert.equal(fake.hooks.length, 1);
  assert.deepEqual(await openwa.testWebhook(conn, { sessionId: 's1', webhookId: 'w1' }), { success: true, statusCode: 200 });
});

test('a rejected key becomes a readable 502', async t => {
  const fake = await fakeOpenWA();
  t.after(fake.close);
  await assert.rejects(
    openwa.listSessions({ openwaUrl: fake.openwaUrl, apiKey: 'bad' }),
    err => err.status === 502 && err.message === 'OpenWA respondió 401: Invalid API key',
  );
});

test('an unreachable OpenWA becomes a readable 502', async () => {
  await assert.rejects(
    openwa.listSessions({ openwaUrl: 'http://127.0.0.1:1', apiKey: 'good' }),
    err => err.status === 502 && /^no se pudo conectar a http:\/\/127\.0\.0\.1:1/.test(err.message),
  );
});
