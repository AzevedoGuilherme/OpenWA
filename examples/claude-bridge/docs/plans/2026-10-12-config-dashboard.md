# Multi-company Config Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one operator configure several companies for the WhatsApp ↔ Claude bridge from a local dashboard, test each in *homologación*, and export a Docker package for *producción*.

**Architecture:** Each company is a folder `companies/<id>/` with a secret-free `company.json` and a git-ignored `.env.homologacion`. The bridge stops hard-coding rocaBianca and loads one company per process (`--company/--env`, or `COMPANY_CONFIG` in Docker, or the old defaults). A small Express dashboard on `127.0.0.1:3100` reads/writes those files, talks to OpenWA with the homologación keys, and writes `dist/<id>/` packages.

**Tech Stack:** Node.js (CommonJS, existing deps only: express 5, dotenv, @anthropic-ai/sdk), `node:test` for tests, vanilla HTML/CSS/JS for the UI (no build step).

**Spec:** `examples/claude-bridge/docs/specs/2026-10-12-config-dashboard-design.md`

## Global Constraints

- All paths below are relative to `examples/claude-bridge/` unless they start with `/`.
- No new npm dependencies. Tests use `node:test` + `node:assert/strict`; run with `npm test` (`node --test`).
- Node `>=18.11` (package `engines`); the Docker image uses `node:22-alpine`.
- Company ids match `^[a-z0-9][a-z0-9-]{0,39}$`; anything else is rejected before touching disk.
- Environments are exactly `homologacion` and `produccion`.
- Secrets are exactly `ANTHROPIC_API_KEY`, `OPENWA_API_KEY`, `OPENWA_WEBHOOK_SECRET`; never stored in `company.json`, never written for producción, never logged. Webhook secret length 16–255.
- Dashboard listens only on `127.0.0.1:3100` and rejects any `Host` header other than `127.0.0.1:3100` / `localhost:3100`.
- `npm start` / `npm run dev` with no arguments keep running rocaBianca with the folder's `.env`, as today.
- The rocaBianca prompt after migration equals today's prompt (5143 chars, sha256 `f08792f53415`) except the services line, which becomes one line.
- File writes for config, secrets and opt-outs are atomic (write `.tmp`, then rename).
- Code style: match `bridge.js` — 2-space indent, single quotes, semicolons, `'use strict'`, lines ≤ 120 chars.
- UI copy is in Spanish (rioplatense, voseo); code identifiers and code comments in English.

---

### Task 1: Extract opt-out detection into `lib/optout.js` with permanent tests

**Files:**
- Create: `lib/optout.js`
- Create: `test/optout.test.js`
- Modify: `bridge.js` (remove the opt-out helper block, require the module)
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `require('./lib/optout')` → `{ normalizeText(text: string): string, isOptOutMessage(text: string): boolean, isReactivationMessage(text: string): boolean }`

- [ ] **Step 1: Add the test script**

In `package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "dev": "node --watch bridge.js",
    "start": "node bridge.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test** — `test/optout.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOptOutMessage, isReactivationMessage } = require('../lib/optout');

// [message, is an opt-out, is a reactivation]
const cases = [
  ['No me escriban más.', true, false],
  ['BAJA', true, false],
  ['baja por favor', true, false],
  ['Stop!', true, false],
  ['¿Quién te dio mi número?', true, false],
  ['Dejá de escribirme', true, false],
  ['quiero darme de alta', false, false],
  ['alta', false, false],
  ['¿El precio baja si somos menos?', false, false],
  ['quiero dar de baja la reserva', false, false],
  ['Hola', false, false],
  ['Hola, quiero información para unos 15.', false, false],
  ['Quiero retomar mi consulta y recibir mensajes.', false, true],
  ['Quiero volver a recibir mensajes', false, true],
  ['No quiero volver a recibir mensajes', true, false],
  ['pueden escribirme nuevamente', false, true],
];

for (const [text, optOut, reactivation] of cases) {
  test(`opt-out detection: ${JSON.stringify(text)}`, () => {
    assert.equal(isOptOutMessage(text), optOut);
    assert.equal(isReactivationMessage(text), reactivation);
  });
}
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test test/optout.test.js`
Expected: FAIL — `Cannot find module '../lib/optout'`.

- [ ] **Step 4: Create `lib/optout.js`** (code moved verbatim from `bridge.js`, plus exports)

```js
'use strict';

