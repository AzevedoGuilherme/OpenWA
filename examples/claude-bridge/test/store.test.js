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
