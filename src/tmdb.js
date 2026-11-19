/**
 * Cliente de la API oficial de TMDB (https://developer.themoviedb.org/).
 * Es opcional: solo se usa si hay TMDB_API_KEY o TMDB_READ_TOKEN en el servidor.
 * La clave nunca se envía al navegador.
 */
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

/** Géneros de TMDB unificados en castellano (películas y series comparten nombres). */
const GENRES = {
  28: ['Acción'], 12: ['Aventura'], 16: ['Animación'], 35: ['Comedia'], 80: ['Crimen'],
  99: ['Documental'], 18: ['Drama'], 10751: ['Familia'], 14: ['Fantasía'], 36: ['Historia'],
  27: ['Terror'], 10402: ['Música'], 9648: ['Misterio'], 10749: ['Romance'], 878: ['Ciencia ficción'],
  10770: ['Película de TV'], 53: ['Suspense'], 10752: ['Bélica'], 37: ['Western'],
  10759: ['Acción', 'Aventura'], 10762: ['Infantil'], 10763: ['Noticias'], 10764: ['Reality'],
  10765: ['Ciencia ficción', 'Fantasía'], 10766: ['Telenovela'], 10767: ['Entrevistas'], 10768: ['Bélica', 'Política'],
};

export function mapGenres(genres = []) {
  const out = [];
  for (const g of genres) {
    for (const name of GENRES[g.id] || [g.name]) if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const img = (p, size) => (p ? `${IMG}/${size}${p}` : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearOf = (d) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

export function createTmdb({ apiKey = '', readToken = '', language = 'es-ES', fetchImpl = fetch, minIntervalMs = 40 } = {}) {
  const configured = Boolean(apiKey || readToken);
  let last = 0;
  let requests = 0;

  async function get(path, params = {}) {
    if (!configured) throw new Error('TMDB no configurado');
    const url = new URL(API + path);
    for (const [k, v] of Object.entries({ language, ...params })) if (v != null && v !== '') url.searchParams.set(k, v);
    if (apiKey && !readToken) url.searchParams.set('api_key', apiKey);
    const headers = { accept: 'application/json' };
    if (readToken) headers.authorization = `Bearer ${readToken}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      requests += 1;
      let res;
      try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        if (attempt === 3) throw new Error(`TMDB sin respuesta (${path}): ${err.message}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401) throw new Error('TMDB rechazó la clave (401). Revisa TMDB_API_KEY / TMDB_READ_TOKEN.');
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || attempt + 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new Error(`TMDB respondió ${res.status} en ${path}`);
    }
    throw new Error(`TMDB no disponible tras varios intentos (${path})`);
  }

  async function movie(id) {
    const d = await get(`/movie/${id}`, {
      append_to_response: 'credits,images',
      include_image_language: 'es,en,null',
    });
    if (!d) return null;
    return {
      tmdbType: 'movie',
      tmdbId: d.id,
      title: d.title || null,
      originalTitle: d.original_title || null,
      releaseDate: d.release_date || null,
      year: yearOf(d.release_date),
      overview: d.overview || null,
      genres: mapGenres(d.genres),
      originalLanguage: d.original_language || null,
      spokenLanguages: (d.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean),
      rating: d.vote_count ? d.vote_average : null,
      voteCount: d.vote_count ?? null,
      popularity: d.popularity ?? null,
      runtime: d.runtime || null,
      tmdbPosterUrl: img(d.poster_path, 'w500'),
      backdropUrl: img(d.backdrop_path, 'w1280'),
      images: (d.images?.backdrops || []).slice(0, 8).map((b) => img(b.file_path, 'w1280')),
      cast: (d.credits?.cast || []).slice(0, 15).map((c) => ({ name: c.name, character: c.character || null, photo: img(c.profile_path, 'w185') })),
      directors: [...new Set((d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name))],
      creators: [],
      seasons: [],
      numberOfSeasons: null,
      numberOfEpisodes: null,
      signature: null,
      externalUrl: `https://www.themoviedb.org/movie/${d.id}?language=es`,
    };
  }

  /**
   * @param previous datos ya guardados: si la firma de la serie no cambió, se reutilizan las temporadas
   *                 para no repetir peticiones.
   */
  async function tv(id, previous = null) {
    const d = await get(`/tv/${id}`, { append_to_response: 'aggregate_credits,images', include_image_language: 'es,en,null' });
    if (!d) return null;
    const signature = [d.number_of_seasons, d.number_of_episodes, d.last_air_date, d.last_episode_to_air?.id].join('|');
    let seasons = previous?.signature === signature && previous?.seasons?.length ? previous.seasons : null;
    if (!seasons) {
      seasons = [];
      const list = (d.seasons || []).filter((s) => s.episode_count > 0);
      list.sort((a, b) => (a.season_number === 0) - (b.season_number === 0) || a.season_number - b.season_number);
      for (const s of list) {
        const sd = await get(`/tv/${id}/season/${s.season_number}`);
        seasons.push({
          number: s.season_number,
          name: s.name || (s.season_number === 0 ? 'Especiales' : `Temporada ${s.season_number}`),
          airDate: s.air_date || null,
          poster: img(s.poster_path, 'w342'),
          overview: sd?.overview || s.overview || null,
          episodes: (sd?.episodes || []).map((e) => ({
            number: e.episode_number,
            name: e.name || null,
            airDate: e.air_date || null,
            overview: e.overview || null,
            runtime: e.runtime || null,
            still: img(e.still_path, 'w300'),
          })),
        });
      }
    }
    const cast = (d.aggregate_credits?.cast || []).slice(0, 15).map((c) => ({
      name: c.name,
      character: c.roles?.[0]?.character || null,
      photo: img(c.profile_path, 'w185'),
    }));
    return {
      tmdbType: 'tv',
      tmdbId: d.id,
      title: d.name || null,
      originalTitle: d.original_name || null,
      releaseDate: d.first_air_date || null,
      year: yearOf(d.first_air_date),
      overview: d.overview || null,
      genres: mapGenres(d.genres),
      originalLanguage: d.original_language || null,
      spokenLanguages: (d.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean),
      rating: d.vote_count ? d.vote_average : null,
      voteCount: d.vote_count ?? null,
      popularity: d.popularity ?? null,
      runtime: d.episode_run_time?.[0] || null,
      tmdbPosterUrl: img(d.poster_path, 'w500'),
      backdropUrl: img(d.backdrop_path, 'w1280'),
      images: (d.images?.backdrops || []).slice(0, 8).map((b) => img(b.file_path, 'w1280')),
      cast,
      directors: [],
      creators: (d.created_by || []).map((c) => c.name),
      seasons,
      numberOfSeasons: d.number_of_seasons ?? null,
      numberOfEpisodes: d.number_of_episodes ?? null,
      signature,
      externalUrl: `https://www.themoviedb.org/tv/${d.id}?language=es`,
    };
  }

  /**
   * Las páginas de películas de la fuente solo contienen el póster (sin título ni ID) y TMDB no permite
   * buscar por imagen. Se reúnen películas candidatas (estrenos en España de los últimos 2 años,
   * novedades internacionales, populares, infantiles) con su póster principal. Después, `moviePosters`
   * devuelve TODOS los pósters de una candidata (la fuente suele usar uno alternativo).
   * @returns {Promise<Map<number, string[]>>} id -> nombres de archivo de póster principal
   */
  async function discoverCandidates() {
    const out = new Map();
    const add = (results = []) => {
      for (const r of results) {
        if (!out.has(r.id)) out.set(r.id, []);
        if (r.poster_path) out.get(r.id).push(r.poster_path.replace(/^\//, ''));
      }
    };
    const day = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
    const lists = [
      ['/discover/movie', { language: 'es-ES', region: 'ES', 'release_date.gte': day(2 * 365 * 864e5), with_release_type: '2|3|4|5', sort_by: 'primary_release_date.desc' }, 100],
      ['/discover/movie', { language: 'en-US', 'primary_release_date.gte': day(3 * 365 * 864e5), sort_by: 'popularity.desc' }, 60],
      ['/discover/movie', { language: 'es-ES', with_genres: '16|10751', sort_by: 'vote_count.desc' }, 25],
    ];
    for (const lang of ['es-ES', 'en-US']) {
      lists.push(['/movie/now_playing', { language: lang, region: 'ES' }, 10]);
      lists.push(['/movie/upcoming', { language: lang, region: 'ES' }, 5]);
      lists.push(['/movie/popular', { language: lang }, 10]);
      lists.push(['/trending/movie/week', { language: lang }, 5]);
    }
    for (const [path, params, pages] of lists) {
      for (let page = 1; page <= pages; page++) {
        const data = await get(path, { ...params, page });
        add(data?.results);
        if (!data || page >= Math.min(data.total_pages || 1, 500)) break;
      }
    }
    return out;
  }

  async function moviePosters(id) {
    const d = await get(`/movie/${id}/images`, { language: null });
    return (d?.posters || []).map((p) => p.file_path.replace(/^\//, ''));
  }

  /** Igual que discoverCandidates, para series (las enlazadas a FilmAffinity solo traen el póster). */
  async function discoverTvCandidates() {
    const out = new Map();
    const day = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
    const lists = [
      ['/discover/tv', { language: 'es-ES', with_original_language: 'es', 'first_air_date.gte': day(5 * 365 * 864e5), sort_by: 'popularity.desc' }, 30],
      ['/discover/tv', { language: 'en-US', 'air_date.gte': day(2 * 365 * 864e5), sort_by: 'popularity.desc' }, 60],
      ['/tv/on_the_air', { language: 'es-ES' }, 10],
      ['/tv/popular', { language: 'es-ES' }, 10],
      ['/trending/tv/week', { language: 'es-ES' }, 5],
    ];
    for (const [path, params, pages] of lists) {
      for (let page = 1; page <= pages; page++) {
        const data = await get(path, { ...params, page });
        for (const r of data?.results || []) {
          if (!out.has(r.id)) out.set(r.id, []);
          if (r.poster_path) out.get(r.id).push(r.poster_path.replace(/^\//, ''));
        }
        if (!data || page >= Math.min(data.total_pages || 1, 500)) break;
      }
    }
    return out;
  }

  async function tvPosters(id) {
    const d = await get(`/tv/${id}/images`, { language: null });
    return (d?.posters || []).map((p) => p.file_path.replace(/^\//, ''));
  }

  return { configured, get, movie, tv, discoverCandidates, moviePosters, discoverTvCandidates, tvPosters, get requests() { return requests; } };
}

/** Acepta un ID numérico o una URL de TMDB y devuelve {type, id}. */
export function parseTmdbRef(ref, fallbackType = 'movie') {
  const s = String(ref || '').trim();
  const m = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(s);
  if (m) return { type: m[1].toLowerCase(), id: Number(m[2]) };
  if (/^\d+$/.test(s)) return { type: fallbackType === 'tv' ? 'tv' : 'movie', id: Number(s) };
  return null;
}
