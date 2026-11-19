import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { CATEGORIES } from '../src/config.js';
import { parseCategoryPage, parseLink, titleFromSlug, tmdbImageFile } from '../src/parser.js';

const cat = (key) => CATEGORIES.find((c) => c.key === key);

test('extrae todas las películas de Taquillas con su canal', () => {
  const { entries } = parseCategoryPage(fixture('taquillas'), cat('taquillas'));
  assert.equal(entries.length, 160);
  const first = entries[0];
  assert.equal(first.type, 'movie');
  assert.equal(first.position, 1);
  assert.equal(first.channelLabel, 'Taquilla');
  assert.equal(entries[1].channelLabel, 'Taquilla 1');
  assert.match(first.sourceKey, /^poster:[\w-]+\.jpg$/);
  assert.equal(new Set(entries.map((e) => e.sourceKey)).size, entries.length);
});

test('Infantiles usa su propia etiqueta de canal', () => {
  const { entries } = parseCategoryPage(fixture('infantiles'), cat('infantiles'));
  assert.equal(entries.length, 24);
  assert.equal(entries[0].channelLabel, 'Taquilla infantil 1');
});

test('Series: ID de TMDB o FilmAffinity como identificador estable', () => {
  const { entries } = parseCategoryPage(fixture('series'), cat('series'));
  assert.equal(entries.length, 192);
  const tmdb = entries.filter((e) => e.tmdbId);
  const fa = entries.filter((e) => e.filmaffinityId);
  assert.ok(fa.length > 0);
  // Una tarjeta real enlaza a una imagen en lugar de a una ficha: se identifica por su póster.
  const other = entries.filter((e) => !e.tmdbId && !e.filmaffinityId);
  assert.equal(tmdb.length + fa.length + other.length, 192);
  assert.ok(other.every((e) => e.sourceKey.startsWith('poster:')));
  assert.equal(entries[0].sourceKey, 'tmdb:tv:273918');
  assert.equal(entries[0].slugTitle, 'Yo siempre a veces');
});

test('Taquillazo: salas, no películas', () => {
  const { entries } = parseCategoryPage(fixture('taquillazo'), cat('taquillazo'));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.type === 'sala'));
});

test('el menú de navegación no se confunde con títulos', () => {
  const { entries } = parseCategoryPage(fixture('series'), cat('series'));
  assert.ok(entries.every((e) => !/\.html$/.test(e.href) || /filmaffinity/.test(e.href)));
});

test('detecta tarjetas duplicadas dentro de una página', () => {
  const card = '<div class="movie"><a href="https://www.themoviedb.org/tv/1-x?language=es"><img src="https://media.themoviedb.org/t/p/w300_and_h450_face/a.jpg" alt="s"></a></div>';
  const { entries, duplicates } = parseCategoryPage(`<div class="movies">${card}${card}</div>`, cat('series'));
  assert.equal(entries.length, 1);
  assert.equal(duplicates, 1);
});

test('utilidades de enlaces e imágenes', () => {
  assert.deepEqual(parseLink('https://www.themoviedb.org/tv/95350-lanterns?language=es'), { kind: 'tmdb', tmdbType: 'tv', tmdbId: 95350, slug: 'lanterns' });
  assert.equal(parseLink('https://www.filmaffinity.com/es/film481581.html').filmaffinityId, '481581');
  assert.equal(tmdbImageFile('https://media.themoviedb.org/t/p/w300_and_h450_bestv2/1B8n.jpg'), '1B8n.jpg');
  assert.equal(tmdbImageFile('https://otra.web/img.jpg'), null);
  assert.equal(titleFromSlug('the-lord-of-the-rings-the-rings-of-power'), 'The lord of the rings the rings of power');
});
