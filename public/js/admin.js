import { normalize } from './search.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const STATUS = { success: 'Correcta', partial: 'Con avisos', error: 'Error', running: 'En curso', available: 'Disponible', missing: 'Ausente', unavailable: 'No disponible' };
const TRIGGER = { scheduled: 'Programada', manual: 'Manual', cli: 'Línea de comandos' };
const TYPE = { movie: 'Película', tv: 'Serie', sala: 'Sala' };
const HELP = {
  unidentified: 'Títulos de los que la cartelera original solo publica el póster (o un enlace sin datos). Vincúlalos a su ficha de TMDB o completa los datos a mano.',
  unavailable: 'Títulos que han dejado de aparecer en la cartelera original. No se borran: tras el umbral configurado se ocultan de la web pública.',
  duplicates: 'Títulos con el mismo nombre, tipo y año pero distinto identificador. Vincula ambos al mismo ID de TMDB para fusionarlos.',
  errors: 'Títulos cuyo enriquecimiento de metadatos ha fallado en la última sincronización.',
  all: 'Todo el contenido registrado, incluido el que ya no está disponible.',
};

let token = '';
try {
  token = sessionStorage.getItem('cajon.admin') || '';
} catch {
  /* sin sessionStorage: se pedirá el token en cada visita */
}
let status = null;
let filter = 'unidentified';
let pollTimer = null;
let catalogTitles = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout('La sesión no es válida. Vuelve a introducir el token.');
    throw new Error(data.error || 'No autorizado');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

function flash(msg, kind = 'ok') {
  $('#flash').innerHTML = msg ? `<div class="${kind}">${esc(msg)}</div>` : '';
}

/* ------------------------------------------------------------ sesión */
function showLogin(msg = '') {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#logout').hidden = true;
  $('#login-msg').textContent = msg;
  $('#token').focus();
}
function logout(msg) {
  token = '';
  try {
    sessionStorage.removeItem('cajon.admin');
  } catch {
    /* nada */
  }
  clearTimeout(pollTimer);
  showLogin(msg);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('#token').value.trim();
  try {
    await loadStatus();
    try {
      sessionStorage.setItem('cajon.admin', token);
    } catch {
      /* nada */
    }
    $('#token').value = '';
    enterApp();
  } catch (err) {
    $('#login-msg').textContent = err.message;
  }
});
$('#logout').addEventListener('click', () => logout(''));

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  loadContent();
}

/* ------------------------------------------------------------ estado */
async function loadStatus() {
  status = await api('/api/admin/status');
  renderStatus();
  clearTimeout(pollTimer);
  if (status.running) pollTimer = setTimeout(() => loadStatus().catch(() => {}), 3000);
  return status;
}

function stat(label, value, sub = '', cls = '') {
  return `<div class="stat ${cls}"><dt>${esc(label)}</dt><dd>${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ''}</dd></div>`;
}