function normalizeText(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

module.exports = { normalizeText, isOptOutMessage, isReactivationMessage };
```

- [ ] **Step 5: Use it from `bridge.js`**

In `bridge.js`, delete everything from the line `function normalizeText(text) {` through the closing `}` of `function isReactivationMessage(text) { … }` (the `// ---------- opt-out ----------` header stays, followed directly by the `// Persisted so an opt-out survives restarts…` comment). Then add after the `const Anthropic = require('@anthropic-ai/sdk');` line:

```js
const { normalizeText, isOptOutMessage, isReactivationMessage } = require('./lib/optout');
```

- [ ] **Step 6: Run the tests and a syntax check**

Run: `npm test && node --check bridge.js`
Expected: 16 tests pass, `node --check` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add lib/optout.js test/optout.test.js bridge.js package.json
git commit -m "refactor(examples): move opt-out detection to lib/optout with tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Company model — migrate rocaBianca to `company.json` and build the prompt from it

**Files:**
- Create (generated once): `companies/rocabianca/company.json`, `lib/default-rules.txt`, `test/fixtures/rocabianca-prompt-v1.txt`
- Create: `lib/errors.js`, `lib/company.js`
- Create: `test/company.test.js`

**Interfaces:**
- Produces `lib/errors.js`: `httpError(status: number, message: string, extra?: object): Error` — returns an `Error` with `.status` and any `extra` fields (e.g. `.errors`).
- Produces `lib/company.js`:
  - `ENV_NAMES: ['homologacion', 'produccion']`
  - `isValidId(id: unknown): boolean`
  - `validateCompany(company: object): Array<{ field: string, message: string }>` (dotted field paths)
  - `missingEnvFields(company, envName: string, fields: string[]): string[]` (dotted paths of empty fields)
  - `buildSystemPrompt(company): string`
  - `promptInfo(prompt: string): { chars: number, sha256: string }` (sha256 = first 12 hex chars)
  - `loadCompany(file: string): object` — throws `httpError(400, …, { errors })` on unreadable or invalid files.

- [ ] **Step 1: Generate the rocaBianca files from today's `bridge.js`** (one-off script, not committed)

Run from `examples/claude-bridge/`:

```bash
node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const src = fs.readFileSync('bridge.js', 'utf8');
const name = src.match(/const BUSINESS_NAME = '([^']+)';/)[1];
const prompt = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1].split('${BUSINESS_NAME}').join(name);
const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);
if (hash !== 'f08792f53415') throw new Error(`unexpected current prompt ${hash}`);
const paragraphs = prompt.split('\n\n');
const toToken = text => text.split(name).join('{{nombre}}');
const rules = toToken(prompt.slice(prompt.indexOf('OBJETIVO')));
const company = {
  id: 'rocabianca',
  business: {
    name,
    activity: 'Salón y producción de eventos en Córdoba, Argentina.',
    intro: toToken(paragraphs[1]),
    offer: paragraphs[2],
    events: ['Bodas', 'Fiestas de 15 años', 'Cumpleaños', 'Eventos corporativos', 'Eventos'],
    services: [
      'Decoración floral',
      'Catering y decoración',
      'Entretenimiento',
      'Espacios interiores y exteriores',
      'Recomendación de fotografía y video',
      'Recomendación de invitaciones',
    ],
    address: "Bernardo O'Higgins 8500, X5014 Córdoba, Argentina.",
    email: 'eventos@rocabianca.com.ar',
    whatsapp: '+54 351 706 2763',
  },
  prompt: { rules },
  messages: {
    fallback: 'Disculpá, estamos con un problema técnico. Te respondemos en un ratito.',
    optOutReply: 'Disculpá la molestia. No volveremos a enviarte mensajes.',
    handoffPhrase: 'te paso con nuestro equipo',
  },
  bridge: {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 500,
    historyLimit: 12,
    delayMinMs: 5000,
    delayMaxMs: 15000,
    chatMinIntervalMs: 30000,
    timeZone: 'America/Argentina/Buenos_Aires',
    nightPauseStart: 22,
    nightPauseEnd: 8,
  },
  environments: {
    homologacion: {
      openwaUrl: 'http://localhost:2785',
      sessionId: '47568f50-1352-4354-a322-88b294dd97b2',
      port: 3001,
      webhookUrl: 'http://host.docker.internal:3001/webhook',
    },
    produccion: { openwaUrl: '', sessionId: '', port: 3001, webhookUrl: '' },
  },
};
fs.mkdirSync('companies/rocabianca', { recursive: true });
fs.mkdirSync('test/fixtures', { recursive: true });
fs.writeFileSync('companies/rocabianca/company.json', `${JSON.stringify(company, null, 2)}\n`);
fs.writeFileSync('lib/default-rules.txt', rules);
fs.writeFileSync('test/fixtures/rocabianca-prompt-v1.txt', prompt);
console.log('ok', hash, prompt.length);
EOF
```

Expected output: `ok f08792f53415 5143`

- [ ] **Step 2: Write the failing test** — `test/company.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isValidId,
  validateCompany,
  missingEnvFields,
  buildSystemPrompt,
  promptInfo,
  loadCompany,
} = require('../lib/company');

const ROOT = path.join(__dirname, '..');
const rocabianca = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'companies', 'rocabianca', 'company.json'), 'utf8'));
const fieldsOf = company => validateCompany(company).map(e => e.field).sort();

test('rocaBianca prompt equals the pre-migration prompt except the joined services line', () => {
  const before = fs.readFileSync(path.join(__dirname, 'fixtures', 'rocabianca-prompt-v1.txt'), 'utf8');
  const expected = before
    .replace('entretenimiento;\nespacios', 'entretenimiento; espacios')
    .replace('video;\nrecomendación', 'video; recomendación');
  assert.notEqual(expected, before);
  const prompt = buildSystemPrompt(rocabianca());
  assert.equal(prompt, expected);
  assert.equal(promptInfo(prompt).chars, 5143);
});

test('rocaBianca company.json is valid', () => {
  assert.deepEqual(validateCompany(rocabianca()), []);
});

test('rejects the usual mistakes, one error per field', () => {
  const c = rocabianca();
  c.id = '../evil';
  c.bridge.nightPauseStart = 25;
  c.bridge.timeZone = 'Mars/Olympus';
  c.bridge.delayMinMs = 20000;
  c.environments.produccion.webhookUrl = 'ftp://example.com/hook';
  c.business.email = 'not-an-email';
  assert.deepEqual(fieldsOf(c), [
    'bridge.delayMaxMs',
    'bridge.nightPauseStart',
    'bridge.timeZone',
    'business.email',
    'environments.produccion.webhookUrl',
    'id',
  ]);
});

test('requires name, rules and messages', () => {
  const c = rocabianca();
  c.business.name = ' ';
  c.prompt.rules = '';
  c.messages.fallback = '';
  assert.deepEqual(fieldsOf(c), ['business.name', 'messages.fallback', 'prompt.rules']);
});

test('{{nombre}} in intro and rules becomes the business name', () => {
  const c = rocabianca();
  c.business.name = 'Salón Aurora';
  const prompt = buildSystemPrompt(c);
  assert.match(prompt, /^Sos el asistente de WhatsApp de Salón Aurora\./);
  assert.match(prompt, /Salón Aurora organiza bodas/);
  assert.doesNotMatch(prompt, /\{\{nombre\}\}|rocaBianca/);
});

test('empty business data lines are left out of the prompt', () => {
  const c = rocabianca();
  Object.assign(c.business, { activity: '', address: '', email: '', whatsapp: '', services: [] });
  assert.doesNotMatch(buildSystemPrompt(c), /DATOS DEL NEGOCIO/);
});

test('missingEnvFields lists the empty production fields', () => {
  assert.deepEqual(missingEnvFields(rocabianca(), 'produccion', ['openwaUrl', 'sessionId', 'webhookUrl']), [
    'environments.produccion.openwaUrl',
    'environments.produccion.sessionId',
    'environments.produccion.webhookUrl',
  ]);
  assert.deepEqual(missingEnvFields(rocabianca(), 'homologacion', ['openwaUrl', 'sessionId', 'webhookUrl']), []);
});

test('isValidId', () => {
  for (const ok of ['rocabianca', 'salon-2', 'a']) assert.equal(isValidId(ok), true, ok);
  for (const bad of ['', 'Roca', '-x', '../x', 'a b', 'x'.repeat(41), undefined]) assert.equal(isValidId(bad), false, bad);
});

test('loadCompany throws with every invalid field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-'));
  const file = path.join(dir, 'company.json');
  const c = rocabianca();
  c.bridge.maxTokens = 0;
  fs.writeFileSync(file, JSON.stringify(c));
  assert.throws(() => loadCompany(file), err => err.status === 400 && err.errors[0].field === 'bridge.maxTokens');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadCompany(file), /no se pudo leer/);
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test test/company.test.js`
Expected: FAIL — `Cannot find module '../lib/company'`.

- [ ] **Step 4: Create `lib/errors.js`**

```js
'use strict';

/** An Error carrying the HTTP status the dashboard should answer with, plus optional details. */
function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

module.exports = { httpError };
```

- [ ] **Step 5: Create `lib/company.js`**

```js
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
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: all tests in `test/optout.test.js` and `test/company.test.js` pass.

- [ ] **Step 7: Commit**

```bash
git add lib/errors.js lib/company.js lib/default-rules.txt companies/rocabianca/company.json test/company.test.js test/fixtures/rocabianca-prompt-v1.txt
git commit -m "feat(examples): describe each company in company.json and build its prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bridge loads a company and environment

**Files:**
- Create: `lib/runtime.js`, `test/runtime.test.js`
- Modify: `bridge.js` (top of file through the config check; delay, opt-out file, startup log)

**Interfaces:**
- Consumes: `loadCompany`, `buildSystemPrompt`, `promptInfo`, `ENV_NAMES`, `isValidId` (Task 2); `normalizeText`, `isOptOutMessage`, `isReactivationMessage` (Task 1).
- Produces `lib/runtime.js`:
  - `resolveRuntime(argv: string[], env: object, baseDir: string): { companyFile: string, envName: string, envFile: string|null, dataDirOverride: string|null }` — throws `Error` on an unknown env or invalid id.
  - `migrateLegacyOptOuts(baseDir: string, companyId: string, dataDir: string): boolean`
  - `DEFAULT_COMPANY = 'rocabianca'`

- [ ] **Step 1: Write the failing test** — `test/runtime.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRuntime, migrateLegacyOptOuts } = require('../lib/runtime');

const BASE = path.resolve('/srv/bridge');

test('no arguments: rocaBianca with the folder .env (today\'s behaviour)', () => {
  assert.deepEqual(resolveRuntime([], {}, BASE), {
    companyFile: path.join(BASE, 'companies', 'rocabianca', 'company.json'),
    envName: 'homologacion',
    envFile: path.join(BASE, '.env'),
    dataDirOverride: null,
  });
});

test('--company and --env pick the company folder and its env file', () => {
  const rt = resolveRuntime(['--company', 'salon-2', '--env=produccion'], {}, BASE);
  assert.equal(rt.companyFile, path.join(BASE, 'companies', 'salon-2', 'company.json'));
  assert.equal(rt.envName, 'produccion');
  assert.equal(rt.envFile, path.join(BASE, 'companies', 'salon-2', '.env.produccion'));
});

test('COMPANY_CONFIG + COMPANY_ENV + DATA_DIR (Docker)', () => {
  const rt = resolveRuntime([], { COMPANY_CONFIG: '/app/company.json', COMPANY_ENV: 'produccion', DATA_DIR: '/app/data' }, BASE);
  assert.equal(rt.companyFile, path.resolve(BASE, '/app/company.json'));
  assert.equal(rt.envName, 'produccion');
  assert.equal(rt.envFile, null);
  assert.equal(rt.dataDirOverride, path.resolve(BASE, '/app/data'));
});

test('rejects an unknown environment, an invalid id and a missing id', () => {
  assert.throws(() => resolveRuntime(['--env', 'staging'], {}, BASE), /entorno desconocido/);
  assert.throws(() => resolveRuntime(['--company', '../x'], {}, BASE), /id de empresa inválido/);
  assert.throws(() => resolveRuntime(['--company'], {}, BASE), /id de empresa inválido/);
});

test('migrateLegacyOptOuts moves data/optouts.json into data/rocabianca once', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
  fs.mkdirSync(path.join(base, 'data'));
  fs.writeFileSync(path.join(base, 'data', 'optouts.json'), '{"a@c.us":{}}');
  const target = path.join(base, 'data', 'rocabianca');
  assert.equal(migrateLegacyOptOuts(base, 'otra', path.join(base, 'data', 'otra')), false);
  assert.equal(migrateLegacyOptOuts(base, 'rocabianca', target), true);
  assert.equal(fs.readFileSync(path.join(target, 'optouts.json'), 'utf8'), '{"a@c.us":{}}');
  assert.equal(fs.existsSync(path.join(base, 'data', 'optouts.json')), false);
  assert.equal(migrateLegacyOptOuts(base, 'rocabianca', target), false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `Cannot find module '../lib/runtime'`.

- [ ] **Step 3: Create `lib/runtime.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ENV_NAMES, isValidId } = require('./company');

const DEFAULT_COMPANY = 'rocabianca';

