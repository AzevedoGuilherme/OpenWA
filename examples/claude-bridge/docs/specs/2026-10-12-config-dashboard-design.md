# Dashboard de configuración multiempresa — diseño

Fecha: 2026-10-12 · Estado: aprobado en conversación, pendiente de revisión escrita

## Objetivo

Administrar desde un dashboard local la configuración de varias empresas que usan el bridge
WhatsApp ↔ Claude: datos del negocio, prompt, mensajes, comportamiento del bridge y conexión con
OpenWA. Cada empresa se prueba en **homologación** (local) y se **exporta a producción** como un
paquete Docker independiente.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Multiempresa | Un bridge por empresa. El dashboard administra configuraciones; no hay un proceso compartido. |
| Producción | VPS con Docker. La exportación genera un paquete listo para `docker compose up -d`. |
| Claves | Solo se guardan las de homologación. La exportación a producción deja las claves vacías. |
| Alcance OpenWA | Conexión y webhook: URL, API key, sesión, secret, registrar/verificar webhook. No toca el servidor OpenWA. |
| Prompt | Campos estructurados del negocio + texto de reglas editable + vista previa. |
| Acceso | Solo en la PC del operador (`127.0.0.1`), sin login. |
| Almacenamiento | Archivos JSON por empresa (enfoque A). Sin base de datos. |

## 1. Estructura de archivos

```
examples/claude-bridge/
├── bridge.js                    # carga una empresa; ya no tiene datos de rocaBianca en el código
├── lib/
│   ├── company.js               # carga, valida y arma el prompt de una empresa
│   ├── optout.js                # detección de baja/reactivación (movido sin cambios)
│   └── export.js                # genera dist/<id>/
├── dashboard/
│   ├── server.js                # Express en 127.0.0.1:3100
│   └── public/                  # index.html, app.js, styles.css (sin build)
├── companies/
│   └── <id>/
│       ├── company.json         # en git: todo menos claves
│       └── .env.homologacion    # ignorado por git: claves de homologación
├── data/<id>/optouts.json       # ignorado por git: bajas por empresa
├── dist/<id>/                   # ignorado por git: paquetes exportados
└── test/                        # node:test
```

`<id>` cumple `^[a-z0-9][a-z0-9-]{0,39}$`. Cualquier otro valor se rechaza antes de tocar el disco.

## 2. Modelo de datos (`company.json`)

```json
{
  "id": "rocabianca",
  "business": {
    "name": "rocaBianca",
    "activity": "Salón y producción de eventos en Córdoba, Argentina.",
    "intro": "rocaBianca organiza bodas, fiestas de 15 años, cumpleaños y eventos corporativos.",
    "offer": "Ofrecemos servicios relacionados con organización, catering, decoración,\nentretenimiento y espacios para eventos.",
    "events": ["Bodas", "Fiestas de 15 años", "Cumpleaños", "Eventos corporativos", "Eventos"],
    "services": ["Decoración floral", "Catering y decoración", "Entretenimiento",
                 "Espacios interiores y exteriores", "Recomendación de fotografía y video",
                 "Recomendación de invitaciones"],
    "address": "Bernardo O'Higgins 8500, X5014 Córdoba, Argentina.",
    "email": "eventos@rocabianca.com.ar",
    "whatsapp": "+54 351 706 2763"
  },
  "prompt": { "rules": "OBJETIVO\n\n…hasta la regla 17" },
  "messages": {
    "fallback": "Disculpá, estamos con un problema técnico. Te respondemos en un ratito.",
    "optOutReply": "Disculpá la molestia. No volveremos a enviarte mensajes.",
    "handoffPhrase": "te paso con nuestro equipo"
  },
  "bridge": {
    "model": "claude-haiku-4-5-20251001",
    "maxTokens": 500,
    "historyLimit": 12,
    "delayMinMs": 5000,
    "delayMaxMs": 15000,
    "chatMinIntervalMs": 30000,
    "timeZone": "America/Argentina/Buenos_Aires",
    "nightPauseStart": 22,
    "nightPauseEnd": 8
  },
  "environments": {
    "homologacion": {
      "openwaUrl": "http://localhost:2785",
      "sessionId": "47568f50-1352-4354-a322-88b294dd97b2",
      "port": 3001,
      "webhookUrl": "http://host.docker.internal:3001/webhook"
    },
    "produccion": {
      "openwaUrl": "",
      "sessionId": "",
      "port": 3001,
      "webhookUrl": ""
    }
  }
}
```

