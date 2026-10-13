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