/** `--name value` or `--name=value`; '' when the flag is there without a value, undefined when absent. */
function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1] ?? '';
  const inline = argv.find(a => a.startsWith(`--${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 3);
}

/**
 * Which company and environment this bridge runs, and where its files are: --company/--env first,
 * then COMPANY_CONFIG/COMPANY_ENV (Docker), then rocaBianca with the folder's .env.
 */
function resolveRuntime(argv, env, baseDir) {
  const companyId = argValue(argv, 'company');
  const envName = argValue(argv, 'env') || env.COMPANY_ENV || 'homologacion';
  if (!ENV_NAMES.includes(envName)) {
    throw new Error(`entorno desconocido "${envName}" (usá ${ENV_NAMES.join(' o ')})`);
  }
  const dataDirOverride = env.DATA_DIR ? path.resolve(baseDir, env.DATA_DIR) : null;

  if (companyId !== undefined) {
    if (!isValidId(companyId)) throw new Error(`id de empresa inválido "${companyId}"`);
    const dir = path.join(baseDir, 'companies', companyId);
    return {
      companyFile: path.join(dir, 'company.json'),
      envName,
      envFile: path.join(dir, `.env.${envName}`),
      dataDirOverride,
    };
  }
  if (env.COMPANY_CONFIG) {
    return { companyFile: path.resolve(baseDir, env.COMPANY_CONFIG), envName, envFile: null, dataDirOverride };
  }
  return {
    companyFile: path.join(baseDir, 'companies', DEFAULT_COMPANY, 'company.json'),
    envName,
    envFile: path.join(baseDir, '.env'),
    dataDirOverride,
  };
}

/** Moves the single-company data/optouts.json into rocaBianca's own folder, once, so no opt-out is lost. */
function migrateLegacyOptOuts(baseDir, companyId, dataDir) {
  const legacy = path.join(baseDir, 'data', 'optouts.json');
  const target = path.join(dataDir, 'optouts.json');
  if (companyId !== DEFAULT_COMPANY || legacy === target) return false;
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.renameSync(legacy, target);
  return true;
}

module.exports = { DEFAULT_COMPANY, resolveRuntime, migrateLegacyOptOuts };
```

- [ ] **Step 4: Run the runtime tests**

Run: `node --test test/runtime.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Replace the top of `bridge.js`**

Replace everything from line 1 down to (and including) the `hourFormat` try/catch block that ends just before `// maxRetries: 0 so the retry policy below is the only one in play.` with:

```js
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
```

(`ANTHROPIC_API_KEY` etc. keep their existing uses further down: `new Anthropic({ apiKey: ANTHROPIC_API_KEY, … })`, `'X-API-Key': OPENWA_API_KEY`, `verifySignature(…, OPENWA_WEBHOOK_SECRET)`.)

- [ ] **Step 6: Delay bounds from the company**

In `bridge.js`, replace the body of `calculateResponseDelay`:

```js
function calculateResponseDelay(text) {
  const { delayMinMs, delayMaxMs } = settings;
  const baseDelay = Math.floor(Math.random() * (delayMaxMs - delayMinMs) + delayMinMs);
  const extraBlocks = text.length > 200 ? Math.ceil((text.length - 200) / 100) : 0;
  return baseDelay + extraBlocks * 1000;
}
```

- [ ] **Step 7: Migrate the legacy opt-out file before loading it**

In `bridge.js`, replace the line `const optedOut = loadOptOuts();` with:

```js
if (!runtime.dataDirOverride && migrateLegacyOptOuts(__dirname, company.id, DATA_DIR)) {
  log('opt-out', 'moved data/optouts.json into the company folder', { file: OPT_OUT_FILE });
}
const optedOut = loadOptOuts();
```

- [ ] **Step 8: Startup log names the company and environment**

In `bridge.js`, replace the whole `app.listen(…)` call with:

```js
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
```

- [ ] **Step 9: Verify syntax, tests, and a real start with fake keys**

Run:

```bash
node --check bridge.js && npm test
ANTHROPIC_API_KEY=x OPENWA_API_KEY=x OPENWA_WEBHOOK_SECRET=0123456789abcdef PORT=3997 OPENWA_URL=http://127.0.0.1:1 DATA_DIR=/tmp/bridge-check node bridge.js & sleep 2; kill $!
```

Expected: tests pass; the bridge prints one `[webhook] … "bridge listening"` line with `"company":"rocabianca","env":"homologacion"` and `"systemPrompt":{"chars":5143,…}`. Then:

```bash
node bridge.js --company nope
```

Expected: `[error] {… "no se pudo leer …companies/nope/company.json …"}` and exit code 1.

- [ ] **Step 10: Commit**

```bash
git add lib/runtime.js test/runtime.test.js bridge.js
git commit -m "feat(examples): run the bridge for one company and environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Company store for the dashboard (files, secrets, validation)

**Files:**
- Create: `lib/fsutil.js`, `lib/store.js`
- Create: `test/helpers.js`, `test/store.test.js`

**Interfaces:**
- Consumes: `validateCompany`, `missingEnvFields`, `isValidId` (Task 2); `httpError` (Task 2).
- Produces `lib/fsutil.js`: `writeFileAtomic(file: string, content: string): void`
- Produces `lib/store.js`: `SECRET_KEYS` and `createStore(rootDir)` returning:
  - `list(): Array<{ id, name, valid: boolean, error?: string, environments: { homologacion: { missing: string[] }, produccion: { missing: string[] } } }>`
  - `read(id): company` (404 if missing)
  - `write(id, company): company` (400 with `.errors`, includes port clash)
  - `create(id, copyFrom?: string|null): company` (409 if exists; picks the next free homologación port from 3001)
  - `remove(id): string` (path it was moved to under `companies/.trash/`)
  - `readSecrets(id, reveal: boolean): { [KEY]: { set: boolean, value: string } }` (masked unless reveal)
  - `writeSecrets(id, partial: object): same as readSecrets(id, false)` (empty value keeps the stored one)
  - `rawSecrets(id): { [KEY]: string }` (for OpenWA calls; never sent to the browser)
- Produces `test/helpers.js`: `tempRoot(): string` — temp dir with `bridge.js`, `package.json`, `package-lock.json`, `lib/*`, `companies/rocabianca/company.json` copied in.

- [ ] **Step 1: Create `test/helpers.js`**

```js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COPY = ['bridge.js', 'package.json', 'package-lock.json', 'lib', path.join('companies', 'rocabianca', 'company.json')];

/** A throwaway copy of the bridge folder with only the rocaBianca company in it. */
function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-root-'));
  for (const item of COPY) fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  return dir;
}

module.exports = { ROOT, tempRoot };
```

- [ ] **Step 2: Write the failing test** — `test/store.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../lib/store');
const { tempRoot } = require('./helpers');

const setup = () => {
  const root = tempRoot();
  return { root, store: createStore(root) };
};

test('list reports what each environment still needs', () => {
  const { store } = setup();
  const [rb] = store.list();
  assert.equal(rb.id, 'rocabianca');
  assert.equal(rb.name, 'rocaBianca');
  assert.equal(rb.valid, true);
  assert.deepEqual(rb.environments.homologacion.missing, ['ANTHROPIC_API_KEY', 'OPENWA_API_KEY', 'OPENWA_WEBHOOK_SECRET']);
  assert.deepEqual(rb.environments.produccion.missing, [
    'environments.produccion.openwaUrl',
    'environments.produccion.sessionId',
    'environments.produccion.webhookUrl',
  ]);
});

test('rejects invalid ids before touching disk', () => {
  const { store } = setup();
  assert.throws(() => store.read('../etc'), err => err.status === 400);
  assert.throws(() => store.read('nope'), err => err.status === 404);
});

test('write validates and refuses a homologación port another company uses', () => {
  const { store } = setup();
  const other = store.create('salon-2', 'rocabianca');
  assert.equal(other.environments.homologacion.port, 3002);
  assert.equal(other.environments.homologacion.webhookUrl, 'http://host.docker.internal:3002/webhook');
  assert.equal(other.environments.homologacion.sessionId, '');
  other.environments.homologacion.port = 3001;
  other.bridge.nightPauseEnd = 30;
  assert.throws(
    () => store.write('salon-2', other),
    err =>
      err.status === 400 &&
      err.errors.map(e => e.field).sort().join() === 'bridge.nightPauseEnd,environments.homologacion.port',
  );
  other.environments.homologacion.port = 3002;
  other.bridge.nightPauseEnd = 8;
  other.business.name = 'Salón Dos';
  store.write('salon-2', other);
  assert.equal(store.read('salon-2').business.name, 'Salón Dos');
});

test('write refuses a body whose id differs from the URL', () => {
  const { store } = setup();
  assert.throws(() => store.write('rocabianca', { ...store.read('rocabianca'), id: 'otra' }), err => err.status === 400);
});

test('create a blank company uses the default rules; duplicates are refused', () => {
  const { store } = setup();
  const blank = store.create('nueva', null);
  assert.equal(blank.business.name, '');
  assert.match(blank.prompt.rules, /^OBJETIVO/);
  assert.match(blank.prompt.rules, /\{\{nombre\}\}/);
  assert.throws(() => store.create('nueva', null), err => err.status === 409);
});

test('remove moves the folder to companies/.trash', () => {
  const { root, store } = setup();
  store.create('borrar', null);
  const moved = store.remove('borrar');
  assert.equal(path.dirname(moved), path.join(root, 'companies', '.trash'));
  assert.ok(fs.existsSync(path.join(moved, 'company.json')));
  assert.deepEqual(store.list().map(c => c.id), ['rocabianca']);
});

test('secrets: masked by default, revealed on demand, empty keeps the stored value', () => {
  const { root, store } = setup();
  store.writeSecrets('rocabianca', {
    ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghij',
    OPENWA_API_KEY: 'owa_k1_secretvalue',
    OPENWA_WEBHOOK_SECRET: '0123456789abcdef0123',
  });
  const masked = store.readSecrets('rocabianca', false);
  assert.deepEqual(masked.ANTHROPIC_API_KEY, { set: true, value: 'sk-a••••ij' });
  store.writeSecrets('rocabianca', { ANTHROPIC_API_KEY: '', OPENWA_API_KEY: 'owa_new_value_1' });
  const revealed = store.readSecrets('rocabianca', true);
  assert.equal(revealed.ANTHROPIC_API_KEY.value, 'sk-ant-api03-abcdefghij');
  assert.equal(revealed.OPENWA_API_KEY.value, 'owa_new_value_1');
  assert.ok(fs.existsSync(path.join(root, 'companies', 'rocabianca', '.env.homologacion')));
  assert.deepEqual(store.list()[0].environments.homologacion.missing, []);
});

test('secrets: rejects short webhook secrets, odd characters and unknown keys', () => {
  const { store } = setup();
  assert.throws(
    () => store.writeSecrets('rocabianca', { OPENWA_WEBHOOK_SECRET: 'short', OPENWA_API_KEY: 'has space', FOO: 'x' }),
    err =>
      err.status === 400 &&
      err.errors.map(e => e.field).sort().join() === 'secrets.FOO,secrets.OPENWA_API_KEY,secrets.OPENWA_WEBHOOK_SECRET',
  );
});

test('list survives a broken company.json', () => {
  const { root, store } = setup();
  store.create('rota', null);
  fs.writeFileSync(path.join(root, 'companies', 'rota', 'company.json'), '{ broken');
  const rota = store.list().find(c => c.id === 'rota');
  assert.equal(rota.valid, false);
  assert.match(rota.error, /JSON/);
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../lib/store'`.

- [ ] **Step 4: Create `lib/fsutil.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
```

- [ ] **Step 5: Create `lib/store.js`**

```js
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
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: all tests pass (optout, company, runtime, store).

- [ ] **Step 7: Commit**

```bash
git add lib/fsutil.js lib/store.js test/helpers.js test/store.test.js
git commit -m "feat(examples): store companies and homologación keys for the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: OpenWA client (sessions and webhook)

**Files:**
- Create: `lib/openwa.js`, `test/openwa.test.js`

**Interfaces:**
- Consumes: `httpError` (Task 2).
- Produces `lib/openwa.js` (all async; `conn = { openwaUrl: string, apiKey: string }`; failures throw `httpError(502, message)`):
  - `listSessions(conn): Array<{ id, name, status, phone }>`
  - `findWebhook(conn, sessionId, webhookUrl): webhook|null`
  - `ensureWebhook(conn, { sessionId, webhookUrl, secret }): { created: boolean, id, events: string[], active: boolean }`
  - `testWebhook(conn, { sessionId, webhookId }): { success: boolean, statusCode?: number, error?: string }`

- [ ] **Step 1: Write the failing test** — `test/openwa.test.js`

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/openwa.test.js`
Expected: FAIL — `Cannot find module '../lib/openwa'`.

- [ ] **Step 3: Create `lib/openwa.js`**

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/openwa.js test/openwa.test.js
git commit -m "feat(examples): OpenWA client for sessions and webhook registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Export a company to a Docker package

**Files:**
- Create: `lib/export.js`, `test/export.test.js`

**Interfaces:**
- Consumes: `createStore`, `SECRET_KEYS` (Task 4); `validateCompany`, `missingEnvFields`, `buildSystemPrompt`, `promptInfo` (Task 2); `httpError`.
- Produces `lib/export.js`: `exportCompany({ rootDir: string, id: string, overwrite?: boolean }): { dir: string, warnings: string[], keptEnv: boolean }` — throws 400 (with `.errors`) when production data is missing, 409 when `dist/<id>` exists and `overwrite` is not `true`.

- [ ] **Step 1: Write the failing test** — `test/export.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { exportCompany } = require('../lib/export');
const { createStore } = require('../lib/store');
const { tempRoot } = require('./helpers');

function setup({ prod = true } = {}) {
  const root = tempRoot();
  const store = createStore(root);
  store.writeSecrets('rocabianca', {
    ANTHROPIC_API_KEY: 'sk-ant-homolog-key',
    OPENWA_API_KEY: 'owa_homolog_key',
    OPENWA_WEBHOOK_SECRET: '0123456789abcdef0123',
  });
  fs.mkdirSync(path.join(root, 'data', 'rocabianca'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'rocabianca', 'optouts.json'), '{"549@c.us":{}}');
  if (prod) {
    const c = store.read('rocabianca');
    c.environments.produccion = {
      openwaUrl: 'https://openwa.example.com',
      sessionId: 'prod-session',
      port: 3005,
      webhookUrl: 'https://bot.example.com/rocabianca/webhook',
    };
    store.write('rocabianca', c);
  }
  return { root, store };
}

const listFiles = dir =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath || e.path, e.name)).split(path.sep).join('/'))
    .sort();