`business.events` se guarda para mostrarlo y editarlo; el prompt usa `intro` y `offer` como texto
para que el prompt migrado sea idéntico al actual.

Claves (nunca en `company.json`): `ANTHROPIC_API_KEY`, `OPENWA_API_KEY`, `OPENWA_WEBHOOK_SECRET`.

### Armado del prompt

`buildSystemPrompt(company)` concatena, en este orden y con el mismo espaciado que el prompt actual:

1. `Sos el asistente de WhatsApp de <name>.`
2. `intro` y `offer`.
3. Bloque `DATOS DEL NEGOCIO (podés compartirlos tal cual)` generado desde `activity`, `address`,
   `email`, `whatsapp` y `services`. Los servicios van en una sola línea:
   `Servicios confirmados: ` + cada servicio con la inicial en minúscula, unidos por `; `, + `.`
4. `prompt.rules`.

Criterio de aceptación: el prompt armado desde `companies/rocabianca/company.json` es idéntico al
`SYSTEM_PROMPT` actual (5143 caracteres, sha256 `f08792f53415…`) salvo la línea de servicios, que
hoy está cortada en tres renglones y pasa a ser uno solo. El test compara ambos textos tras unir
esos renglones; el hash nuevo queda registrado en el test.

## 3. Bridge

- Selección de empresa y entorno, en este orden de prioridad:
  1. Argumentos: `--company <id> --env <homologacion|produccion>`.
  2. Variables: `COMPANY_CONFIG` (ruta a un `company.json`) y `COMPANY_ENV`.
  3. Sin nada: `companies/rocabianca/company.json`, entorno `homologacion`, claves desde `.env`
     de la carpeta (comportamiento actual).
- Claves: con `--company`, se cargan desde `companies/<id>/.env.<env>`; si no, desde `.env`
  (Docker usa `env_file`).
- `OPENWA_URL` y `PORT` del entorno pueden sobrescribirse con variables de entorno (útil en Docker).
- Directorio de bajas: `DATA_DIR` si está definido (Docker: `/app/data`), si no `data/<id>/`.
  El archivo es siempre `<dir>/optouts.json`.
  Migración: si existe `data/optouts.json` (formato actual), se mueve a `data/rocabianca/` al
  arrancar rocaBianca.
- Todo lo que hoy es constante (`MODEL`, `MAX_TOKENS`, `HISTORY_LIMIT`, delays, intervalo, zona
  horaria, pausa nocturna, mensajes) se lee de `company.json`.
- Validación al arrancar: si `company.json` falta o es inválido, el bridge termina con código 1 y
  lista cada campo que falla.
- El log `bridge listening` agrega `company` y `env`.

## 4. Dashboard

`npm run dashboard` → `http://127.0.0.1:3100`. El servidor solo escucha en `127.0.0.1` y además
rechaza requests cuyo `Host` no sea `127.0.0.1:3100` o `localhost:3100` (defensa contra DNS
rebinding).

### Pantallas

1. **Empresas**: tarjetas con nombre, id, estado de configuración por entorno y estado del webhook
   de homologación. Acciones: Nueva (vacía o copiando otra) y Eliminar (con confirmación; mueve
   la carpeta a `companies/.trash/<id>-<timestamp>/`).
2. **Editor**, con pestañas:
   - **Negocio**: campos de `business`; eventos y servicios como listas editables.
   - **Prompt**: `prompt.rules` editable + vista previa del prompt final con caracteres y hash.
   - **Mensajes**: `messages.*`.
   - **Comportamiento**: `bridge.*`.
   - **Homologación**: campos del entorno + las tres claves (ocultas, con botón Ver) + desplegable
     de sesiones cargado desde OpenWA + acciones Probar conexión, Registrar webhook (crea solo si no
     existe uno con esa URL) y Enviar evento de prueba.
   - **Producción**: campos del entorno, sin claves + Exportar.
3. Tras guardar, aviso "Reiniciá el bridge de esta empresa para aplicar los cambios" con el comando
   exacto.

