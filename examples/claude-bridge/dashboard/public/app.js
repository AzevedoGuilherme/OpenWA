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