test('blocks the export while production data is missing', () => {
  const { root } = setup({ prod: false });
  assert.throws(
    () => exportCompany({ rootDir: root, id: 'rocabianca' }),
    err =>
      err.status === 400 &&
      err.errors.map(e => e.field).join() ===
        'environments.produccion.openwaUrl,environments.produccion.sessionId,environments.produccion.webhookUrl',
  );
});

test('writes a self-contained package without any key or local data', () => {
  const { root } = setup();
  const result = exportCompany({ rootDir: root, id: 'rocabianca' });
  assert.equal(result.dir, path.join(root, 'dist', 'rocabianca'));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.keptEnv, false);
  assert.deepEqual(listFiles(result.dir), [
    '.env',
    'DEPLOY.md',
    'Dockerfile',
    'app/bridge.js',
    'app/lib/company.js',
    'app/lib/errors.js',
    'app/lib/optout.js',
    'app/lib/runtime.js',
    'app/package-lock.json',
    'app/package.json',
    'company.json',
    'docker-compose.yml',
  ]);
  const env = dotenv.parse(fs.readFileSync(path.join(result.dir, '.env')));
  assert.deepEqual(env, { COMPANY_ENV: 'produccion', ANTHROPIC_API_KEY: '', OPENWA_API_KEY: '', OPENWA_WEBHOOK_SECRET: '' });
  const everything = listFiles(result.dir).map(f => fs.readFileSync(path.join(result.dir, f), 'utf8')).join('\n');
  for (const secret of ['sk-ant-homolog-key', 'owa_homolog_key', '0123456789abcdef0123', '549@c.us']) {
    assert.ok(!everything.includes(secret), `package leaks ${secret}`);
  }
  const compose = fs.readFileSync(path.join(result.dir, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /"3005:3005"/);
  assert.match(compose, /COMPANY_CONFIG: \/app\/company\.json/);
  const deploy = fs.readFileSync(path.join(result.dir, 'DEPLOY.md'), 'utf8');
  assert.match(deploy, /https:\/\/openwa\.example\.com\/api\/sessions\/prod-session\/webhooks/);
  assert.match(deploy, /sha256/);
});

test('re-export needs confirmation, keeps a filled .env and the previous package', () => {
  const { root } = setup();
  const { dir } = exportCompany({ rootDir: root, id: 'rocabianca' });
  assert.throws(() => exportCompany({ rootDir: root, id: 'rocabianca' }), err => err.status === 409);
  const filled = 'COMPANY_ENV=produccion\nANTHROPIC_API_KEY=sk-prod\nOPENWA_API_KEY=owa_prod\nOPENWA_WEBHOOK_SECRET=prodsecret123456789\n';
  fs.writeFileSync(path.join(dir, '.env'), filled);
  const again = exportCompany({ rootDir: root, id: 'rocabianca', overwrite: true });
  assert.equal(again.keptEnv, true);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), filled);
  assert.ok(fs.existsSync(path.join(root, 'dist', 'rocabianca.prev', 'company.json')));
});