function renderStatus() {
  const s = status;
  const last = s.runs[0];
  const c = s.counts;
  $('#source-url').textContent = `Fuente: ${s.sourceBaseUrl}`;
  const lastErrors = last?.errors?.length || 0;
  $('#stats').innerHTML = [
    stat('Última sincronización', s.lastRunAt ? fmt(s.lastRunAt) : 'Nunca', last ? `${STATUS[last.status] || last.status}${lastErrors ? ` · ${lastErrors} aviso(s)` : ''}` : '', last?.status === 'error' ? 'bad' : last?.status === 'partial' ? 'warn' : ''),
    stat('Próxima sincronización', s.running ? 'En curso…' : s.schedulerEnabled ? fmt(s.nextSyncAt) : 'Desactivada', `Cada ${s.intervalHours} h`),
    stat('Películas disponibles', c.movies),
    stat('Series disponibles', c.series),
    stat('Nuevos (última)', last?.new_count ?? 0),
    stat('Modificados (última)', last?.updated_count ?? 0),
    stat('Ausentes / no disp.', `${c.missing} / ${c.unavailable}`, '', c.missing || c.unavailable ? 'warn' : ''),
    stat('Sin identificar', c.unidentified, s.tmdbConfigured ? 'Vincúlalos abajo' : 'Configura TMDB', c.unidentified ? 'warn' : ''),
    stat('Errores (última)', lastErrors, '', lastErrors ? 'bad' : ''),
  ].join('');

  const btn = $('#sync-now');
  btn.disabled = s.running;
  btn.textContent = s.running ? 'Sincronizando…' : 'Sincronizar ahora';
  if (document.activeElement !== $('#interval')) $('#interval').value = s.intervalHours;
  if (document.activeElement !== $('#threshold')) $('#threshold').value = s.missingThreshold;
  $('#tmdb-status').innerHTML = s.tmdbConfigured
    ? 'Metadatos TMDB: <strong>activados</strong> (sinopsis, reparto, géneros, temporadas y episodios).'
    : 'Metadatos TMDB: <strong>no configurados</strong>. Añade <code>TMDB_API_KEY</code> en <code>.env</code> para títulos, sinopsis, géneros, reparto y episodios. Sin ella la web solo muestra lo que publica la fuente.';

  $('#sources').innerHTML = s.sources.length
    ? s.sources.map((src) => `<tr><td>${esc(src.url.split('/').pop())}</td><td>${esc(src.last_modified ? fmt(src.last_modified) : '—')}</td><td>${esc(fmt(src.fetched_at))}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">Aún no se ha consultado la fuente.</td></tr>';

  $('#runs').innerHTML = s.runs.length ? s.runs.map((r) => {
    const d = r.details || {};
    const list = (arr) => arr.map((x) => `<li>${esc(x.title || x.id)}${x.type ? ` <span class="muted">(${TYPE[x.type] || x.type})</span>` : ''}</li>`).join('');
    const cats = Object.entries(d.categories || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v.status)}${v.count != null ? `, ${v.count} títulos` : ''}${v.error ? ` — ${esc(v.error)}` : ''}</li>`).join('');
    const hasDetail = r.errors.length || d.newItems?.length || d.updatedItems?.length || cats;
    return `<tr>
      <td>${esc(fmt(r.started_at))}</td>
      <td>${esc(TRIGGER[r.trigger] || r.trigger)}</td>
      <td><span class="status status-${r.status}">${esc(STATUS[r.status] || r.status)}</span>${r.attempts > 1 ? `<br><small class="muted">${r.attempts} intentos</small>` : ''}</td>
      <td>${r.new_count}</td><td>${r.updated_count}</td><td>${r.missing_count}</td><td>${r.unavailable_count}</td>
      <td>${d.tmdb?.configured ? `${r.enriched_count}${d.tmdb.unmatched ? ` <small class="muted">(${d.tmdb.unmatched} sin identificar)</small>` : ''}` : '<span class="muted">—</span>'}</td>
      <td>${hasDetail ? `<details><summary>Ver</summary>
        ${r.errors.length ? `<strong>Errores</strong><ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        ${d.newItems?.length ? `<strong>Nuevos</strong><ul>${list(d.newItems)}</ul>` : ''}
        ${d.updatedItems?.length ? `<strong>Modificados</strong><ul>${list(d.updatedItems)}</ul>` : ''}
        ${cats ? `<strong>Páginas</strong><ul>${cats}</ul>` : ''}
      </details>` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="muted">Todavía no hay sincronizaciones.</td></tr>';
}

$('#sync-now').addEventListener('click', async () => {
  try {
    await api('/api/admin/sync', { method: 'POST', body: { force: $('#force').checked } });
    flash('Sincronización iniciada. El estado se actualiza automáticamente.', 'info');
    $('#force').checked = false;
    setTimeout(async () => {
      await loadStatus();
      waitForFinish();
    }, 600);
  } catch (err) {
    flash(err.message, 'err');
  }
});

async function waitForFinish() {
  if (status?.running) {
    setTimeout(waitForFinish, 3000);
    return;
  }
  const r = status?.runs[0];
  if (r) {
    flash(`Sincronización ${STATUS[r.status]?.toLowerCase() || r.status}: ${r.new_count} nuevos, ${r.updated_count} modificados, ${r.missing_count} ausentes.`, r.status === 'error' ? 'err' : 'ok');
  }
  catalogTitles = null;
  loadContent();
}

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/api/admin/settings', { method: 'PUT', body: { intervalHours: Number($('#interval').value), missingThreshold: Number($('#threshold').value) } });
    flash(`Guardado. Próxima sincronización: ${fmt(res.nextSyncAt)}.`);
    loadStatus();
  } catch (err) {
    flash(err.message, 'err');
  }
});

