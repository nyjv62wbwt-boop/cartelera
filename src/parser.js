/**
 * Parser de las páginas de la cartelera original.
 *
 * Estructura real comprobada (nov. 2026): cada título es
 *   <div class="movie"><a href="ENLACE" target="_blank"><img src="POSTER" alt="TEXTO"></a></div>
 * - taquillas / infantiles: ENLACE = imagen del "ticket" del canal (logostaquillas/taquillaN.png),
 *   POSTER = póster de TMDB. No hay título ni ID en el HTML.
 * - series: ENLACE = ficha de TMDB (/tv/ID-slug) o de FilmAffinity (filmXXXX.html).
 * - taquillazo: salas (canales) con logotipo propio, no son películas.
 */
import { createHash } from 'node:crypto';

const ANCHOR_IMG_RE = /<a\s[^>]*?href\s*=\s*"([^"]+)"[^>]*>\s*<img\s([^>]*?)\/?>/gi;
const ATTR_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Devuelve el nombre de archivo de una imagen de TMDB, o null si no es de TMDB. */
export function tmdbImageFile(url) {
  const m = /^https?:\/\/(?:media\.themoviedb\.org|image\.tmdb\.org|www\.themoviedb\.org)\/t\/p\/[^/]+\/([^/?#]+)$/i.exec(url || '');
  return m ? m[1] : null;
}

/** Título legible a partir del slug de una URL de TMDB ("273918-yo-siempre-a-veces" -> "Yo siempre a veces"). */
export function titleFromSlug(slug) {
  if (!slug) return null;
  const words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function parseLink(href) {
  let m = /themoviedb\.org\/(tv|movie)\/(\d+)(?:-([^?#/]+))?/i.exec(href);
  if (m) return { kind: 'tmdb', tmdbType: m[1].toLowerCase(), tmdbId: Number(m[2]), slug: m[3] || null };
  m = /filmaffinity\.com\/[a-z]{2}\/film(\d+)\.html/i.exec(href);
  if (m) return { kind: 'filmaffinity', filmaffinityId: m[1] };
  m = /\/(taquilla\d*)\.(?:png|jpe?g|webp|gif)$/i.exec(href);
  if (m) return { kind: 'ticket', ticket: m[1].toLowerCase() };
  return { kind: 'other' };
}

const stableId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 12);

function channelLabel(category, ticket) {
  const n = /taquilla(\d*)/.exec(ticket)?.[1] ?? '';
  const base = category === 'infantiles' ? 'Taquilla infantil' : 'Taquilla';
  return n === '' ? base : `${base} ${n}`;
}

/**
 * Extrae los títulos de una página de categoría.
 * @returns {{entries: object[], duplicates: number}}
 */
export function parseCategoryPage(html, category) {
  const start = html.search(/class\s*=\s*"movies"/i);
  const body = start >= 0 ? html.slice(start) : html;
  const entries = [];
  const seen = new Set();
  let duplicates = 0;
  let position = 0;

  for (const m of body.matchAll(ANCHOR_IMG_RE)) {
    const href = decodeEntities(m[1].trim());
    const imgAttrs = m[2];
    const img = decodeEntities(ATTR_RE('src').exec(imgAttrs)?.[1]?.trim() || '');
    const alt = decodeEntities(ATTR_RE('alt').exec(imgAttrs)?.[1]?.trim() || '');
    if (!img) continue;
    position += 1;

    const link = parseLink(href);
    const posterFile = tmdbImageFile(img);
    const entry = {
      category: category.key,
      position,
      href,
      img,
      alt,
      type: category.itemType,
      sourceKey: null,
      tmdbType: null,
      tmdbId: null,
      filmaffinityId: null,
      slugTitle: null,
      channelLabel: null,
      channelUrl: null,
      externalUrl: null,
      posterUrl: img,
    };

    if (category.itemType === 'tv') {
      if (link.kind === 'tmdb') {
        entry.type = link.tmdbType === 'movie' ? 'movie' : 'tv';
        entry.tmdbType = link.tmdbType;
        entry.tmdbId = link.tmdbId;
        entry.slugTitle = titleFromSlug(link.slug);
        entry.sourceKey = `tmdb:${link.tmdbType}:${link.tmdbId}`;
        entry.externalUrl = `https://www.themoviedb.org/${link.tmdbType}/${link.tmdbId}?language=es`;
      } else if (link.kind === 'filmaffinity') {
        entry.filmaffinityId = link.filmaffinityId;
        entry.sourceKey = `fa:${link.filmaffinityId}`;
        entry.externalUrl = `https://www.filmaffinity.com/es/film${link.filmaffinityId}.html`;
      } else {
        entry.sourceKey = posterFile ? `poster:${posterFile}` : `img:${img}`;
      }
    } else if (category.itemType === 'movie') {
      // El póster es lo único que identifica la película de forma estable.
      entry.sourceKey = posterFile ? `poster:${posterFile}` : `img:${img}`;
      if (link.kind === 'ticket') {
        entry.channelLabel = channelLabel(category.key, link.ticket);
        entry.channelUrl = href;
      } else if (link.kind === 'tmdb') {
        entry.tmdbType = link.tmdbType;
        entry.tmdbId = link.tmdbId;
        entry.slugTitle = titleFromSlug(link.slug);
        entry.externalUrl = href;
      }
    } else {
      // Salas del Taquillazo: canales en directo identificados por su logotipo.
      entry.sourceKey = `sala:${category.key}:${img.split('/').pop()}`;
      entry.channelLabel = alt || `Sala ${position}`;
      entry.channelUrl = href;
      entry.slugTitle = alt || `Sala ${position}`;
    }

    entry.id = stableId(entry.sourceKey);
    if (seen.has(entry.sourceKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(entry.sourceKey);
    entries.push(entry);
  }
  return { entries, duplicates };
}

export { stableId };