### API (consumida solo por la página)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/companies` | Lista con estado resumido |
| POST | `/api/companies` | Crear (`{ id, copyFrom? }`) |
| GET / PUT | `/api/companies/:id` | Leer / guardar `company.json` |
| DELETE | `/api/companies/:id` | Mover a `.trash` |
| GET / PUT | `/api/companies/:id/secrets` | Claves de homologación; GET devuelve enmascaradas salvo `?reveal=1` |
| GET | `/api/companies/:id/prompt-preview` | Prompt armado, caracteres, hash |
| GET | `/api/companies/:id/openwa/sessions` | Sesiones de OpenWA (homologación) |
| POST | `/api/companies/:id/openwa/webhook` | Registrar o verificar webhook |
| POST | `/api/companies/:id/openwa/test` | Evento de prueba del webhook |
| POST | `/api/companies/:id/export` | Exportar (`{ overwrite: true }` si ya existe) |

### Validaciones (al guardar y al exportar)

- Obligatorios: `business.name`, `prompt.rules`, `messages.*`, `bridge.*`.
- URLs `http(s)` válidas; secret de 16 a 255 caracteres (límite de OpenWA).
- Horas enteras 0–23; zona horaria IANA válida (`Intl.DateTimeFormat`).
- `delayMinMs <= delayMaxMs`; números positivos; `historyLimit` entre 1 y 50.
- Puerto de homologación único entre empresas.
- Si falla, no se guarda y la respuesta indica cada campo con su mensaje.

## 5. Exportación a producción

Genera `dist/<id>/`:

```
app/                 bridge.js, lib/, package.json, package-lock.json
company.json         copia de la empresa
.env                 COMPANY_ENV=produccion + las 3 claves vacías
Dockerfile           node:22-alpine, copia app/, npm ci --omit=dev, USER node, CMD ["node", "bridge.js"]
docker-compose.yml   restart: unless-stopped, env_file .env, COMPANY_CONFIG=/app/company.json,
                     DATA_DIR=/app/data, volúmenes ./company.json:/app/company.json:ro y
                     ./data:/app/data, healthcheck GET /health, puerto del entorno de producción
DEPLOY.md            pasos con los valores de la empresa ya completados
```

- **Bloquea** si faltan `openwaUrl`, `sessionId` o `webhookUrl` de producción, o si la validación
  falla.
- **Advierte** (sin bloquear): webhook sin `https`; `openwaUrl` con `localhost`/`127.0.0.1`.
- Nunca copia `.env.homologacion`, `data/`, `node_modules`, `dashboard/` ni `companies/` de otras
  empresas.
- Si `dist/<id>/` existe: requiere `overwrite: true`; la versión anterior pasa a `dist/<id>.prev/`
  (reemplazando una `.prev` previa). Si la anterior tenía un `.env` con alguna clave no vacía, ese
  `.env` se conserva en la nueva exportación.
- `DEPLOY.md` incluye: copiar al VPS, completar `.env`, `docker compose up -d`, el `curl` para
  registrar el webhook con los valores reales, cómo leer el log `bridge listening` (hash del
  prompt), y notas de `SSRF_ALLOWED_HOSTS` y HTTPS.

## 6. Manejo de errores

- Escrituras atómicas (`.tmp` + rename) para `company.json`, `.env.homologacion` y bajas.
- Errores de OpenWA se muestran con el código y un mensaje legible; nada se guarda a medias.
- Ni el bridge ni el dashboard escriben claves ni cuerpos de mensajes en los logs.

## 7. Pruebas

`npm test` con `node:test` (sin dependencias nuevas):

- `company`: el prompt de rocaBianca migrado es idéntico al actual salvo la línea de servicios
  (ver sección 2);
  validaciones rechazan secret corto, hora 25, zona inválida, delay invertido, puerto repetido,
  id con `../`.
- `optout`: los 16 casos ya verificados.
- `export`: archivos generados; `.env` sin claves; no copia `.env.homologacion` ni `data/`;
  conserva un `.env` completado al reexportar; bloquea sin datos de producción.
- `dashboard`: rechaza `Host` ajeno e ids inválidos; GET de claves enmascara.

Además: rerun del harness con OpenWA simulado (10 casos) contra el bridge migrado, y prueba
manual del dashboard en el navegador.

## 8. Fuera de alcance

Login y acceso remoto · arrancar/frenar bridges desde el dashboard · ajustes del servidor OpenWA
(SSRF, SIMULATE_TYPING, SEND_PACING) · QR y estado de sesión · guardar claves de producción ·
aplicar cambios sin reiniciar · varias empresas en un mismo proceso.

## 9. Compatibilidad

`npm start` y `npm run dev` sin argumentos siguen levantando rocaBianca con el `.env` actual.
`data/optouts.json` existente se migra a `data/rocabianca/optouts.json` sin perder bajas.