test('warns about plain http webhooks and a localhost OpenWA', () => {
  const { root, store } = setup();
  const c = store.read('rocabianca');
  c.environments.produccion.webhookUrl = 'http://bot.example.com/webhook';
  c.environments.produccion.openwaUrl = 'http://localhost:2785';
  store.write('rocabianca', c);
  const { warnings } = exportCompany({ rootDir: root, id: 'rocabianca' });
  assert.equal(warnings.length, 2);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/export.test.js`
Expected: FAIL — `Cannot find module '../lib/export'`.

- [ ] **Step 3: Create `lib/export.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { validateCompany, missingEnvFields, buildSystemPrompt, promptInfo } = require('./company');
const { createStore, SECRET_KEYS } = require('./store');
const { httpError } = require('./errors');

// Exactly what the bridge needs at runtime; nothing from the dashboard, tests or local data.
const APP_FILES = [
  'bridge.js',
  'package.json',
  'package-lock.json',
  'lib/company.js',
  'lib/errors.js',
  'lib/optout.js',
  'lib/runtime.js',
];

const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/ ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "bridge.js"]
`;

function isLocalHost(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function envTemplate(company) {
  return `# Producción de ${company.business.name}. Completá las tres claves antes de \`docker compose up -d\`.
# OPENWA_WEBHOOK_SECRET tiene que ser el mismo que registrás en el webhook de OpenWA (16 a 255 caracteres).
COMPANY_ENV=produccion
ANTHROPIC_API_KEY=
OPENWA_API_KEY=
OPENWA_WEBHOOK_SECRET=
`;
}

function composeFile(company) {
  const { port } = company.environments.produccion;
  return `services:
  bridge:
    build: .
    container_name: ${company.id}-bridge
    restart: unless-stopped
    env_file: .env
    environment:
      COMPANY_CONFIG: /app/company.json
      DATA_DIR: /app/data
    volumes:
      - ./company.json:/app/company.json:ro
      - data:/app/data
    ports:
      - "${port}:${port}"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:${port}/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  data:
`;
}

function deployGuide(company) {
  const prod = company.environments.produccion;
  const openwa = prod.openwaUrl.replace(/\/+$/, '');
  const { chars, sha256 } = promptInfo(buildSystemPrompt(company));
  return `# Despliegue de ${company.business.name} (${company.id})

1. Copiá esta carpeta al servidor.
2. Completá las tres claves en \`.env\`. Nunca subas ese archivo a git.
3. Levantá el bridge:

   \`\`\`bash
   docker compose up -d --build
   \`\`\`

4. Registrá el webhook en OpenWA (una sola vez), desde esta carpeta:

   \`\`\`bash
   set -a; . ./.env; set +a
   curl -X POST "${openwa}/api/sessions/${prod.sessionId}/webhooks" -H "Content-Type: application/json" -H "X-API-Key: $OPENWA_API_KEY" -d "{\\"url\\":\\"${prod.webhookUrl}\\",\\"events\\":[\\"message.received\\"],\\"secret\\":\\"$OPENWA_WEBHOOK_SECRET\\"}"
   \`\`\`

5. Revisá el arranque:

   \`\`\`bash
   docker compose logs bridge
   \`\`\`

   Tiene que aparecer \`bridge listening\` con \`"company":"${company.id}","env":"produccion"\` y
   \`"systemPrompt":{"chars":${chars},"sha256":"${sha256}"\`. Si el hash es otro, el contenedor no está usando
   este \`company.json\`.

## Notas

- El bridge escucha en el puerto ${prod.port}. Si el webhook cruza internet, ponelo detrás de un proxy inverso
  con HTTPS (${prod.webhookUrl}).
- Si OpenWA corre en el mismo servidor o en la misma red de Docker, agregá el host del bridge a
  \`SSRF_ALLOWED_HOSTS\` en OpenWA; si no, OpenWA rechaza el webhook.
- Las bajas se guardan en el volumen \`data\` (\`/app/data/optouts.json\`). Incluilo en tus backups.
- Para cambiar la configuración, reexportá desde el dashboard, reemplazá \`company.json\` y ejecutá
  \`docker compose restart bridge\`.
- OpenWA usa una integración no oficial de WhatsApp: nada de esto garantiza que el número no sea restringido.
`;
}

/** Writes dist/<id>/ for producción. Never copies keys, local data or other companies. */
function exportCompany({ rootDir, id, overwrite = false }) {
  const company = createStore(rootDir).read(id);
  const errors = [
    ...validateCompany(company),
    ...missingEnvFields(company, 'produccion', ['openwaUrl', 'sessionId', 'webhookUrl']).map(field => ({
      field,
      message: 'obligatorio para exportar',
    })),
  ];
  if (errors.length) throw httpError(400, 'la empresa todavía no se puede exportar', { errors });

  const prod = company.environments.produccion;
  const warnings = [];
  if (!prod.webhookUrl.startsWith('https://')) warnings.push('La URL del webhook de producción no usa https.');
  if (isLocalHost(prod.openwaUrl)) {
    warnings.push('La URL de OpenWA de producción apunta a localhost: dentro del contenedor eso es el propio contenedor.');
  }

  const dir = path.join(rootDir, 'dist', id);
  let keptEnv = null;
  if (fs.existsSync(dir)) {
    if (!overwrite) throw httpError(409, `ya existe dist/${id}; confirmá para reemplazarlo`);
    const prev = `${dir}.prev`;
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(dir, prev);
    const prevEnv = path.join(prev, '.env');
    if (fs.existsSync(prevEnv)) {
      const content = fs.readFileSync(prevEnv, 'utf8');
      const parsed = dotenv.parse(content);
      if (SECRET_KEYS.some(k => parsed[k])) keptEnv = content;
    }
  }

  for (const file of APP_FILES) {
    const target = path.join(dir, 'app', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(rootDir, file), target);
  }
  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
  write('company.json', `${JSON.stringify(company, null, 2)}\n`);
  write('.env', keptEnv || envTemplate(company));
  write('Dockerfile', DOCKERFILE);
  write('docker-compose.yml', composeFile(company));
  write('DEPLOY.md', deployGuide(company));
  return { dir, warnings, keptEnv: keptEnv !== null };
}

module.exports = { exportCompany };
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/export.js test/export.test.js
git commit -m "feat(examples): export a company as a Docker package for producción

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard HTTP API

**Files:**
- Create: `dashboard/server.js`, `test/dashboard.test.js`
- Modify: `package.json` (add `dashboard` script)

**Interfaces:**
- Consumes: `createStore` (Task 4), `exportCompany` (Task 6), `listSessions`/`findWebhook`/`ensureWebhook`/`testWebhook` (Task 5), `buildSystemPrompt`/`promptInfo` (Task 2), `httpError`.
- Produces: `require('./dashboard/server')` → `{ createApp({ rootDir: string, port: number }): express.Application }`; running the file directly listens on `127.0.0.1:3100`.
- HTTP contract used by the UI (Task 8). Errors are `{ error: string, errors?: [{ field, message }] }` with the error's status.
  - `GET /api/companies` → list (Task 4 `list()`)
  - `POST /api/companies` `{ id, copyFrom? }` → 201 company
  - `GET /api/companies/:id` → company
  - `PUT /api/companies/:id` company → `{ company, restart: string }`
  - `DELETE /api/companies/:id` → `{ trashedTo }`
  - `GET /api/companies/:id/secrets[?reveal=1]` → `{ KEY: { set, value } }`
  - `PUT /api/companies/:id/secrets` `{ KEY: value }` → masked secrets
  - `POST /api/companies/:id/prompt-preview` draft company → `{ prompt, chars, sha256 }` (POST, not GET as in the spec, so the preview shows unsaved edits)
  - `GET /api/companies/:id/openwa/sessions` → sessions
  - `POST /api/companies/:id/openwa/webhook` → `ensureWebhook` result
  - `POST /api/companies/:id/openwa/test` → `testWebhook` result (404 if not registered)
  - `POST /api/companies/:id/export` `{ overwrite? }` → `exportCompany` result

- [ ] **Step 1: Add the script** — in `package.json` `scripts`, add after `"start"`:

```json
    "dashboard": "node dashboard/server.js",
```

- [ ] **Step 2: Write the failing test** — `test/dashboard.test.js`

```js
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
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test test/dashboard.test.js`
Expected: FAIL — `Cannot find module '../dashboard/server'`.

- [ ] **Step 4: Create `dashboard/server.js`**

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.js test/dashboard.test.js package.json
git commit -m "feat(examples): dashboard API for companies, keys, OpenWA and export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard page

**Files:**
- Create: `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/styles.css`

**Interfaces:**
- Consumes: the HTTP contract of Task 7. Form fields bind to company paths through `data-path`; list fields use `data-type="list"` (one item per line), numbers `data-type="number"`; secret inputs use `data-secret="<KEY>"`.

