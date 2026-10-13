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
