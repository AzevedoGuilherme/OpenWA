'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { loadCompany, buildSystemPrompt, promptInfo } = require('./lib/company');
const { normalizeText, isOptOutMessage, isReactivationMessage } = require('./lib/optout');
const { resolveRuntime, migrateLegacyOptOuts } = require('./lib/runtime');

// ---------- logging ----------

function log(tag, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tag, msg, ...extra });
  (tag === 'error' ? console.error : console.log)(`[${tag}] ${line}`);
}

// ---------- company and environment ----------

// --company/--env pick companies/<id>/company.json and its .env.<env>; COMPANY_CONFIG points at a
// company.json directly (Docker); with neither, rocaBianca runs with this folder's .env.
let runtime;
let company;
try {
  runtime = resolveRuntime(process.argv.slice(2), process.env, __dirname);
  if (runtime.envFile) dotenv.config({ path: runtime.envFile, quiet: true });
  company = loadCompany(runtime.companyFile);
} catch (err) {
  log('error', err.message, err.errors ? { errors: err.errors } : {});
  process.exit(1);
}

const environment = company.environments[runtime.envName];
const settings = company.bridge;

const { ANTHROPIC_API_KEY, OPENWA_API_KEY, OPENWA_WEBHOOK_SECRET } = process.env;
const OPENWA_URL = process.env.OPENWA_URL || environment.openwaUrl;
const PORT = process.env.PORT || String(environment.port);
const TZ = settings.timeZone;

const MODEL = settings.model;
const MAX_TOKENS = settings.maxTokens;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FALLBACK_TEXT = company.messages.fallback;
const OPT_OUT_REPLY = company.messages.optOutReply;
const HANDOFF_PHRASE = normalizeText(company.messages.handoffPhrase);
const HISTORY_LIMIT = settings.historyLimit;
const CHAT_MIN_INTERVAL_MS = settings.chatMinIntervalMs;
const DATA_DIR = runtime.dataDirOverride || path.join(__dirname, 'data', company.id);
const OPT_OUT_FILE = path.join(DATA_DIR, 'optouts.json');

const SYSTEM_PROMPT = buildSystemPrompt(company);

// ---------- config check ----------

const missing = ['ANTHROPIC_API_KEY', 'OPENWA_API_KEY', 'OPENWA_WEBHOOK_SECRET'].filter(k => !process.env[k]);
if (!OPENWA_URL) missing.push(`OPENWA_URL (or environments.${runtime.envName}.openwaUrl)`);
if (missing.length) {
  log('error', 'missing env vars', { missing });
  process.exit(1);
}

const nightStart = settings.nightPauseStart;
const nightEnd = settings.nightPauseEnd;
const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });

// maxRetries: 0 so the retry policy below is the only one in play.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 0 });

// ---------- helpers ----------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Retries on 5xx and on network errors (no HTTP status). 4xx fails at once. */
async function withRetry(tag, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status;
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      log(tag, 'retrying', { attempt: attempt + 1, status, delayMs: delay, error: err.message });
      await sleep(delay);
    }
  }
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function askClaude(messages) {
  const res = await withRetry('claude', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    }),
  );
  const reply = res.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
  log('claude', 'reply generated', {
    inputTokens: res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens,
    chars: reply.length,
  });
  return reply;
}