- [ ] **Step 1: Create `dashboard/public/index.html`**

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bridge · Configuración</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header><h1>Bridge WhatsApp · Configuración</h1></header>
  <main>
    <section id="view-list">
      <div class="toolbar"><h2>Empresas</h2></div>
      <div id="company-cards" class="cards"></div>
      <form id="new-company" class="panel">
        <h3>Nueva empresa</h3>
        <div class="row">
          <label>ID <small>minúsculas, números y guiones</small>
            <input name="id" required pattern="[a-z0-9][a-z0-9\-]{0,39}" placeholder="mi-empresa"></label>
          <label>Partir de
            <select name="copyFrom"><option value="">Vacía (reglas por defecto)</option></select></label>
        </div>
        <button type="submit">Crear</button>
        <p class="status" id="new-status"></p>
      </form>
    </section>

    <section id="view-editor" hidden>
      <div class="toolbar">
        <button type="button" id="back" class="link">← Empresas</button>
        <h2 id="editor-title"></h2>
        <button type="button" id="delete" class="danger">Eliminar</button>
      </div>
      <nav class="tabs" id="tabs">
        <button type="button" data-tab="negocio">Negocio</button>
        <button type="button" data-tab="prompt">Prompt</button>
        <button type="button" data-tab="mensajes">Mensajes</button>
        <button type="button" data-tab="comportamiento">Comportamiento</button>
        <button type="button" data-tab="homologacion">Homologación</button>
        <button type="button" data-tab="produccion">Producción</button>
      </nav>

      <form id="editor" novalidate>
        <fieldset data-panel="negocio">
          <legend>Datos del negocio</legend>
          <div class="row">
            <label>Nombre <input data-path="business.name"></label>
            <label>WhatsApp publicado <input data-path="business.whatsapp"></label>
          </div>
          <label>Actividad <input data-path="business.activity"></label>
          <label>Presentación <small>Podés usar {{nombre}}; se reemplaza por el nombre.</small>
            <textarea rows="2" data-path="business.intro"></textarea></label>
          <label>Qué ofrece <textarea rows="2" data-path="business.offer"></textarea></label>
          <div class="row">
            <label>Eventos <small>Uno por línea.</small>
              <textarea rows="6" data-path="business.events" data-type="list"></textarea></label>
            <label>Servicios confirmados <small>Uno por línea.</small>
              <textarea rows="6" data-path="business.services" data-type="list"></textarea></label>
          </div>
          <div class="row">
            <label>Dirección <input data-path="business.address"></label>
            <label>Correo <input type="email" data-path="business.email"></label>
          </div>
        </fieldset>

        <fieldset data-panel="prompt" hidden>
          <legend>Reglas y tono</legend>
          <label>Reglas <small>Podés usar {{nombre}}. Los datos del negocio se agregan solos antes de las reglas.</small>
            <textarea rows="22" class="code" data-path="prompt.rules"></textarea></label>
          <div class="actions"><button type="button" class="secondary" id="preview-btn">Actualizar vista previa</button></div>
          <p class="hint" id="preview-info"></p>
          <label>Prompt final (solo lectura) <textarea rows="22" class="code" id="preview" readonly></textarea></label>
        </fieldset>

        <fieldset data-panel="mensajes" hidden>
          <legend>Mensajes fijos</legend>
          <label>Si Claude no responde <textarea rows="2" data-path="messages.fallback"></textarea></label>
          <label>Respuesta a un pedido de baja <textarea rows="2" data-path="messages.optOutReply"></textarea></label>
          <label>Frase de derivación <small>Cuando la respuesta la contiene, el bridge registra [handoff].</small>
            <input data-path="messages.handoffPhrase"></label>
        </fieldset>

        <fieldset data-panel="comportamiento" hidden>
          <legend>Comportamiento del bridge</legend>
          <div class="row">
            <label>Modelo <input data-path="bridge.model"></label>
            <label>Máx. tokens <input type="number" data-path="bridge.maxTokens" data-type="number"></label>
            <label>Mensajes de historial <input type="number" data-path="bridge.historyLimit" data-type="number"></label>
          </div>
          <div class="row">
            <label>Demora mínima (ms) <input type="number" data-path="bridge.delayMinMs" data-type="number"></label>
            <label>Demora máxima (ms) <input type="number" data-path="bridge.delayMaxMs" data-type="number"></label>
            <label>Intervalo por chat (ms) <input type="number" data-path="bridge.chatMinIntervalMs" data-type="number"></label>
          </div>
          <div class="row">
            <label>Zona horaria <input data-path="bridge.timeZone"></label>
            <label>Pausa nocturna desde (h) <input type="number" data-path="bridge.nightPauseStart" data-type="number"></label>
            <label>hasta (h) <input type="number" data-path="bridge.nightPauseEnd" data-type="number"></label>
          </div>
          <p class="hint">La pausa nocturna solo frena mensajes proactivos; las respuestas a clientes salen igual.</p>
        </fieldset>

        <fieldset data-panel="homologacion" hidden>
          <legend>Homologación (local)</legend>
          <div class="row">
            <label>URL de OpenWA <input data-path="environments.homologacion.openwaUrl"></label>
            <label>Puerto del bridge <input type="number" data-path="environments.homologacion.port" data-type="number"></label>
          </div>
          <label>URL del webhook <small>Con OpenWA en Docker: http://host.docker.internal:&lt;puerto&gt;/webhook</small>
            <input data-path="environments.homologacion.webhookUrl"></label>
          <label>Sesión de WhatsApp <select data-path="environments.homologacion.sessionId"></select></label>
          <h3>Claves <small class="hint">(se guardan solo en companies/&lt;id&gt;/.env.homologacion; vacío = no cambiar)</small></h3>
          <label>ANTHROPIC_API_KEY <input type="password" autocomplete="off" data-secret="ANTHROPIC_API_KEY"></label>
          <label>OPENWA_API_KEY <input type="password" autocomplete="off" data-secret="OPENWA_API_KEY"></label>
          <label>OPENWA_WEBHOOK_SECRET <input type="password" autocomplete="off" data-secret="OPENWA_WEBHOOK_SECRET"></label>
          <div class="actions">
            <button type="button" class="secondary" id="reveal">Ver claves</button>
            <button type="button" class="secondary" id="load-sessions">Probar conexión y cargar sesiones</button>
            <button type="button" class="secondary" id="register-webhook">Registrar webhook</button>
            <button type="button" class="secondary" id="send-test">Enviar evento de prueba</button>
          </div>
          <p class="hint">Las acciones usan la configuración guardada.</p>
          <pre class="result" id="homolog-result"></pre>
        </fieldset>

        <fieldset data-panel="produccion" hidden>
          <legend>Producción (VPS con Docker)</legend>
          <div class="row">
            <label>URL de OpenWA <input data-path="environments.produccion.openwaUrl"></label>
            <label>ID de sesión <input data-path="environments.produccion.sessionId"></label>
            <label>Puerto del bridge <input type="number" data-path="environments.produccion.port" data-type="number"></label>
          </div>
          <label>URL del webhook <input data-path="environments.produccion.webhookUrl"></label>
          <p class="hint">Las claves de producción no se guardan acá: el paquete trae un .env vacío que se completa en el servidor.</p>
          <div class="actions"><button type="button" id="export">Exportar a producción</button></div>
          <pre class="result" id="prod-result"></pre>
        </fieldset>
      </form>

      <footer class="savebar">
        <span class="status" id="save-status"></span>
        <button type="submit" form="editor">Guardar</button>
      </footer>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `dashboard/public/app.js`**

