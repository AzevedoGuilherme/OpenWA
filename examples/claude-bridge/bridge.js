'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const {
  ANTHROPIC_API_KEY,
  OPENWA_URL = 'http://localhost:2785',
  OPENWA_API_KEY,
  OPENWA_WEBHOOK_SECRET,
  PORT = '3001',
} = process.env;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FALLBACK_TEXT = 'Disculpá, estamos con un problema técnico. Te respondemos en un ratito 🙏';

const BUSINESS_NAME = 'rocaBianca';
const WHAT_WE_SELL = 'destacado salón de fiestas y eventos';
const TONE = 'cálido, con mensajes cortos';

const SYSTEM_PROMPT = `Sos el asistente de WhatsApp de ${BUSINESS_NAME}, un ${WHAT_WE_SELL}.
Tu tono es ${TONE}. Respondés en español rioplatense, de forma amable y concreta.

Reglas:
1. No inventes precios, fechas disponibles ni promociones. Si te preguntan, decí que un asesor se los confirma.
2. Si la pregunta es compleja (presupuestos a medida, reclamos, reservas, temas de pago), avisá que lo pasás con una persona del equipo.
3. Tus mensajes tienen como máximo 3 líneas.
4. Sin saludos largos: como mucho un "¡Hola!" y vas al punto.`;

// ---------- logging ----------

function log(tag, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tag, msg, ...extra });
  (tag === 'error' ? console.error : console.log)(`[${tag}] ${line}`);
}

// ---------- config check ----------

const missing = ['ANTHROPIC_API_KEY', 'OPENWA_API_KEY', 'OPENWA_WEBHOOK_SECRET'].filter(k => !process.env[k]);
if (missing.length) {
  log('error', 'missing env vars', { missing });
  process.exit(1);
}

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

async function askClaude(text) {
  const res = await withRetry('claude', () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
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

async function handleMessage({ sessionId, chatId, text }) {
  let reply;
  try {
    reply = await askClaude(text);
  } catch (err) {
    log('error', 'claude failed, sending fallback', { sessionId, chatId, status: err.status, error: err.message });
  }
  try {
    await sendText(sessionId, chatId, reply || FALLBACK_TEXT);
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
  handleMessage({ sessionId, chatId, text }).catch(err => log('error', 'unhandled', { error: err.message }));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => {
  log('webhook', 'bridge listening', { url: `http://localhost:${PORT}/webhook`, openwa: OPENWA_URL, model: MODEL });
});