async function sendText(sessionId, chatId, text) {
  const url = `${OPENWA_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`;
  await withRetry('openwa', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': OPENWA_API_KEY },
      body: JSON.stringify({ chatId, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const err = new Error(`OpenWA HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  });
  log('openwa', 'message sent', { sessionId, chatId });
}

// OpenWA retries a delivery with the same idempotency key; remember recent keys so one inbound
// message never gets two answers.
const seen = new Map();
const SEEN_TTL_MS = 60 * 60 * 1000;
function alreadySeen(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

// ---------- conversation context ----------

/**
 * Last messages of the chat, read from OpenWA's own message store (newest first there), as Claude
 * turns. The current inbound message is left out: it is appended by buildMessages.
 */
async function fetchHistory(sessionId, chatId, currentMessageId) {
  const url =
    `${OPENWA_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages` +
    `?chatId=${encodeURIComponent(chatId)}&limit=${HISTORY_LIMIT}&inlineMedia=false`;
  try {
    const res = await fetch(url, { headers: { 'X-API-Key': OPENWA_API_KEY }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`OpenWA HTTP ${res.status}`);
    const { messages = [] } = await res.json();
    const turns = messages
      .filter(m => m.type === 'text' && m.body && m.waMessageId !== currentMessageId)
      .reverse()
      .map(m => ({ role: m.direction === 'outgoing' ? 'assistant' : 'user', content: m.body }));
    log('history', 'context loaded', { chatId, turns: turns.length });
    return turns;
  } catch (err) {
    log('history', 'unavailable, answering without context', { chatId, error: err.message });
    return [];
  }
}

/** Claude needs alternating turns that start and end with the user: merge runs, drop a leading reply. */
function buildMessages(history, text) {
  const merged = [];
  for (const turn of [...history, { role: 'user', content: text }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content += `\n${turn.content}`;
    else merged.push({ ...turn });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

// ---------- opt-out ----------

// Persisted so an opt-out survives restarts. An unreadable file stops the bridge instead of
// starting with an empty list, which would silently message people who asked not to be contacted.
function loadOptOuts() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(OPT_OUT_FILE, 'utf8'))));
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    log('error', 'opt-out file is unreadable; fix or remove it before starting', {
      file: OPT_OUT_FILE,
      error: err.message,
    });
    process.exit(1);
  }
}

if (!runtime.dataDirOverride && migrateLegacyOptOuts(__dirname, company.id, DATA_DIR)) {
  log('opt-out', 'moved data/optouts.json into the company folder', { file: OPT_OUT_FILE });
}
const optedOut = loadOptOuts();

function saveOptOuts() {
  try {
    fs.mkdirSync(path.dirname(OPT_OUT_FILE), { recursive: true });
    const tmp = `${OPT_OUT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(optedOut), null, 2));
    fs.renameSync(tmp, OPT_OUT_FILE);
  } catch (err) {
    log('error', 'could not persist opt-outs (kept in memory)', { error: err.message });
  }
}

// ---------- send pacing ----------

function calculateResponseDelay(text) {
  const { delayMinMs, delayMaxMs } = settings;
  const baseDelay = Math.floor(Math.random() * (delayMaxMs - delayMinMs) + delayMinMs);
  const extraBlocks = text.length > 200 ? Math.ceil((text.length - 200) / 100) : 0;
  return baseDelay + extraBlocks * 1000;
}

function isNightPause(date = new Date()) {
  const hour = Number(hourFormat.format(date));
  return nightStart > nightEnd ? hour >= nightStart || hour < nightEnd : hour >= nightStart && hour < nightEnd;
}

const lastReplyAt = new Map();

/** Waits the response delay and the per-chat interval, re-checks the opt-out, then sends. */
async function deliver(sessionId, chatId, text, { optOutReply = false } = {}) {
  const delay = calculateResponseDelay(text);
  log('delay', `esperando ${(delay / 1000).toFixed(1)}s antes de responder`, { chatId, delayMs: delay });
  await sleep(delay);

  const last = lastReplyAt.get(chatId);
  const wait = last ? CHAT_MIN_INTERVAL_MS - (Date.now() - last) : 0;
  if (wait > 0) {
    log('rate-limit', `esperando ${(wait / 1000).toFixed(1)}s extra para ${chatId}`, { chatId, waitMs: wait });
    await sleep(wait);
  }

  if (!optOutReply && optedOut.has(chatId)) {
    return log('opt-out', 'reply dropped: chat opted out while it waited', { sessionId, chatId });
  }

  await sendText(sessionId, chatId, text);
  const now = Date.now();
  lastReplyAt.set(chatId, now);
  for (const [k, t] of lastReplyAt) if (now - t > CHAT_MIN_INTERVAL_MS) lastReplyAt.delete(k);
}

// One chat's messages are handled one at a time, in arrival order, so the per-chat interval is
// measured against the reply that really went out before and the history includes it.
const chatChains = new Map();
function runInChatOrder(chatId, task) {
  const next = (chatChains.get(chatId) || Promise.resolve()).then(task);
  const settled = next.catch(() => {});
  chatChains.set(chatId, settled);
  settled.then(() => chatChains.get(chatId) === settled && chatChains.delete(chatId));
  return next;
}

async function handleMessage({ sessionId, chatId, text, messageId }) {
  const history = await fetchHistory(sessionId, chatId, messageId);
  let reply;
  try {
    reply = await askClaude(buildMessages(history, text));
  } catch (err) {
    log('error', 'claude failed, sending fallback', { sessionId, chatId, status: err.status, error: err.message });
  }
  if (reply && normalizeText(reply).includes(HANDOFF_PHRASE)) {
    log('handoff', 'derivado al equipo humano', { sessionId, chatId });
  }
  try {
    await deliver(sessionId, chatId, reply || FALLBACK_TEXT);
  } catch (err) {
    log('error', 'openwa send failed', { sessionId, chatId, status: err.status, error: err.message });
  }
}

// ---------- server ----------

const app = express();

app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature(raw, req.get('X-OpenWA-Signature'), OPENWA_WEBHOOK_SECRET)) {
    log('webhook', 'invalid signature', { ip: req.ip });
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const { event, sessionId, idempotencyKey, data = {} } = payload;
  const text = typeof data.body === 'string' ? data.body.trim() : '';
  const chatId = data.chatId || data.from;

  // Ack right away: OpenWA has a delivery timeout and Claude can take a few seconds.
  res.status(200).json({ ok: true });

  if (event !== 'message.received') return log('webhook', 'ignored event', { event });
  if (data.fromMe || data.isGroup || data.isStatusBroadcast) {
    return log('webhook', 'ignored message', { sessionId, chatId, fromMe: !!data.fromMe, isGroup: !!data.isGroup });
  }
  if (!text || !sessionId || !chatId) return log('webhook', 'ignored: no text', { sessionId, chatId, type: data.type });
  if (alreadySeen(idempotencyKey)) return log('webhook', 'duplicate delivery', { idempotencyKey });

  log('webhook', 'message received', { sessionId, chatId, chars: text.length });

  if (optedOut.has(chatId)) {
    if (!isReactivationMessage(text)) return log('opt-out', 'ignored: chat opted out', { sessionId, chatId });
    optedOut.delete(chatId);
    saveOptOuts();
    log('opt-out', 'reactivated by explicit request', { sessionId, chatId });
  } else if (isOptOutMessage(text)) {
    optedOut.set(chatId, { at: new Date().toISOString(), sessionId });
    saveOptOuts();
    log('opt-out', 'opt-out registered', { sessionId, chatId });
    runInChatOrder(chatId, () => deliver(sessionId, chatId, OPT_OUT_REPLY, { optOutReply: true })).catch(err =>
      log('error', 'opt-out reply failed', { sessionId, chatId, status: err.status, error: err.message }),
    );
    return;
  }

  // Option B: the night pause holds back proactive messages only, and this bridge sends none, so a
  // customer who writes at night is still answered.
  if (isNightPause()) log('night-pause', 'fuera de horario: se responde igual (pausa solo para proactivos)', { chatId });

  runInChatOrder(chatId, () => handleMessage({ sessionId, chatId, text, messageId: data.id })).catch(err =>
    log('error', 'unhandled', { error: err.message }),
  );
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => {
  log('webhook', 'bridge listening', {
    company: company.id,
    env: runtime.envName,
    url: `http://localhost:${PORT}/webhook`,
    openwa: OPENWA_URL,
    model: MODEL,
    systemPrompt: { ...promptInfo(SYSTEM_PROMPT), firstLine: SYSTEM_PROMPT.split('\n')[0] },
    optOuts: optedOut.size,
    timeZone: TZ,
    nightPause: `${nightStart}:00-${nightEnd}:00 (solo proactivos)`,
  });
});
