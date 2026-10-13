'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { httpError } = require('./errors');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAMES = ['homologacion', 'produccion'];
const NAME_TOKEN = /\{\{nombre\}\}/g;

const isValidId = id => typeof id === 'string' && ID_PATTERN.test(id);
const isNonEmpty = value => typeof value === 'string' && value.trim() !== '';
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isTimeZone(value) {
  if (!isNonEmpty(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Every problem in a company config, as { field, message } with dotted field paths. */
function validateCompany(company) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const c = company && typeof company === 'object' ? company : {};

  if (!isValidId(c.id)) fail('id', 'solo minúsculas, números y guiones (máx. 40)');

  const b = c.business || {};
  if (!isNonEmpty(b.name)) fail('business.name', 'obligatorio');
  for (const k of ['activity', 'intro', 'offer', 'address', 'email', 'whatsapp']) {
    if (typeof b[k] !== 'string') fail(`business.${k}`, 'debe ser texto');
  }
  if (isNonEmpty(b.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) fail('business.email', 'correo inválido');
  for (const k of ['events', 'services']) {
    if (!Array.isArray(b[k]) || !b[k].every(isNonEmpty)) fail(`business.${k}`, 'lista de textos no vacíos');
  }

  if (!isNonEmpty(get(c, 'prompt.rules'))) fail('prompt.rules', 'obligatorio');
  for (const k of ['fallback', 'optOutReply', 'handoffPhrase']) {
    if (!isNonEmpty(get(c, `messages.${k}`))) fail(`messages.${k}`, 'obligatorio');
  }

  const s = c.bridge || {};
  if (!isNonEmpty(s.model)) fail('bridge.model', 'obligatorio');
  if (!isInt(s.maxTokens, 1, 8192)) fail('bridge.maxTokens', 'entero entre 1 y 8192');
  if (!isInt(s.historyLimit, 1, 50)) fail('bridge.historyLimit', 'entero entre 1 y 50');
  if (!isInt(s.delayMinMs, 0, 600000)) fail('bridge.delayMinMs', 'entero entre 0 y 600000');
  if (!isInt(s.delayMaxMs, 0, 600000)) fail('bridge.delayMaxMs', 'entero entre 0 y 600000');
  else if (Number.isInteger(s.delayMinMs) && s.delayMinMs > s.delayMaxMs) {
    fail('bridge.delayMaxMs', 'debe ser mayor o igual al mínimo');
  }
  if (!isInt(s.chatMinIntervalMs, 0, 3600000)) fail('bridge.chatMinIntervalMs', 'entero entre 0 y 3600000');
  if (!isTimeZone(s.timeZone)) fail('bridge.timeZone', 'zona horaria IANA inválida');
  for (const k of ['nightPauseStart', 'nightPauseEnd']) {
    if (!isInt(s[k], 0, 23)) fail(`bridge.${k}`, 'hora entera entre 0 y 23');
  }

  for (const name of ENV_NAMES) {
    const e = get(c, `environments.${name}`) || {};
    for (const k of ['openwaUrl', 'webhookUrl']) {
      if (typeof e[k] !== 'string') fail(`environments.${name}.${k}`, 'debe ser texto');
      else if (e[k] !== '' && !isHttpUrl(e[k])) fail(`environments.${name}.${k}`, 'URL http(s) inválida');
    }
    if (typeof e.sessionId !== 'string') fail(`environments.${name}.sessionId`, 'debe ser texto');
    if (!isInt(e.port, 1, 65535)) fail(`environments.${name}.port`, 'puerto entre 1 y 65535');
  }
  return errors;
}

/** Dotted paths of the given environment fields that are still empty. */
function missingEnvFields(company, envName, fields) {
  return fields
    .filter(k => !isNonEmpty(get(company, `environments.${envName}.${k}`)))
    .map(k => `environments.${envName}.${k}`);
}

const lowerFirst = text => text.charAt(0).toLocaleLowerCase('es') + text.slice(1);

/** The system prompt: presentation, business data block, then the editable rules. */
function buildSystemPrompt(company) {
  const b = company.business || {};
  const name = b.name || '';
  const fill = text => String(text || '').replace(NAME_TOKEN, name);
  const services = (b.services || []).map(lowerFirst).join('; ');
  const data = [
    b.activity,
    b.address && `Dirección: ${b.address}`,
    b.email && `Correo: ${b.email}`,
    b.whatsapp && `WhatsApp: ${b.whatsapp}`,
    services && `Servicios confirmados: ${services}.`,
  ].filter(Boolean);
  return [
    `Sos el asistente de WhatsApp de ${name}.`,
    fill(b.intro),
    fill(b.offer),
    data.length ? ['DATOS DEL NEGOCIO (podés compartirlos tal cual)', '', ...data].join('\n') : '',
    fill(company.prompt && company.prompt.rules),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function promptInfo(prompt) {
  return { chars: prompt.length, sha256: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12) };
}

/** Reads and validates a company.json; throws with `.errors` listing every invalid field. */
function loadCompany(file) {
  let company;
  try {
    company = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw httpError(400, `no se pudo leer ${file}: ${err.message}`, { errors: [] });
  }
  const errors = validateCompany(company);
  if (errors.length) throw httpError(400, `${file} tiene errores`, { errors });
  return company;
}

module.exports = {
  ENV_NAMES,
  isValidId,
  validateCompany,
  missingEnvFields,
  buildSystemPrompt,
  promptInfo,
  loadCompany,
};
