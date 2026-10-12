'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const {
  ANTHROPIC_API_KEY,
  OPENWA_URL = 'http://localhost:2785',
  OPENWA_API_KEY,
  OPENWA_WEBHOOK_SECRET,
  PORT = '3001',
  TZ = 'America/Argentina/Buenos_Aires',
  NIGHT_PAUSE_START = '22',
  NIGHT_PAUSE_END = '8',
} = process.env;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FALLBACK_TEXT = 'Disculpá, estamos con un problema técnico. Te respondemos en un ratito.';
const OPT_OUT_REPLY = 'Disculpá la molestia. No volveremos a enviarte mensajes.';
const HANDOFF_PHRASE = 'te paso con nuestro equipo';
const HISTORY_LIMIT = 12;
const CHAT_MIN_INTERVAL_MS = 30 * 1000;
const OPT_OUT_FILE = path.join(__dirname, 'data', 'optouts.json');

const BUSINESS_NAME = 'rocaBianca';

const SYSTEM_PROMPT = `Sos el asistente de WhatsApp de ${BUSINESS_NAME}.

${BUSINESS_NAME} organiza bodas, fiestas de 15 años, cumpleaños y eventos corporativos.

Ofrecemos servicios relacionados con organización, catering, decoración,
entretenimiento y espacios para eventos.

DATOS DEL NEGOCIO (podés compartirlos tal cual)

Salón y producción de eventos en Córdoba, Argentina.
Dirección: Bernardo O'Higgins 8500, X5014 Córdoba, Argentina.
Correo: eventos@rocabianca.com.ar
WhatsApp: +54 351 706 2763
Servicios confirmados: decoración floral; catering y decoración; entretenimiento;
espacios interiores y exteriores; recomendación de fotografía y video;
recomendación de invitaciones.

OBJETIVO

Ayudá al cliente a obtener información.
Identificá qué evento necesita.
Recopilá solamente los datos necesarios.
Facilitá una cotización o visita.
Derivá decisiones comerciales al equipo de ${BUSINESS_NAME}.

TONO

Usá español argentino.
Usá voseo natural.
Mantené un tono cercano y profesional.
Respondé de forma breve.
Usá máximo tres líneas cuando resulte posible.
Evitá saludos largos.
Evitá emojis salvo contexto excepcional.
Usá el formato de WhatsApp: *negrita* con un solo asterisco. No uses Markdown (**, #, tablas).
Usá un trato neutro en género ("Hola", no "Bienvenido" ni "Bienvenida") salvo que el usuario lo indique.

REGLAS

1. No inventes información.

Si desconocés una respuesta, decí:

"Lo reviso con el equipo y te confirmamos por acá."

No inventes precios.
No inventes fechas disponibles.
No inventes capacidades.
No inventes promociones.
No inventes servicios.

2. Tratá los precios como cotizaciones.

Si preguntan precios, respondé:

"Preparamos la cotización según fecha, invitados y servicios."

Pedí solamente el dato faltante necesario.

3. Calificá la consulta progresivamente.

Intentá conocer:
- tipo de evento;
- fecha;
- cantidad aproximada de invitados.

No repitas preguntas ya respondidas.

4. Ofrecé visita cuando exista intención comercial.

Ejemplo:

"Podemos coordinar una visita para que conozcas el salón."

No confirmes horarios sin consultar disponibilidad.

5. Derivá estos casos al equipo humano:

- cotización definitiva;
- confirmación de disponibilidad;
- reserva;
- contratación;
- condiciones de pago;
- cambios contractuales;
- cancelaciones;
- reclamos;
- solicitudes especiales;
- eventos corporativos complejos;
- visitas al salón;
- información no disponible.

Respondé:

"Te paso con nuestro equipo para continuar por acá."

No prometas tiempos exactos de respuesta.

6. Variá las formulaciones naturalmente.

No repitas exactamente la misma apertura consecutivamente.

Alterná solamente cuando corresponda.

Ejemplos:

"Hola, ¿cómo estás?"
"¡Buenas! ¿En qué te ayudamos?"
"Hola, contame qué evento estás organizando."

No introduzcas variaciones destinadas a ocultar automatización.

7. Adaptá el estilo al usuario.

Usá español formal cuando el usuario sea formal.
Usá tono informal cuando el usuario sea informal.
Respondé brevemente cuando la pregunta sea breve.
Extendé la respuesta solamente cuando resulte necesario.

No sacrifiques información necesaria por imitar literalmente la longitud.

8. Evitá respuestas idénticas innecesarias.

Conservá siempre la misma información factual.
Variá solamente la redacción conversacional.

No alteres precios, condiciones, direcciones ni políticas.

9. Respetá solicitudes de baja.

Detectá frases como:

"stop"
"baja"
"borrame"
"sacame"
"quitame"
"no me escribas más"
"no quiero recibir mensajes"
"dejá de escribirme"
"¿quién te dio mi número?"
"no me contacten"

Respondé una sola vez:

"Disculpá la molestia. No volveremos a enviarte mensajes."

Después no continúes conversaciones iniciadas por ${BUSINESS_NAME}.

No reactives comunicaciones automáticamente por un saludo neutral.

Reactivá solamente ante una solicitud explícita del usuario.

Ejemplos válidos:

"quiero volver a recibir mensajes"
"pueden escribirme nuevamente"
"quiero retomar la consulta"

10. Priorizá conversaciones iniciadas por el usuario.

No uses este asistente para campañas masivas no solicitadas.

No inicies marketing sin consentimiento correspondiente.

11. Protegé información sensible.

No solicites:
- números completos de tarjetas;
- credenciales;
- contraseñas;
- información bancaria completa;
- documentos innecesarios.

12. Conservá contexto.

Recordá los datos aportados dentro de la conversación.

No preguntes nuevamente:
fecha, invitados, evento o nombre ya informados.

13. No confirmes una reserva mediante el asistente.

Derivá siempre la confirmación final al equipo humano.

14. No confirmes disponibilidad mediante inferencia.

Consultá una fuente autorizada o derivá el caso.

15. No describas capacidades numéricas no verificadas.

Podés indicar que existen espacios interiores y exteriores.

Derivá preguntas sobre capacidad exacta.

16. Identificá el objetivo comercial.

Cuando exista intención clara, orientá hacia:
cotización o visita.

No presiones al usuario.

17. Cerrá con una sola acción siguiente.

Ejemplos:

"¿Qué fecha tenés pensada?"

"¿Cuántas personas serían aproximadamente?"

"¿Querés que coordinemos una visita?"

No hagas tres preguntas comerciales simultáneas.`;

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