```js
'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENWA_API_KEY', 'OPENWA_WEBHOOK_SECRET'];

let current = null; // company as last loaded or saved
let dirty = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, errors: data.errors || [] });
  }
  return data;
}

const companyUrl = suffix => `/api/companies/${encodeURIComponent(current.id)}${suffix || ''}`;
const esc = text =>
  String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}
function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}
function setResult(el, text, kind = '') {
  el.textContent = text;
  el.className = `result ${kind}`;
}
const describe = err =>
  err.errors && err.errors.length ? `${err.message}: ${err.errors.map(e => `${e.field} (${e.message})`).join(', ')}` : err.message;

// ---------- company list ----------

function badge(label, missing) {
  const ok = missing.length === 0;
  const title = ok ? 'Completo' : `Falta: ${missing.join(', ')}`;
  return `<span class="badge ${ok ? 'ok' : 'warn'}" title="${esc(title)}">${label}: ${ok ? 'completo' : `faltan ${missing.length}`}</span>`;
}

function card(c) {
  return `<article class="card">
    <h3>${esc(c.name)}</h3>
    <p class="muted">${esc(c.id)}</p>
    ${c.error ? `<p class="error-msg">${esc(c.error)}</p>` : ''}
    <p>${c.valid ? '' : '<span class="badge warn">configuración inválida</span> '}
      ${badge('Homologación', c.environments.homologacion.missing)}
      ${badge('Producción', c.environments.produccion.missing)}</p>
    <button type="button" data-open="${esc(c.id)}">Editar</button>
  </article>`;
}

async function showList() {
  if (dirty && !confirm('Hay cambios sin guardar. ¿Salir igual?')) return;
  dirty = false;
  current = null;
  $('#view-editor').hidden = true;
  $('#view-list').hidden = false;
  history.replaceState(null, '', '#');
  const companies = await api('GET', '/api/companies');
  $('#company-cards').innerHTML = companies.length ? companies.map(card).join('') : '<p>No hay empresas todavía.</p>';
  $('#new-company [name=copyFrom]').innerHTML =
    '<option value="">Vacía (reglas por defecto)</option>' +
    companies.map(c => `<option value="${esc(c.id)}">Copiar de ${esc(c.name)}</option>`).join('');
}

$('#company-cards').addEventListener('click', e => {
  const id = e.target.dataset.open;
  if (id) openEditor(id).catch(err => alert(err.message));
});

$('#new-company').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const company = await api('POST', '/api/companies', {
      id: String(form.get('id')).trim(),
      copyFrom: form.get('copyFrom') || null,
    });
    e.target.reset();
    setStatus($('#new-status'), '');
    await openEditor(company.id);
  } catch (err) {
    setStatus($('#new-status'), describe(err), 'bad');
  }
});

// ---------- editor ----------

function setSelectValue(select, value) {
  if (![...select.options].some(o => o.value === value)) select.add(new Option(value || '(sin sesión)', value));
  select.value = value;
}

function fillForm(company) {
  for (const el of $$('#editor [data-path]')) {
    const value = getPath(company, el.dataset.path);
    if (el.dataset.type === 'list') el.value = (value || []).join('\n');
    else if (el.tagName === 'SELECT') setSelectValue(el, value || '');
    else el.value = value ?? '';
  }
}

function readForm() {
  const company = structuredClone(current);
  for (const el of $$('#editor [data-path]')) {
    let value = el.value;
    if (el.dataset.type === 'list') value = value.split('\n').map(s => s.trim()).filter(Boolean);
    else if (el.dataset.type === 'number') value = value.trim() === '' ? null : Number(value);
    else value = value.trim();
    setPath(company, el.dataset.path, value);
  }
  return company;
}

function clearErrors() {
  $$('#editor .error-msg').forEach(el => el.remove());
  $$('#editor .invalid').forEach(el => el.classList.remove('invalid'));
}

function showErrors(errors) {
  clearErrors();
  let first = null;
  for (const { field, message } of errors) {
    const el = field.startsWith('secrets.')
      ? $(`[data-secret="${field.slice('secrets.'.length)}"]`)
      : $(`#editor [data-path="${field}"]`);
    if (!el) continue;
    el.classList.add('invalid');
    el.closest('label').insertAdjacentHTML('beforeend', `<small class="error-msg">${esc(message)}</small>`);
    first = first || el;
  }
  if (first) selectTab(first.closest('[data-panel]').dataset.panel);
}

async function loadSecrets(reveal) {
  const secrets = await api('GET', companyUrl(`/secrets${reveal ? '?reveal=1' : ''}`));
  for (const key of SECRET_KEYS) {
    const el = $(`[data-secret="${key}"]`);
    el.type = reveal ? 'text' : 'password';
    el.value = reveal ? secrets[key].value : '';
    el.placeholder = secrets[key].set ? `guardada: ${secrets[key].value}` : 'sin cargar';
  }
}

async function refreshPreview() {
  const r = await api('POST', companyUrl('/prompt-preview'), readForm());
  $('#preview').value = r.prompt;
  $('#preview-info').textContent = `${r.chars} caracteres · sha256 ${r.sha256} (el bridge muestra este hash al arrancar)`;
}

