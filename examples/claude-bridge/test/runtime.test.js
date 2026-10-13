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
