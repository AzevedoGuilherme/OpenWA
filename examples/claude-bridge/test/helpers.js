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
