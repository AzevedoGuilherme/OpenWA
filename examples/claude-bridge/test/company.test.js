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
