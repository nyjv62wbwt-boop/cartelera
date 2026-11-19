import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, editDistance, buildIndex, search, applyFilters, sortItems, facets,
  DEFAULT_FILTERS, filtersToParams, paramsToFilters,
} from '../public/js/search.js';

const items = [
  { id: 'a', type: 'movie', title: 'El Señor de los Anillos', originalTitle: 'The Lord of the Rings', year: 2001, genres: ['Aventura', 'Fantasía'], language: 'en', rating: 8.4, votes: 25000, popularity: 90, cast: ['Elijah Wood', 'Ian McKellen'], directors: ['Peter Jackson'], categories: [{ key: 'taquillas', position: 3 }], addedAt: '2026-11-01' },
  { id: 'b', type: 'tv', title: 'Stranger Things', originalTitle: null, year: 2016, genres: ['Drama', 'Misterio'], language: 'en', rating: 8.6, votes: 18000, popularity: 120, cast: ['Millie Bobby Brown'], directors: [], creators: ['Matt Duffer'], categories: [{ key: 'series', position: 1 }], addedAt: '2026-11-10' },
  { id: 'c', type: 'movie', title: 'Matrix', originalTitle: 'The Matrix', year: 1999, genres: ['Acción', 'Ciencia ficción'], language: 'en', rating: 8.2, votes: 26000, popularity: 70, cast: ['Keanu Reeves'], directors: ['Lana Wachowski'], categories: [{ key: 'taquillas', position: 1 }], addedAt: '2026-11-05' },
  { id: 'd', type: 'movie', title: 'Ágata y Lola', year: 2025, genres: ['Comedia'], language: 'es', rating: 6.1, votes: 40, popularity: 10, cast: [], directors: [], categories: [{ key: 'infantiles', position: 2 }], addedAt: '2026-11-12' },
  { id: 'e', type: 'movie', title: null, categories: [{ key: 'taquillas', position: 7, channel: 'Taquilla 7' }], genres: [], addedAt: '2026-11-12' },
];
const index = buildIndex(items);

test('normaliza mayúsculas, acentos y signos', () => {
  assert.equal(normalize('  ÁGATA y Lola!! '), 'agata y lola');
});

test('distancia de edición con transposiciones', () => {
  assert.equal(editDistance('matrix', 'matirx'), 1);
  assert.equal(editDistance('matrix', 'matrix'), 0);
  assert.ok(editDistance('matrix', 'zzzzzz') > 2);
});

test('búsqueda flexible: acentos, erratas y prefijos', () => {
  assert.ok(search(index, 'agata').has('d'));
  assert.ok(search(index, 'matirx').has('c'));
  assert.ok(search(index, 'strang').has('b'));
  assert.ok(search(index, 'STRANGER things').has('b'));
});

test('busca por título original, actor y director', () => {
  assert.ok(search(index, 'lord of the rings').has('a'));
  assert.ok(search(index, 'keanu').has('c'));
  assert.ok(search(index, 'peter jackson').has('a'));
  assert.ok(search(index, 'duffer').has('b'));
});

test('busca por canal de la cartelera en títulos sin identificar', () => {
  assert.ok(search(index, 'taquilla 7').has('e'));
});

test('sin resultados para texto sin relación', () => {
  assert.equal(search(index, 'xyzxyz').size, 0);
});

test('ordena por relevancia: coincidencia de título antes que de reparto', () => {
  const extra = [...items, { id: 'f', type: 'movie', title: 'Otra película', cast: ['Matrix Smith'], genres: [], categories: [] }];
  const scores = search(buildIndex(extra), 'matrix');
  const sorted = sortItems(extra.filter((i) => scores.has(i.id)), 'relevance', scores);
  assert.equal(sorted[0].id, 'c');
});

test('filtros combinados: tipo + género + año + valoración + idioma', () => {
  const f = { ...DEFAULT_FILTERS, type: 'movie', genres: ['Acción', 'Comedia'], yearFrom: 1990, yearTo: 2030, minRating: 6, lang: 'en' };
  assert.deepEqual(applyFilters(items, f).map((i) => i.id), ['c']);
  assert.deepEqual(applyFilters(items, { ...f, lang: '' }).map((i) => i.id).sort(), ['c', 'd']);
});

test('filtro por categoría original y favoritos', () => {
  assert.deepEqual(applyFilters(items, { ...DEFAULT_FILTERS, category: 'infantiles' }).map((i) => i.id), ['d']);
  assert.deepEqual(applyFilters(items, { ...DEFAULT_FILTERS, favorites: true }, { favorites: new Set(['b']) }).map((i) => i.id), ['b']);
});

test('búsqueda + filtros funcionan juntos', () => {
  const scores = search(index, 'the');
  const res = applyFilters(items, { ...DEFAULT_FILTERS, type: 'tv' }, { scores });
  assert.ok(res.every((i) => i.type === 'tv'));
});

test('ordenaciones', () => {
  assert.deepEqual(sortItems(items.slice(0, 4), 'az').map((i) => i.id), ['d', 'a', 'c', 'b']);
  assert.equal(sortItems(items, 'recent')[0].addedAt, '2026-11-12');
  assert.equal(sortItems(items, 'popular')[0].id, 'b');
  assert.equal(sortItems(items, 'year-asc')[0].id, 'c');
});

test('facetas solo con datos reales', () => {
  const fx = facets(items);
  assert.ok(fx.genres.some((g) => g.name === 'Acción'));
  assert.deepEqual(fx.languages.map((l) => l.code), ['en', 'es']);
  assert.equal(fx.hasRatings, true);
  assert.deepEqual(facets([{ id: 'x', genres: [] }]).genres, []);
});

test('filtros <-> URL ida y vuelta', () => {
  const f = { ...DEFAULT_FILTERS, q: 'matrix', type: 'movie', genres: ['Acción', 'Drama'], yearFrom: 1990, minRating: 7, sort: 'rating' };
  assert.deepEqual(paramsToFilters(filtersToParams(f)), f);
});