function selectTab(name) {
  $$('#tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('#editor [data-panel]').forEach(p => (p.hidden = p.dataset.panel !== name));
  if (name === 'prompt') refreshPreview().catch(err => ($('#preview-info').textContent = err.message));
}

async function openEditor(id) {
  if (dirty && !confirm('Hay cambios sin guardar. ¿Salir igual?')) return;
  current = await api('GET', `/api/companies/${encodeURIComponent(id)}`);
  dirty = false;
  $('#view-list').hidden = true;
  $('#view-editor').hidden = false;
  history.replaceState(null, '', `#${id}`);
  $('#editor-title').textContent = `${(current.business && current.business.name) || id} (${id})`;
  fillForm(current);
  clearErrors();
  setStatus($('#save-status'), '');
  setResult($('#homolog-result'), '');
  setResult($('#prod-result'), '');
  $('#preview').value = '';
  $('#preview-info').textContent = '';
  await loadSecrets(false);
  selectTab('negocio');
}

$('#tabs').addEventListener('click', e => {
  if (e.target.dataset.tab) selectTab(e.target.dataset.tab);
});
$('#editor').addEventListener('input', () => (dirty = true));
$('#back').addEventListener('click', () => showList().catch(err => alert(err.message)));
$('#preview-btn').addEventListener('click', () => refreshPreview().catch(err => ($('#preview-info').textContent = err.message)));
window.addEventListener('beforeunload', e => {
  if (dirty) e.preventDefault();
});

$('#editor').addEventListener('submit', async e => {
  e.preventDefault();
  const status = $('#save-status');
  setStatus(status, 'Guardando…');
  try {
    const { company, restart } = await api('PUT', companyUrl(), readForm());
    current = company;
    const secrets = Object.fromEntries(
      $$('[data-secret]').map(el => [el.dataset.secret, el.value.trim()]).filter(([, value]) => value),
    );
    if (Object.keys(secrets).length) await api('PUT', companyUrl('/secrets'), secrets);
    await loadSecrets(false);
    dirty = false;
    clearErrors();
    $('#editor-title').textContent = `${current.business.name} (${current.id})`;
    status.innerHTML = `Guardado. Reiniciá el bridge de esta empresa para aplicar los cambios: <code>${esc(restart)}</code>`;
    status.className = 'status good';
  } catch (err) {
    showErrors(err.errors || []);
    setStatus(status, describe(err), 'bad');
  }
});

$('#delete').addEventListener('click', async () => {
  if (!confirm(`¿Eliminar ${current.id}? Se mueve a companies/.trash/ y se puede recuperar desde ahí.`)) return;
  try {
    await api('DELETE', companyUrl());
    dirty = false;
    await showList();
  } catch (err) {
    setStatus($('#save-status'), describe(err), 'bad');
  }
});

// ---------- homologación actions (they use the saved config) ----------

function requireSaved(out) {
  if (!dirty) return true;
  setResult(out, 'Guardá los cambios antes: las acciones usan la configuración guardada.', 'bad');
  return false;
}

$('#reveal').addEventListener('click', () => loadSecrets(true).catch(err => setResult($('#homolog-result'), describe(err), 'bad')));

$('#load-sessions').addEventListener('click', async () => {
  const out = $('#homolog-result');
  if (!requireSaved(out)) return;
  setResult(out, 'Consultando OpenWA…');
  try {
    const sessions = await api('GET', companyUrl('/openwa/sessions'));
    const select = $('[data-path="environments.homologacion.sessionId"]');
    const keep = select.value;
    select.innerHTML =
      '<option value="">(elegí una sesión)</option>' +
      sessions
        .map(s => `<option value="${esc(s.id)}">${esc(`${s.name || s.id} · ${s.status}${s.phone ? ` · ${s.phone}` : ''}`)}</option>`)
        .join('');
    setSelectValue(select, keep);
    setResult(out, `Conectado. ${sessions.length} sesión(es) en OpenWA. Si cambiás la sesión, guardá.`, 'good');
  } catch (err) {
    setResult(out, describe(err), 'bad');
  }
});

$('#register-webhook').addEventListener('click', async () => {
  const out = $('#homolog-result');
  if (!requireSaved(out)) return;
  setResult(out, 'Registrando…');
  try {
    const r = await api('POST', companyUrl('/openwa/webhook'));
    const listens = r.events.includes('message.received') || r.events.includes('*');
    const lines = [r.created ? `Webhook registrado (id ${r.id}).` : `Ya estaba registrado (id ${r.id}). Eventos: ${r.events.join(', ')}.`];
    if (!r.active) lines.push('Atención: el webhook está inactivo en OpenWA.');
    if (!listens) lines.push('Atención: no está suscripto a message.received.');
    setResult(out, lines.join('\n'), r.active && listens ? 'good' : 'warn');
  } catch (err) {
    setResult(out, describe(err), 'bad');
  }
});

$('#send-test').addEventListener('click', async () => {
  const out = $('#homolog-result');
  if (!requireSaved(out)) return;
  setResult(out, 'Enviando evento de prueba…');
  try {
    const r = await api('POST', companyUrl('/openwa/test'));
    if (r.success) setResult(out, `OpenWA entregó el evento al bridge (HTTP ${r.statusCode}). El bridge lo registra como "ignored event".`, 'good');
    else setResult(out, `OpenWA no pudo entregarlo: ${r.error || `HTTP ${r.statusCode}`}. ¿Está corriendo el bridge con el mismo secret?`, 'bad');
  } catch (err) {
    setResult(out, describe(err), 'bad');
  }
});

// ---------- producción ----------

$('#export').addEventListener('click', async () => {
  const out = $('#prod-result');
  if (!requireSaved(out)) return;
  const run = overwrite => api('POST', companyUrl('/export'), { overwrite });
  setResult(out, 'Exportando…');
  try {
    let r;
    try {
      r = await run(false);
    } catch (err) {
      if (err.status !== 409 || !confirm(`${err.message}.\nLa versión anterior queda en dist/${current.id}.prev. ¿Reemplazar?`)) throw err;
      r = await run(true);
    }
    const lines = [
      `Paquete generado en ${r.dir}`,
      r.keptEnv ? 'Se conservó el .env con las claves de la exportación anterior.' : 'Completá las claves en .env antes de levantarlo.',
      ...r.warnings.map(w => `Advertencia: ${w}`),
      'Seguí los pasos de DEPLOY.md.',
    ];
    setResult(out, lines.join('\n'), r.warnings.length ? 'warn' : 'good');
  } catch (err) {
    showErrors(err.errors || []);
    setResult(out, describe(err), 'bad');
  }
});

// ---------- start ----------

const initial = decodeURIComponent(location.hash.slice(1));
(initial ? openEditor(initial).catch(() => showList()) : showList()).catch(err => alert(err.message));
```

- [ ] **Step 3: Create `dashboard/public/styles.css`**

```css
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1d2330;
  --muted: #5d6675;
  --border: #d9dde3;
  --accent: #0b6e4f;
  --accent-text: #ffffff;
  --bad: #b42318;
  --warn: #9a6700;
  --good: #0b6e4f;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15181d;
    --panel: #1e232a;
    --text: #e6e9ee;
    --muted: #9aa3b2;
    --border: #333a44;
    --accent: #3fb68b;
    --accent-text: #0d1512;
    --bad: #f97066;
    --warn: #f5b83d;
    --good: #3fb68b;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); }
header { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
header h1 { font-size: 1.1rem; margin: 0; }
main { max-width: 980px; margin: 0 auto; padding: 16px; }
h3 { font-size: 1rem; margin: 16px 0 4px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.toolbar h2 { flex: 1; margin: 8px 0; font-size: 1.2rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px; }
.card, .panel, fieldset { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.card h3 { margin: 0; }
.muted { color: var(--muted); margin: 2px 0 8px; }
.badge { display: inline-block; font-size: .8rem; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; margin: 2px 0; }
.badge.ok { color: var(--good); }
.badge.warn { color: var(--warn); }
legend { font-weight: 700; padding: 0 4px; }
label { display: block; margin: 10px 0; font-weight: 600; font-size: .9rem; }
label small { font-weight: 400; color: var(--muted); display: block; }
input, select, textarea {
  display: block; width: 100%; margin-top: 4px; padding: 8px; font: inherit; font-weight: 400;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
}
textarea { resize: vertical; }
textarea.code, .result, code { font-family: ui-monospace, Consolas, monospace; font-size: .85rem; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 12px; }
button {
  font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--accent); color: var(--accent-text); cursor: pointer;
}
button.secondary, .tabs button { background: transparent; color: var(--text); border-color: var(--border); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button.link { background: none; border: none; color: var(--accent); padding: 8px 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
.tabs button.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.savebar {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; justify-content: flex-end;
  padding: 12px 0; background: var(--bg); border-top: 1px solid var(--border); margin-top: 12px;
}
.savebar .status { flex: 1; }
.status { margin: 6px 0; font-size: .9rem; }
.result { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; min-height: 2.4em; margin: 6px 0; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.warn { color: var(--warn); }
.invalid { border-color: var(--bad); }
.error-msg { color: var(--bad); font-weight: 400; display: block; }
.hint { color: var(--muted); font-size: .85rem; }
```

- [ ] **Step 4: Manual check in a browser**

Run `npm run dashboard`, open `http://127.0.0.1:3100`, and verify:
1. The list shows rocaBianca with badges (Homologación lists the missing keys until they are saved).
2. Editar → every tab shows rocaBianca's data; the Prompt tab shows `5143 caracteres` (joining the services line swaps two newlines for spaces, so the length is unchanged) and the same sha256 the bridge prints at startup.
3. Set Comportamiento → hasta (h) = 30 and Guardar → the field turns red with "hora entera entre 0 y 23"; set it back to 8 → "Guardado. Reiniciá el bridge…".
4. Narrow the window to ~375 px: no horizontal scroll; dark mode readable.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public
git commit -m "feat(examples): dashboard page to edit companies, test OpenWA and export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, ignores and end-to-end verification

**Files:**
- Modify: `README.md`, `.env.example`, `.gitignore`
- Local only (never committed): `companies/rocabianca/.env.homologacion`

- [ ] **Step 1: `.gitignore`** — append:

```
dist/
companies/*/.env.*
companies/.trash/
```

- [ ] **Step 2: `.env.example`** — replace the block that starts with `# Time zone for the night pause` and ends with `NIGHT_PAUSE_END=8` by:

```
# The time zone and night pause now live in each company's company.json (bridge.timeZone,
# bridge.nightPauseStart, bridge.nightPauseEnd), editable from the dashboard (npm run dashboard).
```

- [ ] **Step 3: `README.md`** — append:

```markdown
## Varias empresas y dashboard

- `npm run dashboard` abre la configuración en http://127.0.0.1:3100 (solo desde esta PC). Cada empresa vive en `companies/<id>/company.json`; las claves de homologación, en `companies/<id>/.env.homologacion` (fuera de git).
- Probar una empresa en homologación: `npm run dev -- --company <id> --env homologacion`. Sin argumentos, `npm start`/`npm run dev` siguen levantando rocaBianca con el `.env` de esta carpeta.
- Cada empresa usa su puerto de homologación y guarda sus bajas en `data/<id>/optouts.json`.
- **Exportar a producción** genera `dist/<id>/` (Dockerfile, docker-compose, `company.json`, `.env` con las claves vacías y `DEPLOY.md` con los pasos). Las claves de producción no se guardan en el dashboard.
- `npm test` corre las pruebas (`node:test`).
```

- [ ] **Step 4: Seed rocaBianca's homologación keys from the current `.env`** (local file, git-ignored; do not print values)

```bash
node -e '
const fs = require("fs"); const dotenv = require("dotenv");
const env = dotenv.parse(fs.readFileSync(".env"));
const keys = ["ANTHROPIC_API_KEY", "OPENWA_API_KEY", "OPENWA_WEBHOOK_SECRET"];
fs.writeFileSync("companies/rocabianca/.env.homologacion", "# Claves de homologación: las escribe el dashboard y no se suben a git.\n" + keys.map(k => `${k}=${env[k] || ""}`).join("\n") + "\n");
console.log(keys.map(k => `${k}: ${env[k] ? "set" : "MISSING"}`).join(", "));'
git check-ignore companies/rocabianca/.env.homologacion
```

Expected: all three `set`; `git check-ignore` prints the path.

- [ ] **Step 5: Full test run**

Run: `npm test`
Expected: every test passes; note the counts for the report.

- [ ] **Step 6: Scripted bridge run against the fake OpenWA** (the session's harness; Claude calls are real)

The harness lives in the session scratchpad (`$SCRATCH/testrun/harness.js`); it spawns `bridge.js` next to itself against a fake OpenWA. Give it the new files and a data dir:

```bash
T="$SCRATCH/testrun"
cp bridge.js "$T/" && rm -rf "$T/lib" "$T/companies" && cp -r lib "$T/lib" && mkdir -p "$T/companies/rocabianca" && cp companies/rocabianca/company.json "$T/companies/rocabianca/"
sed -i 's#PORT: String(BRIDGE_PORT),#PORT: String(BRIDGE_PORT),
      DATA_DIR: path.join(here, "data"),#' "$T/harness.js"
KEY=$(node -e 'require("dotenv").config({quiet:true});process.stdout.write(process.env.ANTHROPIC_API_KEY||"")')
node "$T/harness.js" "$PWD" "$KEY" | tail -11
```

Expected: the same 10 cases PASS (normal + context, cotización, baja, reactivación ×2, rate limit, duplicado, fromMe, baja durante espera, persistencia al reiniciar).

- [ ] **Step 7: Restart the real bridge in company mode and check the log**

Stop the running bridge (check with `Get-NetTCPConnection -LocalPort 3001` that the old node process is gone), then run `npm run dev -- --company rocabianca --env homologacion`. Expected startup line: `"company":"rocabianca","env":"homologacion"` and the migrated prompt hash.

- [ ] **Step 8: Dashboard against the real OpenWA**

With the dashboard running: Homologación → Probar conexión (lists `testrocabianca · ready`), Registrar webhook ("Ya estaba registrado"), Enviar evento de prueba ("OpenWA entregó el evento…"; bridge log shows `ignored event` `test`). Producción → fill example values (`https://openwa.example.com`, `example-session`, `https://bot.example.com/rocabianca/webhook`), Guardar, Exportar → `dist/rocabianca/` created; inspect `.env` (keys empty) and `DEPLOY.md`. Then restore producción to empty values and delete `dist/` so no example values are committed.

- [ ] **Step 9: Commit**

```bash
git add README.md .env.example .gitignore
git commit -m "docs(examples): document the multi-company dashboard and ignore local outputs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
