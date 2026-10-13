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
