import {
  buildIndex, search, applyFilters, sortItems, facets as computeFacets, featuredScore,
  DEFAULT_FILTERS, isFiltered, filtersToParams, paramsToFilters,
} from './search.js';

/* ------------------------------------------------------------------ utilidades */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PAGE_SIZE = 48;
const TYPE_LABEL = { movie: 'Película', tv: 'Serie', sala: 'Sala' };
const GENRE_ROWS = ['Acción', 'Comedia', 'Terror', 'Ciencia ficción', 'Drama', 'Documental', 'Animación', 'Aventura', 'Suspense', 'Romance', 'Crimen', 'Fantasía', 'Familia', 'Misterio'];
const SORTS = [
  { value: 'relevance', label: 'Relevancia', needs: 'query' },
  { value: 'recent', label: 'Añadidos recientemente' },
  { value: 'popular', label: 'Más populares', needs: 'popularity' },
  { value: 'rating', label: 'Mejor valorados', needs: 'ratings' },
  { value: 'az', label: 'Título (A-Z)' },
  { value: 'za', label: 'Título (Z-A)' },
  { value: 'year-desc', label: 'Año (más nuevos)', needs: 'years' },
  { value: 'year-asc', label: 'Año (más antiguos)', needs: 'years' },
];

let langNames;
try {
  langNames = new Intl.DisplayNames(['es'], { type: 'language' });
} catch {
  langNames = null;
}
const langName = (code) => {
  if (!code) return '';
  try {
    const n = langNames?.of(code);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
};
const fmtRuntime = (min) => (min ? (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${min} min`) : '');
const fmtDate = (iso, opts = { dateStyle: 'medium' }) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-ES', opts);
};
const fmtVotes = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} mil` : String(n));

/** URL de imagen de TMDB en el tamaño pedido (las demás se dejan como están). */
function imgUrl(url, size) {
  if (!url) return null;
  const m = /^https?:\/\/(?:media\.themoviedb\.org|image\.tmdb\.org)\/t\/p\/[^/]+\/([^/?#]+)$/.exec(url);
  return m ? `https://image.tmdb.org/t/p/${size}/${m[1]}` : url;
}
const isTmdbImg = (url) => /(?:media\.themoviedb\.org|image\.tmdb\.org)\/t\/p\//.test(url || '');

/* ------------------------------------------------------------------ estado */
const state = {
  catalog: null,
  items: [],
  byId: new Map(),
  index: null,
  facets: null,
  favorites: loadFavorites(),
  filters: { ...DEFAULT_FILTERS },
  results: [],
  shown: 0,
  scores: null,
  view: null, // 'home' | 'browse'
  routeKey: null,
  detailId: null,
  detailCache: new Map(),
  lastFocus: null,
  heroTimer: null,
  observer: null,
  fetchedAt: 0,
};

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem('cajon.milista') || '[]'));
  } catch {
    return new Set();
  }
}
function saveFavorites() {
  try {
    localStorage.setItem('cajon.milista', JSON.stringify([...state.favorites]));
  } catch {
    /* almacenamiento no disponible: la lista vive solo en esta sesión */
  }
}
function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  saveFavorites();
  document.querySelectorAll(`[data-fav="${id}"]`).forEach((b) => setFavButton(b, state.favorites.has(id)));
  if (state.view === 'browse' && state.filters.favorites) updateResults();
}
function setFavButton(btn, on) {
  btn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Quitar de Mi lista' : 'Añadir a Mi lista';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const text = btn.querySelector('.fav-text');
  if (text) text.textContent = on ? 'En Mi lista' : 'Mi lista';
}