/* ------------------------------------------------------------ contenido */
$('#content-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadContent();
});

async function loadContent() {
  $('#content-help').textContent = HELP[filter];
  const list = $('#content-list');
  list.innerHTML = '<p class="muted"><span class="spinner"></span> Cargando…</p>';
  try {
    const { items } = await api(`/api/admin/items?filter=${filter}`);
    if (!items.length) {
      list.innerHTML = '<p class="muted">No hay títulos en esta lista. 👍</p>';
      return;
    }
    list.innerHTML = items.slice(0, 300).map((it) => `<div class="content-row" data-id="${it.id}">
      ${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy">` : '<span class="thumb-ph"></span>'}
      <div>
        <h3>${esc(it.title || it.categories[0]?.channel || 'Sin título')}${it.year ? ` <span class="muted">(${it.year})</span>` : ''}</h3>
        <p>${esc(TYPE[it.type])} · ${esc(it.categories.map((c) => c.channel ? `${c.label} (${c.channel})` : c.label).join(', ') || 'fuera de la cartelera')} · <span class="status status-${it.status}">${esc(STATUS[it.status])}</span>${it.tmdbId ? ` · TMDB ${esc(it.tmdbType)}/${it.tmdbId}${it.tmdbManual ? ' (manual)' : ''}` : ''}</p>
        ${it.enrichError ? `<p class="err-text">${esc(it.enrichError)}</p>` : ''}
        ${it.status !== 'available' ? `<p>Visto por última vez: ${esc(fmt(it.lastSeenAt))} · ${it.missingCount} sincronización(es) sin aparecer</p>` : ''}
      </div>
      <div class="row-actions">
        ${it.type !== 'sala' ? `<button class="btn btn-ghost" type="button" data-link="${it.id}">Vincular a TMDB</button>
        <button class="btn btn-ghost" type="button" data-edit="${it.id}">Editar datos</button>` : ''}
        <a class="btn btn-link" href="/#/titulo/${it.id}" target="_blank" rel="noopener">Ver</a>
      </div>
    </div>`).join('') + (items.length > 300 ? `<p class="muted">Mostrando 300 de ${items.length}.</p>` : '');
    list.__items = new Map(items.map((i) => [i.id, i]));
  } catch (err) {
    list.innerHTML = `<p class="form-msg">${esc(err.message)}</p>`;
  }
}

$('#content-list').addEventListener('click', (e) => {
  const items = $('#content-list').__items;
  const link = e.target.closest('[data-link]');
  const edit = e.target.closest('[data-edit]');
  if (link) openLinkEditor(items.get(link.dataset.link));
  if (edit) openManualEditor(items.get(edit.dataset.edit));
});

/* ------------------------------------------------------------ editor: vincular a TMDB */
const dialog = $('#editor');
const form = $('#editor-form');
// Enter dentro de un campo no debe cerrar el diálogo sin guardar.
form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'cancel') e.preventDefault();
});

function previewHtml(p, { eyebrow = 'Previsualización' } = {}) {
  return `<div class="preview">
    ${p.poster ? `<img src="${esc(p.poster)}" alt="">` : '<span class="thumb-ph"></span>'}
    <div>
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h3>${esc(p.title || 'Sin título')}${p.year ? ` (${p.year})` : ''}</h3>
      ${p.meta ? `<p>${esc(p.meta)}</p>` : ''}
      ${p.overview ? `<p>${esc(p.overview.slice(0, 380))}${p.overview.length > 380 ? '…' : ''}</p>` : ''}
    </div>
  </div>`;
}

function openLinkEditor(item) {
  if (!status.tmdbConfigured) {
    flash('Para vincular títulos hace falta TMDB_API_KEY en el servidor. Mientras tanto puedes usar "Editar datos".', 'err');
    return;
  }
  const defType = item.type === 'tv' ? 'tv' : 'movie';
  form.innerHTML = `<h2>Vincular a TMDB</h2>
    ${previewHtml({ title: item.title || item.categories[0]?.channel, poster: item.poster, meta: `${TYPE[item.type]} · ${item.categories.map((c) => c.label).join(', ')}` }, { eyebrow: 'Título actual' })}
    <p class="muted small">Busca el título en <a class="btn-link" href="https://www.themoviedb.org/search?query=" target="_blank" rel="noopener">themoviedb.org</a> y pega aquí su URL o su ID numérico.</p>
    <div class="editor-row">
      <label class="field"><span>URL o ID de TMDB</span><input id="ref" type="text" required placeholder="https://www.themoviedb.org/movie/12345"></label>
      <label class="field"><span>Tipo (si pegas solo el ID)</span><select id="ref-type"><option value="movie"${defType === 'movie' ? ' selected' : ''}>Película</option><option value="tv"${defType === 'tv' ? ' selected' : ''}>Serie</option></select></label>
    </div>
    <div id="preview-box"></div>
    <p class="form-msg" id="editor-msg" role="alert"></p>
    <div class="editor-actions">
      <button class="btn btn-ghost" value="cancel" formnovalidate>Cancelar</button>
      <button class="btn btn-ghost" type="button" id="do-preview">Previsualizar</button>
      <button class="btn btn-primary" type="button" id="do-save" disabled>Guardar</button>
    </div>`;
  let preview = null;
  const msg = $('#editor-msg');
  $('#ref').addEventListener('input', () => {
    preview = null;
    $('#do-save').disabled = true;
    $('#preview-box').innerHTML = '';
  });
  $('#do-preview').addEventListener('click', async () => {
    msg.className = 'form-msg';
    msg.textContent = '';
    const ref = $('#ref').value.trim();
    if (!ref) {
      $('#ref').setAttribute('aria-invalid', 'true');
      msg.textContent = 'Indica la URL o el ID.';
      return;
    }
    $('#ref').removeAttribute('aria-invalid');
    try {
      preview = await api(`/api/admin/tmdb/preview?ref=${encodeURIComponent(ref)}&type=${$('#ref-type').value}&itemId=${item.id}`);
      const p = preview.preview;
      const meta = [TYPE[p.tmdbType], p.genres?.join(', '), p.numberOfSeasons ? `${p.numberOfSeasons} temporadas, ${p.numberOfEpisodes} episodios` : null, p.directors?.length ? `Dir.: ${p.directors.join(', ')}` : null].filter(Boolean).join(' · ');
      $('#preview-box').innerHTML = previewHtml({ title: p.title, year: p.year, poster: p.tmdbPosterUrl, overview: p.overview, meta })
        + (preview.conflict ? `<p class="warn-box">Este título ya existe en el catálogo como “${esc(preview.conflict.title)}”. Al guardar se fusionarán en uno solo (se conservan ambas apariciones en la cartelera).</p>` : '');
      $('#do-save').disabled = false;
      $('#do-save').textContent = preview.conflict ? 'Fusionar y guardar' : 'Guardar';
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  $('#do-save').addEventListener('click', async () => {
    if (!preview) return;
    try {
      await api(`/api/admin/items/${item.id}/link`, { method: 'POST', body: { ref: $('#ref').value.trim(), type: $('#ref-type').value, confirmMerge: Boolean(preview.conflict) } });
      dialog.close();
      flash(`“${preview.preview.title}” vinculado correctamente. Ya aparece así en la cartelera.`);
      loadContent();
      loadStatus();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  dialog.showModal();
  $('#ref').focus();
}

/* ------------------------------------------------------------ editor: datos manuales */
async function loadCatalogTitles() {
  if (catalogTitles) return catalogTitles;
  const res = await fetch('/api/catalog');
  const data = await res.json();
  catalogTitles = data.items.map((i) => ({ id: i.id, key: `${i.type}|${normalize(i.title)}|${i.year ?? ''}`, title: i.title }));
  return catalogTitles;
}

function openManualEditor(item) {
  form.innerHTML = `<h2>Editar datos del título</h2>
    <p class="muted small">Úsalo cuando el título no esté en TMDB o no haya clave configurada. Los datos manuales no se sobrescriben en las sincronizaciones.</p>
    <div class="editor-row">
      <label class="field"><span>Título *</span><input id="m-title" type="text" maxlength="200" required value="${esc(item.titleSource === 'manual' || item.identified ? item.title || '' : item.title || '')}"></label>
      <label class="field"><span>Año</span><input id="m-year" type="number" min="1888" max="${new Date().getFullYear() + 2}" value="${esc(item.year ?? '')}"></label>
    </div>
    <label class="field"><span>Tipo</span><input type="text" value="${esc(TYPE[item.type])} (lo determina la categoría de origen)" disabled></label>
    <label class="field"><span>Géneros (separados por comas)</span><input id="m-genres" type="text" value="${esc((item.genres || []).join(', '))}" placeholder="Acción, Comedia"></label>
    <label class="field"><span>Descripción</span><textarea id="m-overview" maxlength="4000">${esc(item.overview || '')}</textarea></label>
    <div id="m-preview"></div>
    <p class="form-msg" id="editor-msg" role="alert"></p>
    <div class="editor-actions">
      <button class="btn btn-ghost" value="cancel" formnovalidate>Cancelar</button>
      <button class="btn btn-primary" type="button" id="m-save">Guardar</button>
    </div>`;
  const read = () => ({
    title: $('#m-title').value.trim(),
    year: $('#m-year').value ? Number($('#m-year').value) : null,
    genres: $('#m-genres').value.split(',').map((g) => g.trim()).filter(Boolean),
    overview: $('#m-overview').value.trim(),
  });
  const refresh = async () => {
    const d = read();
    let dup = '';
    if (d.title) {
      const titles = await loadCatalogTitles().catch(() => []);
      const key = `${item.type}|${normalize(d.title)}|${d.year ?? ''}`;
      const other = titles.find((t) => t.key === key && t.id !== item.id);
      if (other) dup = `<p class="warn-box">Posible duplicado: ya existe “${esc(other.title)}”${d.year ? ` (${d.year})` : ''} en el catálogo.</p>`;
    }
    $('#m-preview').innerHTML = previewHtml({ title: d.title, year: d.year, poster: item.poster, overview: d.overview, meta: [TYPE[item.type], d.genres.join(', ')].filter(Boolean).join(' · ') }) + dup;
  };
  form.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('input', refresh));
  refresh();
  $('#m-save').addEventListener('click', async () => {
    const d = read();
    const msg = $('#editor-msg');
    const errors = [];
    $('#m-title').toggleAttribute('aria-invalid', !d.title);
    if (!d.title) errors.push('El título es obligatorio.');
    if (d.year && (d.year < 1888 || d.year > new Date().getFullYear() + 2)) errors.push('Año no válido.');
    if (errors.length) {
      msg.textContent = errors.join(' ');
      return;
    }
    try {
      await api(`/api/admin/items/${item.id}`, { method: 'PUT', body: d });
      dialog.close();
      flash(`“${d.title}” guardado correctamente.`);
      catalogTitles = null;
      loadContent();
      loadStatus();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  dialog.showModal();
  $('#m-title').focus();
}

/* ------------------------------------------------------------ arranque */
if (token) {
  loadStatus().then(enterApp).catch((err) => showLogin(err.message));
} else showLogin();