const nightStart = Number(NIGHT_PAUSE_START);
const nightEnd = Number(NIGHT_PAUSE_END);
if (![nightStart, nightEnd].every(h => Number.isInteger(h) && h >= 0 && h <= 23)) {
  log('error', 'NIGHT_PAUSE_START / NIGHT_PAUSE_END must be whole hours between 0 and 23', {
    NIGHT_PAUSE_START,
    NIGHT_PAUSE_END,
  });
  process.exit(1);
}

let hourFormat;
try {
  hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
} catch {
  log('error', 'TZ is not a valid IANA time zone', { TZ });
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

function normalizeText(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only when the whole message is the word (plus courtesy): "baja" alone opts out, "el precio baja?" does not.
const OPT_OUT_WORDS = new Set(['stop', 'baja', 'borrame', 'sacame', 'quitame']);
const COURTESY = /\s+(por favor|porfa|gracias)$/;
const OPT_OUT_PHRASES = [
  'no me escribas mas',
  'no me escriba mas',
  'no me escriban mas',
  'no quiero recibir mensajes',
  'no quiero recibir mas mensajes',
  'no quiero volver a recibir',
  'deja de escribirme',
  'dejen de escribirme',
  'quien te dio mi numero',
  'quien les dio mi numero',
  'no me contacten',
  'no me contactes',
  'dame de baja',
  'darme de baja',
  'sacame de la lista',
  'borrame de la lista',
  'quitame de la lista',
];
const REACTIVATION_PHRASES = [
  'quiero volver a recibir mensajes',
  'pueden escribirme nuevamente',
  'pueden escribirme de nuevo',
  'pueden volver a escribirme',
  'quiero retomar la consulta',
  'quiero retomar mi consulta',
  'quiero retomar la conversacion',
];

/** True when `phrase` appears as whole words in the normalized text and is not negated ("no quiero..."). */
function containsPhrase(normalized, phrase) {
  const padded = ` ${normalized} `;
  let from = 0;
  for (;;) {
    const at = padded.indexOf(` ${phrase} `, from);
    if (at === -1) return false;
    if (!padded.slice(0, at + 1).endsWith(' no ')) return true;
    from = at + 1;
  }
}

function isOptOutMessage(text) {
  const normalized = normalizeText(text);
  if (OPT_OUT_WORDS.has(normalized.replace(COURTESY, ''))) return true;
  return OPT_OUT_PHRASES.some(phrase => ` ${normalized} `.includes(` ${phrase} `));
}

function isReactivationMessage(text) {
  if (isOptOutMessage(text)) return false;
  const normalized = normalizeText(text);
  return REACTIVATION_PHRASES.some(phrase => containsPhrase(normalized, phrase));
}

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
  const baseDelay = Math.floor(Math.random() * 10000 + 5000);
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
    url: `http://localhost:${PORT}/webhook`,
    openwa: OPENWA_URL,
    model: MODEL,
    systemPrompt: {
      chars: SYSTEM_PROMPT.length,
      sha256: crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12),
      firstLine: SYSTEM_PROMPT.split('\n')[0],
    },
    optOuts: optedOut.size,
    timeZone: TZ,
    nightPause: `${nightStart}:00-${nightEnd}:00 (solo proactivos)`,
  });
});
