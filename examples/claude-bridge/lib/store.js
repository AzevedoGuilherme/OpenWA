'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { isValidId, validateCompany, missingEnvFields } = require('./company');
const { httpError } = require('./errors');
const { writeFileAtomic } = require('./fsutil');

const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENWA_API_KEY', 'OPENWA_WEBHOOK_SECRET'];
// No spaces, quotes or '#': keeps the .env file unambiguous without quoting.
const SECRET_VALUE = /^[A-Za-z0-9_\-.:+/=]+$/;
const ENV_FIELDS = ['openwaUrl', 'sessionId', 'webhookUrl'];
const FIRST_PORT = 3001;

const DEFAULT_MESSAGES = {
  fallback: 'Disculpá, estamos con un problema técnico. Te respondemos en un ratito.',
  optOutReply: 'Disculpá la molestia. No volveremos a enviarte mensajes.',
  handoffPhrase: 'te paso con nuestro equipo',
};
const DEFAULT_BRIDGE = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 500,
  historyLimit: 12,
  delayMinMs: 5000,
  delayMaxMs: 15000,
  chatMinIntervalMs: 30000,
  timeZone: 'America/Argentina/Buenos_Aires',
  nightPauseStart: 22,
  nightPauseEnd: 8,
};

const toJson = value => `${JSON.stringify(value, null, 2)}\n`;
const mask = value => (!value ? '' : value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-2)}`);

function blankCompany() {
  return {
    business: {
      name: '',
      activity: '',
      intro: '',
      offer: '',
      events: [],
      services: [],
      address: '',
      email: '',
      whatsapp: '',
    },
    prompt: { rules: fs.readFileSync(path.join(__dirname, 'default-rules.txt'), 'utf8') },
    messages: { ...DEFAULT_MESSAGES },
    bridge: { ...DEFAULT_BRIDGE },
  };
}

function createStore(rootDir) {
  const companiesDir = path.join(rootDir, 'companies');

  const dirOf = id => {
    if (!isValidId(id)) throw httpError(400, `id de empresa inválido "${id}"`);
    return path.join(companiesDir, id);
  };
  const fileOf = id => path.join(dirOf(id), 'company.json');
  const secretsFileOf = id => path.join(dirOf(id), '.env.homologacion');

  function ids() {
    if (!fs.existsSync(companiesDir)) return [];
    return fs
      .readdirSync(companiesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && isValidId(d.name) && fs.existsSync(path.join(companiesDir, d.name, 'company.json')))
      .map(d => d.name)
      .sort();
  }

  function read(id) {
    const file = fileOf(id);
    if (!fs.existsSync(file)) throw httpError(404, `no existe la empresa "${id}"`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function safeRead(id) {
    try {
      return read(id);
    } catch {
      return null;
    }
  }

  function rawSecrets(id) {
    const file = secretsFileOf(id);
    const parsed = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
    return Object.fromEntries(SECRET_KEYS.map(k => [k, parsed[k] || '']));
  }

  function list() {
    return ids().map(id => {
      try {
        const company = read(id);
        const secrets = rawSecrets(id);
        return {
          id,
          name: (company.business && company.business.name) || id,
          valid: validateCompany(company).length === 0,
          environments: {
            homologacion: {
              missing: [...missingEnvFields(company, 'homologacion', ENV_FIELDS), ...SECRET_KEYS.filter(k => !secrets[k])],
            },
            produccion: { missing: missingEnvFields(company, 'produccion', ENV_FIELDS) },
          },
        };
      } catch (err) {
        const missing = ['company.json'];
        return {
          id,
          name: id,
          valid: false,
          error: err.message,
          environments: { homologacion: { missing }, produccion: { missing } },
        };
      }
    });
  }

  function write(id, company) {
    if (!company || company.id !== id) {
      throw httpError(400, 'el id del cuerpo no coincide con la URL', {
        errors: [{ field: 'id', message: 'no coincide con la URL' }],
      });
    }
    read(id);
    const errors = validateCompany(company);
    const port = company.environments && company.environments.homologacion && company.environments.homologacion.port;
    const clash = ids().find(other => {
      const c = other !== id && safeRead(other);
      return c && c.environments && c.environments.homologacion && c.environments.homologacion.port === port;
    });
    if (clash) errors.push({ field: 'environments.homologacion.port', message: `ya lo usa la empresa "${clash}"` });
    if (errors.length) throw httpError(400, 'la configuración tiene errores', { errors });
    writeFileAtomic(fileOf(id), toJson(company));
    return company;
  }

  function create(id, copyFrom) {
    const dir = dirOf(id);
    if (fs.existsSync(dir)) throw httpError(409, `ya existe la empresa "${id}"`);
    const base = copyFrom ? read(copyFrom) : blankCompany();
    const used = ids()
      .map(other => safeRead(other))
      .map(c => c && c.environments && c.environments.homologacion && c.environments.homologacion.port);
    let port = FIRST_PORT;
    while (used.includes(port)) port++;
    const baseUrl = base.environments && base.environments.homologacion && base.environments.homologacion.openwaUrl;
    const company = {
      ...base,
      id,
      environments: {
        homologacion: {
          openwaUrl: baseUrl || 'http://localhost:2785',
          sessionId: '',
          port,
          webhookUrl: `http://host.docker.internal:${port}/webhook`,
        },
        produccion: { openwaUrl: '', sessionId: '', port: 3001, webhookUrl: '' },
      },
    };
    writeFileAtomic(fileOf(id), toJson(company));
    return company;
  }

  function remove(id) {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) throw httpError(404, `no existe la empresa "${id}"`);
    const target = path.join(companiesDir, '.trash', `${id}-${Date.now()}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(dir, target);
    return target;
  }

  function readSecrets(id, reveal) {
    read(id);
    const raw = rawSecrets(id);
    return Object.fromEntries(SECRET_KEYS.map(k => [k, { set: Boolean(raw[k]), value: reveal ? raw[k] : mask(raw[k]) }]));
  }

  function writeSecrets(id, input) {
    read(id);
    const next = rawSecrets(id);
    const errors = [];
    for (const [key, value] of Object.entries(input || {})) {
      const field = `secrets.${key}`;
      if (!SECRET_KEYS.includes(key)) errors.push({ field, message: 'clave desconocida' });
      else if (value === undefined || value === null || value === '') continue;
      else if (typeof value !== 'string' || !SECRET_VALUE.test(value)) {
        errors.push({ field, message: 'sin espacios, comillas ni #' });
      } else if (key === 'OPENWA_WEBHOOK_SECRET' && (value.length < 16 || value.length > 255)) {
        errors.push({ field, message: 'entre 16 y 255 caracteres' });
      } else next[key] = value;
    }
    if (errors.length) throw httpError(400, 'las claves tienen errores', { errors });
    const lines = [
      '# Claves de homologación: las escribe el dashboard y no se suben a git.',
      ...SECRET_KEYS.map(k => `${k}=${next[k]}`),
    ];
    writeFileAtomic(secretsFileOf(id), `${lines.join('\n')}\n`);
    return readSecrets(id, false);
  }

  return { list, read, write, create, remove, readSecrets, writeSecrets, rawSecrets };
}

module.exports = { SECRET_KEYS, createStore };