/* ------------------------------------------------------------------ datos */
async function loadCatalog({ silent = false } = {}) {
  try {
    const res = await fetch('api/catalog', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.fetchedAt = Date.now();
    if (state.catalog && state.catalog.version === data.version) return false;
    state.catalog = data;
    state.items = data.items;
    state.byId = new Map(data.items.map((i) => [i.id, i]));
    state.index = buildIndex(data.items);
    state.facets = computeFacets(data.items.filter((i) => i.type !== 'sala'));
    state.detailCache.clear();
    renderSyncInfo();
    return true;
  } catch (err) {
    if (!silent) throw err;
    return false;
  }
}

function renderSyncInfo() {
  const el = $('#sync-info');
  const c = state.catalog;
  if (!c) return;
  const movies = c.items.filter((i) => i.type === 'movie').length;
  const series = c.items.filter((i) => i.type === 'tv').length;
  el.textContent = `${movies} películas y ${series} series · ${c.lastSyncAt ? `sincronizado con la cartelera original el ${fmtDate(c.lastSyncAt, { dateStyle: 'long', timeStyle: 'short' })}` : 'pendiente de la primera sincronización'}`;
}

/* ------------------------------------------------------------------ tarjetas */
function displayTitle(it) {
  return it.title || it.categories?.[0]?.channel || 'Título sin identificar';
}

function posterImg(it, { eager = false, sizes = '(max-width: 600px) 42vw, 190px' } = {}) {
  const alt = it.title ? `Póster de ${it.title}` : `Póster (${displayTitle(it)})`;
  if (!it.poster) return `<div class="poster-fallback" aria-hidden="true">${esc(displayTitle(it).slice(0, 2))}</div>`;
  const attrs = `alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="342" height="513"`;
  if (isTmdbImg(it.poster)) {
    return `<img class="poster" src="${esc(imgUrl(it.poster, 'w342'))}" srcset="${esc(imgUrl(it.poster, 'w185'))} 185w, ${esc(imgUrl(it.poster, 'w342'))} 342w, ${esc(imgUrl(it.poster, 'w500'))} 500w" sizes="${sizes}" ${attrs}>`;
  }
  return `<img class="poster" src="${esc(it.poster)}" ${attrs}>`;
}

function metaLine(it) {
  const parts = [];
  if (it.year) parts.push(it.year);
  if (it.genres?.length) parts.push(it.genres.slice(0, 2).join(', '));
  else if (!it.identified && it.type !== 'sala') parts.push(it.categories?.[0]?.label || TYPE_LABEL[it.type]);
  if (it.type === 'tv' && it.seasonsCount) parts.push(`${it.seasonsCount} temp.`);
  return parts.join(' · ');
}

/** Taquilla(s) donde está el título, p. ej. «Taquilla 5» (para buscarlo en la app de IPTV). */
function channelsOf(it) {
  return [...new Set((it.categories || []).map((c) => c.channel).filter(Boolean))];
}

function cardHtml(it, { eager = false } = {}) {
  const fav = state.favorites.has(it.id);
  const rating = it.rating != null ? `<span class="badge badge-rating" title="Valoración TMDB">★ ${it.rating.toFixed(1).replace('.', ',')}</span>` : '';
  const hover = it.overview
    ? `<div class="card-hover" aria-hidden="true"><p>${esc(it.overview)}</p></div>`
    : '';
  return `<article class="card" data-id="${it.id}">
    <a class="card-link" href="#/titulo/${it.id}">
      <div class="card-media">
        ${posterImg(it, { eager })}
        <span class="badge badge-type badge-${it.type}">${TYPE_LABEL[it.type]}</span>
        ${rating}
        ${channelsOf(it).length ? `<span class="badge badge-channel" title="Canal en la cartelera">${esc(channelsOf(it).join(' · '))}</span>` : ''}
        ${hover}
      </div>
      <div class="card-body">
        <h3 class="card-title${it.title ? '' : ' is-muted'}">${esc(displayTitle(it))}</h3>
        <p class="card-meta">${esc(metaLine(it))}</p>
      </div>
    </a>
    ${it.type !== 'sala' ? `<button class="card-fav" type="button" data-fav="${it.id}" aria-pressed="${fav}" aria-label="${fav ? 'Quitar de Mi lista' : 'Añadir a Mi lista'}" title="${fav ? 'Quitar de Mi lista' : 'Añadir a Mi lista'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg></button>` : ''}
  </article>`;
}

/* ------------------------------------------------------------------ rutas */
const PRESETS = {
  '/peliculas': { type: 'movie', title: 'Películas', nav: 'peliculas' },
  '/series': { type: 'tv', title: 'Series', nav: 'series' },
  '/infantiles': { category: 'infantiles', title: 'Infantiles', nav: 'infantiles' },
  '/mi-lista': { favorites: true, title: 'Mi lista', nav: 'mi-lista' },
  '/explorar': { title: 'Explorar', nav: null },
};

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
}

/** Elige la sección más clara para unos filtros (para el menú y la URL). */
function hrefFor(f) {
  let path = '/explorar';
  const p = filtersToParams(f);
  if (f.favorites) {
    path = '/mi-lista';
    p.delete('milista');
  } else if (f.category === 'infantiles' && f.type === 'all') {
    path = '/infantiles';
    p.delete('cat');
  } else if (f.type === 'movie' && !f.category) {
    path = '/peliculas';
    p.delete('tipo');
  } else if (f.type === 'tv' && !f.category) {
    path = '/series';
    p.delete('tipo');
  }
  const qs = p.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

function filtersFromRoute(path, params) {
  const preset = PRESETS[path] || PRESETS['/explorar'];
  const f = paramsToFilters(params);
  if (preset.type) f.type = preset.type;
  if (preset.category) f.category = preset.category;
  if (preset.favorites) f.favorites = true;
  return f;
}

function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) return;
  if (replace) {
    history.replaceState(history.state, '', hash);
    route();
  } else {
    location.hash = hash;
  }
}

function setActiveNav(key) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function route() {
  const { path, params } = parseHash();
  const detail = /^\/titulo\/([a-f0-9]{12})$/.exec(path);
  if (detail) {
    if (!state.view) renderHome();
    openDetail(detail[1]);
    return;
  }
  closeDetail({ fromRoute: true });

  if (path === '/' || path === '') {
    setActiveNav('home');
    syncSearchInput('');
    if (state.view !== 'home') renderHome();
    return;
  }
  const preset = PRESETS[path];
  if (!preset) {
    renderNotFound();
    return;
  }
  setActiveNav(preset.nav);
  const filters = filtersFromRoute(path, params);
  const key = `${path}|${hrefFor(filters)}`;
  // Al volver de una ficha la lista sigue intacta (misma posición de scroll y resultados cargados).
  if (state.view === 'browse' && state.browseKey === key) return;
  state.browseKey = key;
  state.filters = filters;
  syncSearchInput(state.filters.q);
  renderBrowse(path);
}

/* ------------------------------------------------------------------ búsqueda en cabecera */
const qInput = $('#q');
const qClear = $('#q-clear');

function syncSearchInput(q) {
  if (document.activeElement !== qInput) qInput.value = q || '';
  qClear.hidden = !qInput.value;
}

const runSearch = debounce((value) => {
  const onBrowse = state.view === 'browse';
  const base = onBrowse ? state.filters : { ...DEFAULT_FILTERS };
  const f = { ...base, q: value.trim() };
  if (f.q && (base.sort === 'recent' || !base.q)) f.sort = 'relevance';
  if (!f.q && f.sort === 'relevance') f.sort = 'recent';
  if (!f.q && !onBrowse) return;
  // Primera pulsación desde Inicio: entrada nueva en el historial (Atrás vuelve a Inicio).
  navigate(hrefFor(f), { replace: onBrowse });
}, 180);

qInput.addEventListener('input', () => {
  qClear.hidden = !qInput.value;
  runSearch(qInput.value);
});
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (qInput.value) {
      e.preventDefault();
      clearSearch();
    } else qInput.blur();
  }
});
$('#searchbox').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(qInput.value);
  qInput.blur();
});
qClear.addEventListener('click', () => {
  clearSearch();
  qInput.focus();
});
function clearSearch() {
  qInput.value = '';
  qClear.hidden = true;
  runSearch('');
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    qInput.focus();
    qInput.select();
  }
});

/* ------------------------------------------------------------------ portada */
function pickHero() {
  const pool = state.items.filter((i) => i.type !== 'sala');
  const withBackdrop = pool.filter((i) => i.backdrop && i.overview);
  const titled = pool.filter((i) => i.poster && i.title);
  const base = withBackdrop.length >= 3 ? withBackdrop : titled.length >= 3 ? titled : pool.filter((i) => i.poster);
  return sortItems(base, 'recent').slice(0, 30)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 5);
}

function heroSlideHtml(it, i) {
  const bg = it.backdrop ? imgUrl(it.backdrop, 'w1280') : imgUrl(it.poster, 'w780');
  const facts = [TYPE_LABEL[it.type], it.year, it.genres?.slice(0, 3).join(' · '), it.rating != null ? `★ ${it.rating.toFixed(1).replace('.', ',')}` : null].filter(Boolean);
  return `<div class="hero-slide${i === 0 ? ' is-active' : ''}" data-slide="${i}" ${i ? 'aria-hidden="true"' : ''}>
    <img class="hero-bg${it.backdrop ? '' : ' is-blurred'}" src="${esc(bg)}" alt="" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
    <div class="hero-content">
      ${it.backdrop ? '' : `<div class="hero-poster">${posterImg(it, { eager: i === 0, sizes: '220px' })}</div>`}
      <div class="hero-text">
        <p class="eyebrow">Novedad en ${esc(it.categories?.[0]?.label || 'la cartelera')}</p>
        <h2 class="hero-title">${esc(displayTitle(it))}</h2>
        <p class="hero-facts">${facts.map(esc).join('<span aria-hidden="true"> · </span>')}</p>
        ${it.overview ? `<p class="hero-overview">${esc(it.overview)}</p>` : ''}
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/titulo/${it.id}">Ver ficha</a>
          <button class="btn btn-ghost" type="button" data-fav="${it.id}" aria-pressed="${state.favorites.has(it.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><span class="fav-text">${state.favorites.has(it.id) ? 'En Mi lista' : 'Mi lista'}</span></button>
        </div>
      </div>
    </div>
  </div>`;
}

function rowHtml({ title, items, href, id, variant = '' }) {
  if (!items.length) return '';
  return `<section class="row ${variant}" aria-labelledby="row-${id}">
    <div class="row-head">
      <h2 id="row-${id}">${esc(title)}</h2>
      ${href ? `<a class="row-more" href="${href}">Ver todo <span aria-hidden="true">›</span></a>` : ''}
    </div>
    <div class="row-scroller">
      <button class="row-arrow prev" type="button" aria-label="Anteriores" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button>
      <div class="row-track">${items.map((it) => cardHtml(it)).join('')}</div>
      <button class="row-arrow next" type="button" aria-label="Siguientes" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
    </div>
  </section>`;
}

function renderHome() {
  state.view = 'home';
  stopHero();
  const items = state.items;
  const movies = items.filter((i) => i.type === 'movie');
  const series = items.filter((i) => i.type === 'tv');
  const salas = items.filter((i) => i.type === 'sala');
  const N = 20;
  const rows = [];

  const favs = items.filter((i) => state.favorites.has(i.id));
  if (favs.length) rows.push({ id: 'milista', title: 'Mi lista', items: favs.slice(0, N), href: '#/mi-lista' });
  rows.push({ id: 'ult-peliculas', title: 'Últimas películas añadidas', items: sortItems(movies.filter((m) => m.categories.some((c) => c.key === 'taquillas')), 'recent').slice(0, N), href: hrefFor({ ...DEFAULT_FILTERS, type: 'movie', sort: 'recent' }) });
  rows.push({ id: 'ult-series', title: 'Últimas series añadidas', items: sortItems(series, 'recent').slice(0, N), href: hrefFor({ ...DEFAULT_FILTERS, type: 'tv', sort: 'recent' }) });

  const featured = (list) => list.filter((i) => i.votes >= 30).sort((a, b) => featuredScore(b) - featuredScore(a)).slice(0, N);
  const fm = featured(movies);
  const fs = featured(series);
  if (fm.length >= 4) rows.push({ id: 'dest-peliculas', title: 'Películas destacadas', items: fm, href: hrefFor({ ...DEFAULT_FILTERS, type: 'movie', sort: 'rating' }) });
  if (fs.length >= 4) rows.push({ id: 'dest-series', title: 'Series destacadas', items: fs, href: hrefFor({ ...DEFAULT_FILTERS, type: 'tv', sort: 'rating' }) });

  rows.push({ id: 'infantiles', title: 'Infantiles', items: sortItems(items.filter((i) => i.categories.some((c) => c.key === 'infantiles')), 'recent').slice(0, N), href: '#/infantiles' });

  const genreCounts = new Map(state.facets.genres.map((g) => [g.name, g.count]));
  const genres = [...GENRE_ROWS.filter((g) => genreCounts.has(g)), ...state.facets.genres.map((g) => g.name).filter((g) => !GENRE_ROWS.includes(g))];
  for (const g of genres) {
    const list = items.filter((i) => i.genres?.includes(g));
    if (list.length < 4) continue;
    rows.push({ id: `g-${g}`, title: g, items: sortItems(list, 'popular').slice(0, N), href: hrefFor({ ...DEFAULT_FILTERS, genres: [g], sort: 'popular' }) });
  }
  if (salas.length) rows.push({ id: 'taquillazo', title: 'Salas del Taquillazo', items: salas, href: hrefFor({ ...DEFAULT_FILTERS, category: 'taquillazo' }), variant: 'row-salas' });

  const hero = pickHero();
  const main = $('#main');
  if (!items.length) {
    main.innerHTML = emptyHtml({ title: 'El catálogo todavía está vacío', text: 'La primera sincronización con la cartelera original aún no ha terminado. Vuelve a intentarlo en unos minutos.', action: '<button class="btn btn-primary" type="button" data-action="reload">Reintentar</button>' });
    return;
  }
  main.innerHTML = `
    ${hero.length ? `<section class="hero" aria-roledescription="carrusel" aria-label="Novedades">
      ${hero.map(heroSlideHtml).join('')}
      ${hero.length > 1 ? `<div class="hero-dots" role="tablist" aria-label="Elegir novedad">${hero.map((it, i) => `<button type="button" role="tab" aria-selected="${i === 0}" aria-label="${esc(displayTitle(it))}" data-dot="${i}"></button>`).join('')}</div>` : ''}
    </section>` : ''}
    <div class="quick-links" aria-label="Accesos rápidos">
      ${state.catalog.categories.filter((c) => c.count).map((c) => `<a class="pill" href="${hrefFor({ ...DEFAULT_FILTERS, category: c.key })}">${esc(c.label)} <span>${c.count}</span></a>`).join('')}
      ${genres.slice(0, 8).map((g) => `<a class="pill pill-soft" href="${hrefFor({ ...DEFAULT_FILTERS, genres: [g], sort: 'popular' })}">${esc(g)}</a>`).join('')}
    </div>
    ${rows.map(rowHtml).join('')}`;
  setupRows(main);
  startHero();
  main.focus({ preventScroll: true });
  if (!state.detailId) window.scrollTo({ top: 0 });
}

function setupRows(root) {
  root.querySelectorAll('.row-scroller').forEach((sc) => {
    const track = sc.querySelector('.row-track');
    const prev = sc.querySelector('.prev');
    const next = sc.querySelector('.next');
    const update = () => {
      prev.disabled = track.scrollLeft < 8;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
    };
    const step = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    track.addEventListener('scroll', debounce(update, 60), { passive: true });
    update();
  });
}

function showSlide(i) {
  const hero = $('.hero');
  if (!hero) return;
  hero.querySelectorAll('.hero-slide').forEach((s, n) => {
    s.classList.toggle('is-active', n === i);
    s.toggleAttribute('aria-hidden', n !== i);
  });
  hero.querySelectorAll('[data-dot]').forEach((d, n) => d.setAttribute('aria-selected', String(n === i)));
  hero.dataset.current = i;
}
function startHero() {
  const hero = $('.hero');
  if (!hero || reducedMotion.matches) return;
  const count = hero.querySelectorAll('.hero-slide').length;
  if (count < 2) return;
  const tick = () => {
    if (hero.matches(':hover, :focus-within') || document.hidden) return;
    showSlide(((Number(hero.dataset.current) || 0) + 1) % count);
  };
  state.heroTimer = setInterval(tick, 8000);
}
function stopHero() {
  clearInterval(state.heroTimer);
  state.heroTimer = null;
}

/* ------------------------------------------------------------------ explorar / filtros */
function optionList(values, selected) {
  return values.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function renderBrowse(path) {
  const fresh = state.view !== 'browse' || state.routeKey !== path;
  stopHero();
  state.view = 'browse';
  state.routeKey = path;
  const preset = PRESETS[path] || PRESETS['/explorar'];
  const fx = state.facets;
  const f = state.filters;

  if (fresh) {
    const wide = matchMedia('(min-width: 900px)').matches;
    const years = fx.years;
    $('#main').innerHTML = `<section class="browse">
      <header class="browse-head">
        <div>
          <h1 id="browse-title">${esc(preset.title)}</h1>
          <p class="browse-count" id="browse-count" aria-live="polite"></p>
        </div>
        <label class="sort-field">
          <span>Ordenar por</span>
          <select id="f-sort"></select>
        </label>
      </header>

      <div class="toolbar">
        <div class="seg" role="group" aria-label="Tipo de contenido">
          <button type="button" data-type="all">Todo</button>
          <button type="button" data-type="movie">Películas</button>
          <button type="button" data-type="tv">Series</button>
        </div>
        <button class="btn btn-ghost filters-toggle" type="button" id="filters-toggle" aria-expanded="${wide}" aria-controls="filters-panel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
          Filtros <span class="count-badge" id="filters-count" hidden></span>
        </button>
        <button class="btn btn-link" type="button" id="f-clear" hidden>Limpiar filtros</button>
      </div>

      <div class="filters-panel" id="filters-panel" ${wide ? '' : 'hidden'}>
        <div class="filters-grid">
          <label class="field"><span>Categoría</span>
            <select id="f-cat">${optionList([['', 'Todas'], ...state.catalog.categories.filter((c) => c.count).map((c) => [c.key, `${c.label} (${c.count})`])], f.category)}</select>
          </label>
          ${years.length ? `<label class="field"><span>Año desde</span>
            <select id="f-from">${optionList([['', 'Cualquiera'], ...[...years].reverse().map((y) => [y, y])], f.yearFrom ?? '')}</select></label>
          <label class="field"><span>Año hasta</span>
            <select id="f-to">${optionList([['', 'Cualquiera'], ...years.map((y) => [y, y])], f.yearTo ?? '')}</select></label>` : ''}
          ${fx.languages.length ? `<label class="field"><span>Idioma original</span>
            <select id="f-lang">${optionList([['', 'Todos'], ...fx.languages.map((l) => [l.code, `${langName(l.code)} (${l.count})`])], f.lang)}</select></label>` : ''}
          ${fx.hasRatings ? `<label class="field"><span>Valoración mínima</span>
            <select id="f-rating">${optionList([[0, 'Cualquiera'], [5, '5 o más'], [6, '6 o más'], [7, '7 o más'], [8, '8 o más']], f.minRating)}</select></label>` : ''}
        </div>
        ${fx.genres.length ? `<fieldset class="genre-field"><legend>Géneros</legend>
          <div class="chips" id="f-genres">${fx.genres.map((g) => `<button type="button" class="chip" data-genre="${esc(g.name)}" aria-pressed="false">${esc(g.name)}</button>`).join('')}</div>
        </fieldset>` : `<p class="filters-note">Los filtros de género, año, idioma y valoración aparecen cuando el catálogo dispone de esos datos.</p>`}
      </div>

      <div class="active-filters" id="active-filters"></div>
      <div class="grid" id="grid" aria-live="off"></div>
      <div class="grid-footer">
        <div class="sentinel" id="sentinel" aria-hidden="true"></div>
        <button class="btn btn-ghost" type="button" id="load-more" hidden>Mostrar más</button>
      </div>
      <div id="empty"></div>
    </section>`;
    bindBrowse();
    window.scrollTo({ top: 0 });
  }
  syncControls();
  updateResults();
}

function bindBrowse() {
  const main = $('#main');
  const commit = (patch) => {
    const f = { ...state.filters, ...patch };
    navigate(hrefFor(f), { replace: true });
  };
  main.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => commit({ type: b.dataset.type })));
  $('#f-sort').addEventListener('change', (e) => commit({ sort: e.target.value }));
  $('#f-cat').addEventListener('change', (e) => commit({ category: e.target.value }));
  $('#f-from')?.addEventListener('change', (e) => commit({ yearFrom: Number(e.target.value) || null }));
  $('#f-to')?.addEventListener('change', (e) => commit({ yearTo: Number(e.target.value) || null }));
  $('#f-lang')?.addEventListener('change', (e) => commit({ lang: e.target.value }));
  $('#f-rating')?.addEventListener('change', (e) => commit({ minRating: Number(e.target.value) || 0 }));
  $('#f-genres')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-genre]');
    if (!chip) return;
    const g = chip.dataset.genre;
    const set = new Set(state.filters.genres);
    if (set.has(g)) set.delete(g);
    else set.add(g);
    commit({ genres: [...set] });
  });
  $('#f-clear').addEventListener('click', clearFilters);
  $('#filters-toggle').addEventListener('click', (e) => {
    const panel = $('#filters-panel');
    const open = panel.hidden;
    panel.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $('#active-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const [key, value] = b.dataset.remove.split(':');
    const patch = {
      q: { q: '', sort: state.filters.sort === 'relevance' ? 'recent' : state.filters.sort },
      type: { type: 'all' },
      category: { category: '' },
      genre: { genres: state.filters.genres.filter((g) => g !== value) },
      year: { yearFrom: null, yearTo: null },
      lang: { lang: '' },
      rating: { minRating: 0 },
    }[key];
    if (key === 'q') syncSearchInput('');
    commit(patch);
  });
  $('#load-more').addEventListener('click', () => renderMore());
  state.observer?.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { rootMargin: '800px 0px' });
  state.observer.observe($('#sentinel'));
}

function presetLocks() {
  const path = state.routeKey;
  return { type: path === '/peliculas' || path === '/series', category: path === '/infantiles', favorites: path === '/mi-lista' };
}

function clearFilters() {
  const locks = presetLocks();
  const f = { ...DEFAULT_FILTERS };
  if (locks.type) f.type = state.filters.type;
  if (locks.category) f.category = state.filters.category;
  if (locks.favorites) f.favorites = true;
  syncSearchInput('');
  qInput.value = '';
  qClear.hidden = true;
  navigate(hrefFor(f), { replace: true });
}

function syncControls() {
  const f = state.filters;
  const fx = state.facets;
  const needs = { query: Boolean(f.q), popularity: fx.hasPopularity, ratings: fx.hasRatings, years: fx.years.length > 0 };
  const sorts = SORTS.filter((s) => !s.needs || needs[s.needs]);
  if (!sorts.some((s) => s.value === f.sort)) f.sort = f.q ? 'relevance' : 'recent';
  $('#f-sort').innerHTML = optionList(sorts.map((s) => [s.value, s.label]), f.sort);
  document.querySelectorAll('[data-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === f.type)));
  const set = (sel, v) => {
    const el = $(sel);
    if (el) el.value = v ?? '';
  };
  set('#f-cat', f.category);
  set('#f-from', f.yearFrom ?? '');
  set('#f-to', f.yearTo ?? '');
  set('#f-lang', f.lang);
  set('#f-rating', f.minRating || 0);
  document.querySelectorAll('[data-genre]').forEach((c) => c.setAttribute('aria-pressed', String(f.genres.includes(c.dataset.genre))));

  const locks = presetLocks();
  const chips = [];
  if (f.q) chips.push(['q', `“${f.q}”`]);
  if (f.type !== 'all' && !locks.type) chips.push(['type', f.type === 'movie' ? 'Películas' : 'Series']);
  if (f.category && !locks.category) chips.push(['category', state.catalog.categories.find((c) => c.key === f.category)?.label || f.category]);
  for (const g of f.genres) chips.push([`genre:${g}`, g]);
  if (f.yearFrom || f.yearTo) chips.push(['year', f.yearFrom && f.yearTo ? `${f.yearFrom}–${f.yearTo}` : f.yearFrom ? `Desde ${f.yearFrom}` : `Hasta ${f.yearTo}`]);
  if (f.lang) chips.push(['lang', langName(f.lang)]);
  if (f.minRating) chips.push(['rating', `★ ${f.minRating}+`]);
  $('#active-filters').innerHTML = chips.map(([k, label]) => `<button type="button" class="chip chip-active" data-remove="${esc(k)}" aria-label="Quitar filtro ${esc(label)}">${esc(label)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`).join('');
  const panelFilters = (f.category && !locks.category ? 1 : 0) + f.genres.length + (f.yearFrom || f.yearTo ? 1 : 0) + (f.lang ? 1 : 0) + (f.minRating ? 1 : 0);
  const badge = $('#filters-count');
  badge.hidden = !panelFilters;
  badge.textContent = panelFilters;
  $('#f-clear').hidden = chips.length === 0;
  const title = f.q ? `Resultados para “${f.q}”` : (PRESETS[state.routeKey] || PRESETS['/explorar']).title;
  $('#browse-title').textContent = title;
  document.title = `${title} · Cajón de Contenidos`;
}

function updateResults() {
  const f = state.filters;
  const scores = f.q ? search(state.index, f.q) : null;
  const base = state.items.filter((i) => i.type !== 'sala' || f.category === 'taquillazo' || f.q);
  const filtered = applyFilters(base, f, { scores, favorites: state.favorites });
  state.scores = scores;
  state.results = sortItems(filtered, f.sort, scores);
  state.shown = 0;
  $('#grid').innerHTML = '';
  const n = state.results.length;
  $('#browse-count').textContent = n === 1 ? '1 título' : `${n.toLocaleString('es-ES')} títulos`;
  const empty = $('#empty');
  if (!n) {
    empty.innerHTML = f.favorites && !isFiltered({ ...f, favorites: false })
      ? emptyHtml({ title: 'Tu lista está vacía', text: 'Pulsa el corazón de cualquier película o serie para guardarla aquí. Se guarda en este navegador.', action: '<a class="btn btn-primary" href="#/">Explorar la cartelera</a>' })
      : emptyHtml({
        title: f.q ? `No hay resultados para “${f.q}”` : 'Ningún título coincide con estos filtros',
        text: f.q ? 'Revisa la ortografía, prueba con menos palabras o busca por el título original.' : 'Prueba a quitar alguno de los filtros activos.',
        action: '<button class="btn btn-primary" type="button" data-action="clear-filters">Limpiar búsqueda y filtros</button>',
      });
  } else empty.innerHTML = '';
  renderMore();
}

function renderMore() {
  if (state.view !== 'browse') return;
  const next = state.results.slice(state.shown, state.shown + PAGE_SIZE);
  if (!next.length) {
    $('#load-more').hidden = true;
    return;
  }
  $('#grid').insertAdjacentHTML('beforeend', next.map((it, i) => cardHtml(it, { eager: state.shown === 0 && i < 6 })).join(''));
  state.shown += next.length;
  $('#load-more').hidden = state.shown >= state.results.length;
}

function emptyHtml({ title, text, action = '' }) {
  return `<div class="empty-state">
    <svg viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="14" width="48" height="36" rx="6"/><path d="M8 24h48M20 14l-4 10M34 14l-4 10M48 14l-4 10"/></svg>
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${action}
  </div>`;
}

function renderNotFound() {
  state.view = 'notfound';
  setActiveNav(null);
  $('#main').innerHTML = emptyHtml({ title: 'Página no encontrada', text: 'Esta dirección no existe en la cartelera.', action: '<a class="btn btn-primary" href="#/">Volver al inicio</a>' });
}

/* ------------------------------------------------------------------ ficha */
const detailEl = $('#detail');

function openDetail(id) {
  const it = state.byId.get(id);
  if (state.detailId !== id) {
    if (!state.detailId) state.lastFocus = document.activeElement;
    state.detailId = id;
    detailEl.hidden = false;
    document.documentElement.classList.add('has-modal');
    detailEl.innerHTML = it ? detailHtml(it, { loading: true }) : `<div class="detail-sheet"><div class="detail-loading"><span class="spinner"></span>Cargando ficha…</div></div>`;
    bindDetail();
    requestAnimationFrame(() => detailEl.classList.add('is-open'));
    $('.detail-close', detailEl)?.focus({ preventScroll: true });
  }
  loadDetail(id);
}

async function loadDetail(id) {
  try {
    let data = state.detailCache.get(id);
    if (!data) {
      const res = await fetch(`api/items/${id}`);
      if (res.status === 404) throw Object.assign(new Error('Este título ya no está en la cartelera.'), { notFound: true });
      if (!res.ok) throw new Error('No se pudo cargar la ficha. Comprueba la conexión e inténtalo de nuevo.');
      data = await res.json();
      state.detailCache.set(id, data);
    }
    if (state.detailId !== id) return;
    const scroll = $('.detail-sheet', detailEl)?.scrollTop || 0;
    detailEl.innerHTML = detailHtml(data);
    bindDetail();
    $('.detail-sheet', detailEl).scrollTop = scroll;
    $('.detail-close', detailEl)?.focus({ preventScroll: true });
    document.title = `${displayTitle(data)} · Cajón de Contenidos`;
  } catch (err) {
    if (state.detailId !== id) return;
    const sheet = $('.detail-body', detailEl) || $('.detail-sheet', detailEl);
    sheet.insertAdjacentHTML('afterbegin', `<div class="notice notice-error" role="alert">${esc(err.message)} ${err.notFound ? '' : '<button class="btn btn-link" type="button" data-action="retry-detail">Reintentar</button>'}</div>`);
    sheet.querySelector('.detail-loading')?.remove();
  }
}

function factList(it) {
  const facts = [];
  if (it.year) facts.push(String(it.year));
  if (it.type === 'movie' && it.runtime) facts.push(fmtRuntime(it.runtime));
  if (it.type === 'tv' && it.seasonsCount) facts.push(`${it.seasonsCount} ${it.seasonsCount === 1 ? 'temporada' : 'temporadas'}`);
  if (it.type === 'tv' && it.episodesCount) facts.push(`${it.episodesCount} episodios`);
  if (it.type === 'tv' && it.runtime) facts.push(`${it.runtime} min/ep.`);
  if (it.language) facts.push(langName(it.language));
  return facts;
}

function whereHtml(it) {
  if (!it.categories?.length) {
    return `<div class="where where-off"><strong>Ya no aparece en la cartelera original.</strong><span>Se mantiene la ficha por si vuelve a publicarse.</span></div>`;
  }
  return `<div class="where">
    <h3>Dónde está en la cartelera</h3>
    <ul>${it.categories.map((c) => `<li>
      <span class="where-cat">${esc(c.label)}</span>
      ${c.channel ? `<span class="where-channel">${c.channelUrl ? `<img src="${esc(c.channelUrl)}" alt="" loading="lazy" decoding="async">` : ''}${esc(c.channel)}</span>` : ''}
    </li>`).join('')}</ul>
  </div>`;
}

function detailHtml(it, { loading = false } = {}) {
  const fav = state.favorites.has(it.id);
  const facts = factList(it);
  const bg = it.backdrop ? imgUrl(it.backdrop, 'w1280') : it.poster ? imgUrl(it.poster, 'w780') : '';
  const people = [];
  if (it.directors?.length) people.push(['Dirección', it.directors.join(', ')]);
  if (it.creators?.length) people.push(['Creación', it.creators.join(', ')]);
  const cast = Array.isArray(it.cast) ? it.cast : [];
  const extLabel = /filmaffinity/.test(it.externalUrl || '') ? 'FilmAffinity' : 'TMDB';
  return `<div class="detail-scrim" data-action="close"></div>
  <div class="detail-sheet">
    <button class="detail-close" type="button" data-action="close" aria-label="Cerrar ficha y volver"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <div class="detail-top">
      ${bg ? `<img class="detail-bg${it.backdrop ? '' : ' is-blurred'}" src="${esc(bg)}" alt="" decoding="async">` : ''}
      <div class="detail-hero">
        <div class="detail-poster">${posterImg(it, { eager: true, sizes: '(max-width: 700px) 40vw, 260px' })}</div>
        <div class="detail-head">
          <p class="eyebrow">${esc(TYPE_LABEL[it.type])}${it.categories?.length ? ` · ${esc(it.categories.map((c) => c.label).join(', '))}` : ''}</p>
          ${channelsOf(it).length ? `<p class="detail-channel" title="Búscalo con este nombre en tu aplicación de IPTV">${channelsOf(it).map((ch) => `<span>${esc(ch)}</span>`).join('')}</p>` : ''}
          <h1 id="detail-title" class="${it.title ? '' : 'is-muted'}">${esc(displayTitle(it))}</h1>
          ${it.originalTitle ? `<p class="detail-original">Título original: <i>${esc(it.originalTitle)}</i></p>` : ''}
          ${facts.length || it.rating != null ? `<ul class="facts">
            ${it.rating != null ? `<li class="fact-rating" title="Valoración media en TMDB">★ ${it.rating.toFixed(1).replace('.', ',')}${it.votes ? ` <small>(${fmtVotes(it.votes)} votos)</small>` : ''}</li>` : ''}
            ${facts.map((x) => `<li>${esc(x)}</li>`).join('')}
          </ul>` : ''}
          ${it.genres?.length ? `<ul class="chips chips-static">${it.genres.map((g) => `<li><a class="chip" href="${hrefFor({ ...DEFAULT_FILTERS, genres: [g], sort: 'popular' })}">${esc(g)}</a></li>`).join('')}</ul>` : ''}
          <div class="detail-actions">
            ${it.type !== 'sala' ? `<button class="btn btn-primary" type="button" data-fav="${it.id}" aria-pressed="${fav}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><span class="fav-text">${fav ? 'En Mi lista' : 'Mi lista'}</span></button>` : ''}
            ${it.externalUrl ? `<a class="btn btn-ghost" href="${esc(it.externalUrl)}" target="_blank" rel="noopener noreferrer">Ficha en ${extLabel} <span aria-hidden="true">↗</span></a>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="detail-body">
      ${loading ? '<div class="detail-loading"><span class="spinner"></span>Cargando ficha completa…</div>' : ''}
      ${!loading && !it.identified && it.type !== 'sala' ? `<p class="notice">La cartelera original solo publica el póster de este título${it.titleSource === 'slug' ? ' y su enlace' : ''}. Cuando se identifique, aquí aparecerán la sinopsis, el reparto y el resto de datos.</p>` : ''}
      <div class="detail-columns">
        <div class="detail-main">
          ${it.overview ? `<section><h2>Sinopsis</h2><p class="overview">${esc(it.overview)}</p></section>` : ''}
          ${people.length ? `<section><dl class="people">${people.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>` : ''}
          ${cast.length && typeof cast[0] === 'object' ? `<section><h2>Reparto</h2><ul class="cast">${cast.map((c) => `<li>
              ${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy" decoding="async" width="185" height="278">` : `<span class="cast-ph" aria-hidden="true">${esc(c.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</span>`}
              <strong>${esc(c.name)}</strong>${c.character ? `<span>${esc(c.character)}</span>` : ''}
            </li>`).join('')}</ul></section>` : ''}
          ${it.type === 'tv' && it.seasons?.length ? seasonsHtml(it) : ''}
          ${it.type === 'tv' && !loading && !it.seasons?.length && it.identified ? '<p class="muted">No hay información de temporadas disponible.</p>' : ''}
        </div>
        <aside class="detail-side">${whereHtml(it)}</aside>
      </div>
    </div>
  </div>`;
}

function seasonsHtml(it) {
  const seasons = it.seasons;
  return `<section class="seasons" data-seasons>
    <div class="seasons-head">
      <h2>Temporadas y episodios</h2>
      <label class="season-select"><span class="sr-only">Temporada</span>
        <select data-season-select>${seasons.map((s, i) => `<option value="${i}">${esc(s.name)}${s.episodes.length ? ` · ${s.episodes.length} ep.` : ''}</option>`).join('')}</select>
      </label>
    </div>
    ${seasons.map((s, i) => `<div class="season" data-season="${i}" ${i ? 'hidden' : ''}>
      ${s.overview ? `<p class="season-overview">${esc(s.overview)}</p>` : ''}
      ${s.episodes.length ? `<ol class="episodes">${s.episodes.map((e) => `<li class="episode">
        <div class="episode-still">${e.still ? `<img src="${esc(e.still)}" alt="" loading="lazy" decoding="async" width="300" height="169">` : ''}<span class="episode-num">${e.number}</span></div>
        <div class="episode-info">
          <h3>${e.number}. ${esc(e.name || `Episodio ${e.number}`)}</h3>
          <p class="episode-meta">${[fmtDate(e.airDate), e.runtime ? `${e.runtime} min` : ''].filter(Boolean).map(esc).join(' · ')}</p>
          ${e.overview ? `<p class="episode-overview">${esc(e.overview)}</p>` : ''}
        </div>
      </li>`).join('')}</ol>` : '<p class="muted">Sin episodios publicados todavía.</p>'}
    </div>`).join('')}
  </section>`;
}

function bindDetail() {
  const sel = detailEl.querySelector('[data-season-select]');
  sel?.addEventListener('change', () => {
    detailEl.querySelectorAll('[data-season]').forEach((s) => (s.hidden = s.dataset.season !== sel.value));
  });
}

function closeDetail({ fromRoute = false } = {}) {
  if (!state.detailId) return;
  state.detailId = null;
  detailEl.classList.remove('is-open');
  document.documentElement.classList.remove('has-modal');
  const done = () => {
    if (!state.detailId) {
      detailEl.hidden = true;
      detailEl.innerHTML = '';
    }
  };
  if (reducedMotion.matches) done();
  else setTimeout(done, 200);
  state.lastFocus?.focus?.({ preventScroll: true });
  if (!fromRoute) {
    if (history.state?.inApp) history.back();
    else navigate(state.view === 'browse' ? hrefFor(state.filters) : '#/');
  }
}

/* ------------------------------------------------------------------ eventos globales */
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.preventDefault();
    toggleFavorite(fav.dataset.fav);
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') closeDetail();
  else if (action === 'clear-filters') clearFilters();
  else if (action === 'reload') location.reload();
  else if (action === 'retry-detail' && state.detailId) loadDetail(state.detailId);
  const dot = e.target.closest('[data-dot]');
  if (dot) showSlide(Number(dot.dataset.dot));
});

window.addEventListener('hashchange', () => {
  // Una ficha abierta desde la propia web se cierra con "Atrás" y se vuelve exactamente al punto anterior.
  if (/^#\/titulo\//.test(location.hash) && history.state === null) history.replaceState({ inApp: true }, '');
  route();
});

document.addEventListener('keydown', (e) => {
  if (!state.detailId) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDetail();
  } else if (e.key === 'Tab') {
    const focusables = [...detailEl.querySelectorAll('a[href], button:not([disabled]), select, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// Imágenes rotas: se sustituyen por un marcador limpio en lugar del icono roto del navegador.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('poster')) {
    const ph = document.createElement('div');
    ph.className = 'poster-fallback';
    ph.textContent = (img.closest('.card')?.querySelector('.card-title')?.textContent || '').slice(0, 2);
    img.replaceWith(ph);
  } else img.style.visibility = 'hidden';
}, true);

// Cambios en el catálogo: al volver a la pestaña se comprueba si hubo una sincronización (304 si no).
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || Date.now() - state.fetchedAt < 5 * 60_000) return;
  if (await loadCatalog({ silent: true })) {
    if (state.view === 'home' && !state.detailId) renderHome();
    else if (state.view === 'browse') updateResults();
  }
});

window.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('is-scrolled', window.scrollY > 8);
}, { passive: true });

/* ------------------------------------------------------------------ arranque */
async function boot() {
  try {
    await loadCatalog();
  } catch (err) {
    console.warn('No se pudo cargar el catálogo:', err.message);
    $('#main').innerHTML = emptyHtml({
      title: 'No se pudo cargar la cartelera',
      text: 'El servidor no responde o no hay conexión. Comprueba tu conexión e inténtalo de nuevo.',
      action: '<button class="btn btn-primary" type="button" data-action="reload">Reintentar</button>',
    });
    return;
  }
  route();
}
boot();
