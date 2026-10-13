'use strict';

const { httpError } = require('./errors');

/** One OpenWA API call; any failure becomes a 502 with a message the dashboard can show as is. */
async function call({ openwaUrl, apiKey }, method, route, body) {
  const base = openwaUrl.replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw httpError(502, `no se pudo conectar a ${base}: ${(err.cause && err.cause.code) || err.message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      data && typeof data === 'object' ? [].concat(data.message || data.error || []).join('; ') : String(data || '');
    throw httpError(502, `OpenWA respondió ${res.status}${detail ? `: ${detail}` : ''}`, { upstreamStatus: res.status });
  }
  return data;
}

const asList = data => (Array.isArray(data) ? data : (data && (data.data || data.sessions || data.webhooks)) || []);
const sessionPath = sessionId => `/api/sessions/${encodeURIComponent(sessionId)}`;

async function listSessions(conn) {
  const sessions = asList(await call(conn, 'GET', '/api/sessions'));
  return sessions.map(s => ({ id: s.id, name: s.name || '', status: s.status || '', phone: s.phone || s.phoneNumber || '' }));
}

async function findWebhook(conn, sessionId, webhookUrl) {
  const hooks = asList(await call(conn, 'GET', `${sessionPath(sessionId)}/webhooks`));
  return hooks.find(h => h.url === webhookUrl) || null;
}

/** Registers the webhook for message.received unless one with this URL already exists. */
async function ensureWebhook(conn, { sessionId, webhookUrl, secret }) {
  const existing = await findWebhook(conn, sessionId, webhookUrl);
  if (existing) {
    return { created: false, id: existing.id, events: existing.events || [], active: existing.active !== false };
  }
  const created = await call(conn, 'POST', `${sessionPath(sessionId)}/webhooks`, {
    url: webhookUrl,
    events: ['message.received'],
    secret,
  });
  return { created: true, id: created.id, events: created.events || ['message.received'], active: true };
}

async function testWebhook(conn, { sessionId, webhookId }) {
  return call(conn, 'POST', `${sessionPath(sessionId)}/webhooks/${encodeURIComponent(webhookId)}/test`);
}

module.exports = { listSessions, findWebhook, ensureWebhook, testWebhook };
