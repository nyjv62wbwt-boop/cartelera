# Cartelera · Cajón de Contenidos

Versión mejorada de la cartelera de <https://novedadestaquillas.cajondecontenido.appboxes.co/>, sincronizada automáticamente con ella cada 12 horas.

## Puesta en marcha

Requisito: **Node.js 22.13 o superior** (probado con Node 26). No hay dependencias que instalar.

```powershell
copy .env.example .env      # opcional: ajustar puerto, token de admin, TMDB...
npm start                   # web en http://localhost:3000 · panel en http://localhost:3000/admin
npm test                    # 37 pruebas automáticas
npm run sync                # sincronización puntual desde consola (añade -- --force para forzar)
```

Al arrancar por primera vez, el servidor sincroniza solo y después cada `SYNC_INTERVAL_HOURS` (12 por defecto).
El token del panel `/admin` es `ADMIN_TOKEN` o, si no lo defines, el que se genera en `data/admin-token.txt`.

Para que la sincronización siga funcionando sin dejar el servidor abierto, programa `npm run sync` con el
Programador de tareas de Windows (o cron). Hay un bloqueo en la base de datos que impide que se solapen dos ejecuciones.

## Publicación gratuita (GitHub Pages + GitHub Actions)

El workflow [.github/workflows/publicar.yml](.github/workflows/publicar.yml) hace en GitHub, sin tu PC:
sincronización cada 12 h → genera la web estática (`npm run build` → `dist/`) → la publica en GitHub Pages.
La base de datos se conserva en la rama `datos`. La clave de TMDB va como *secret* y nunca llega al navegador.

1. Crea un repositorio **público** vacío en GitHub y sube este proyecto (`git push -u origin main`).
2. *Settings → Secrets and variables → Actions → New repository secret*: `TMDB_API_KEY` = tu clave.
3. *Settings → Pages → Build and deployment → Source*: **GitHub Actions**.
4. *Actions → Sincronizar y publicar → Run workflow*. La web queda en `https://<usuario>.github.io/<repositorio>/`.

En la versión pública no hay panel `/admin` (no hay servidor): el estado de cada sincronización (nuevos, modificados,
ausentes, errores) aparece en el resumen de cada ejecución en *Actions*, el botón *Run workflow* es la sincronización
manual (con casilla «forzar») y GitHub avisa por correo si una ejecución falla. Para cambiar el intervalo, edita la
línea `cron` del workflow (hora UTC). GitHub puede pausar los workflows programados de un repositorio sin actividad
durante 60 días; se reactivan con un clic en *Actions*. El panel `/admin` completo sigue disponible con `npm start`.

## Análisis de la web original

| Aspecto | Lo que hay realmente |
|---|---|
| Tecnología | HTML estático servido por nginx (`index.html`, `taquillazo.html`, `taquillas.html`, `infantiles.html`, `series.html`, `styles.css`). Sin JavaScript de datos. |
| API / JSON / feed / sitemap | **No existen.** `robots.txt` da 404. La única fuente son las 4 páginas públicas. |
| Taquillas (160) e Infantiles (24) | Por película: **solo el póster de TMDB** y un enlace a la imagen del «ticket» del canal (`taquilla5.png`). No hay título, año, sinopsis ni ID. |
| Series (192) | Póster + enlace a la ficha de TMDB (`/tv/ID-slug`, 169), de FilmAffinity (22) o a una imagen (1). |
| Taquillazo (2) | Dos «salas» (canales) con su logotipo; no son películas. |
| Temporadas/episodios, géneros, reparto, valoraciones | No aparecen en la fuente. |
| Reproducción | La fuente no tiene reproductor; solo indica el canal. |
| Detección de cambios | Cabeceras `Last-Modified` y `ETag` por página: se usan peticiones condicionales (304 si no cambió). |

## Cómo funciona la sincronización

`src/sync.js` (servidor, independiente de que alguien tenga la web abierta):

1. Descarga las 4 páginas con `If-None-Match` / `If-Modified-Since` (4 peticiones cada 12 h, carga mínima para la fuente).
2. Extrae cada título (`src/parser.js`) con un **identificador estable**: `tmdb:tv:ID`, `fa:ID`, `poster:FICHERO.jpg` o `sala:...`.
3. En una única transacción: inserta los nuevos, actualiza los cambiados (póster, enlace…) y conserva la categoría original
   (Taquillazo, Taquillas, Infantiles, Series) y la posición/canal en `item_sources`. Un mismo título puede estar en varias categorías.
4. Ausencias: si un título deja de aparecer pasa a `missing` (sigue visible) y tras `MISSING_THRESHOLD` sincronizaciones
   seguidas (2 por defecto, editable en `/admin`) a `unavailable` (oculto). **Nunca se borra**; si vuelve, se restaura.
5. Seguridad de datos: reintentos con espera por página; si una página falla o trae menos de la mitad de títulos que antes,
   **esa categoría no se toca** y se registra el aviso (se puede «forzar» desde `/admin`). Si falla todo, el catálogo queda intacto
   y se reintenta en 1 h.
6. Metadatos opcionales con la **API oficial de TMDB** (`src/tmdb.js`): título en español, título original, sinopsis, año, duración,
   géneros, idioma, valoración, popularidad, reparto, dirección/creación, imágenes y **temporadas con sus episodios**.
   Las películas (que solo traen póster) se identifican buscando ese póster en los listados de TMDB (cartelera, estrenos,
   populares, novedades e infantiles). Si dos pósters resultan ser la misma película, se **fusionan** en un solo título.
   Las temporadas solo se vuelven a descargar si la serie cambió (nuevo episodio, nueva temporada).

Cada ejecución queda registrada en `sync_runs` (nuevos, modificados, ausentes, no disponibles, errores) y se ve en `/admin`.

### Base de datos (`data/catalog.db`, SQLite)

- `items`: id estable, `source_key` (identificador original), tipo, título, título original, año, descripción, géneros, idioma,
  valoración, póster, fondo, imágenes, reparto, dirección, temporadas/episodios, IDs de TMDB/FilmAffinity, estado de
  disponibilidad, contador de ausencias, fecha de incorporación (`first_seen_at`), última vez visto y última actualización.
- `item_sources`: categoría original, posición y canal de cada título.
- `aliases`: identificadores antiguos de títulos fusionados (evita duplicados y mantiene enlaces/favoritos).
- `sync_runs`, `settings`, `http_cache`.

## La web

- Número de taquilla («Taquilla 5», «Taquilla infantil 3») visible en cada tarjeta y en la ficha, para buscar el canal en la
  aplicación de IPTV; también se puede escribir en el buscador.
- Portada: novedad destacada, accesos rápidos por categoría y género, filas de últimas películas y series, destacadas
  (valoración ponderada por votos), Infantiles, una fila por género con contenido y las salas del Taquillazo.
- Buscador en la cabecera (atajo `/`): en tiempo real con *debounce*, sobre **todo** el catálogo, sin mayúsculas ni acentos,
  tolerante a erratas, por título, título original, reparto, dirección/creación y canal; resultados por relevancia; botón para borrar.
- Explorar / Películas / Series / Infantiles / Mi lista: filtros combinables (tipo, categoría original, géneros, año desde/hasta,
  idioma, valoración mínima) y orden (relevancia, recientes, populares, valoración, A-Z, año). Chips de filtros activos,
  «Limpiar filtros», estado en la URL (se puede compartir y volver con «Atrás»), carga progresiva de 48 en 48.
  Los filtros solo aparecen si hay datos reales para ellos.
- Ficha: póster, fondo, sinopsis, año, duración, géneros, valoración, idioma, dirección/creación, reparto con fotos, temporadas
  y episodios (número, título, fecha, duración, resumen), «Dónde está en la cartelera» (categoría y canal) y enlace a TMDB/FilmAffinity.
  Se cierra con Esc, la X o «Atrás» volviendo exactamente al mismo punto de la lista.
- Mi lista: favoritos guardados en el navegador (no requiere cuentas ni servicios nuevos).
- Responsive con barra inferior en móvil, imágenes de TMDB en el tamaño justo (`srcset`, carga diferida), estados de carga,
  error y vacío, cabeceras de seguridad (CSP), API comprimida y con ETag.

## Panel `/admin`

Última y próxima sincronización, películas y series disponibles, nuevos, modificados, ausentes, sin identificar, errores,
historial con detalle (títulos nuevos/modificados y estado de cada página), botón **Sincronizar ahora** (con opción de forzar),
intervalo y umbral de ausencia editables, y gestión de contenido: listas de sin identificar, ausentes, posibles duplicados y
errores; **vincular a TMDB** (pegar URL o ID → previsualizar → guardar, con aviso y fusión si ya existe) y **edición manual**
(título obligatorio, año, géneros, descripción; validación, aviso de duplicado y previsualización). Los datos manuales no se
sobrescriben al sincronizar. La API de administración exige el token (comparación en tiempo constante).

## Limitaciones (importante)

1. **La fuente no publica títulos de películas.** Sin clave de TMDB, las 184 películas se muestran con su póster y su canal
   («Taquilla 5») y las series con el título que se deduce de su enlace de TMDB (sin tildes, p. ej. «Au del des murs»).
   Para títulos, sinopsis, géneros, años, valoraciones, reparto y episodios hace falta una **clave gratuita de TMDB**
   (<https://www.themoviedb.org/settings/api>) en `TMDB_API_KEY` o `TMDB_READ_TOKEN`. La clave queda en el servidor.
2. Con clave, la identificación por póster es heurística: se buscan candidatas (estrenos en España de los últimos 2 años,
   novedades, populares, infantiles) y se comparan todos sus pósters, guardando el índice en la BD. Resultado real
   (19/11/2026): **133 de 184 películas** y **185 de 192 series** identificadas (incluidas 16 de las enlazadas a FilmAffinity).
   La primera vez cuesta ~5.000 peticiones a TMDB (unos 3 min); después solo se revisan candidatas nuevas.
   Lo que queda «sin identificar» se vincula a mano en `/admin` (una vez; se recuerda).
3. FilmAffinity no tiene API pública: sus series solo se completan si su póster aparece en TMDB o vinculándolas a mano.
3b. Los textos vienen de TMDB tal cual; alguna sinopsis en español de TMDB puede contener errores o publicidad
   introducida por sus usuarios.
4. «Añadidos recientemente» usa la fecha en que **nuestro** sistema vio el título por primera vez. En la primera importación
   todos comparten fecha y se respeta el orden de la cartelera original.
5. No hay botón de reproducción: la web original no tiene reproductor ni enlaces de streaming; solo indica el canal.
6. La sincronización lee el HTML público. Si el proveedor cambia la maquetación, el analizador avisará (página «incompleta»)
   sin borrar nada, y habrá que ajustar `src/parser.js`. Lo ideal sería que el proveedor ofreciera una exportación (JSON/CSV)
   con ID, título, tipo, categoría y canal; el resto del sistema ya está preparado para ello.

## Estructura

```
src/config.js      configuración (.env) y categorías originales
src/parser.js      lectura del HTML de la fuente
src/db.js          esquema SQLite, ajustes, bloqueo entre procesos
src/sync.js        sincronización, ausencias, fusión de duplicados, enriquecimiento
src/tmdb.js        cliente de la API de TMDB
src/scheduler.js   programación periódica en el servidor
src/catalog.js     consultas para la web y el panel
src/server.js      servidor HTTP (web, API pública y API de admin)
src/cli-sync.js    `npm run sync`
public/            web (index.html, js/app.js, js/search.js, css/app.css) y panel (admin.html, js/admin.js, css/admin.css)
test/              pruebas con las páginas reales de la fuente como fixtures
```
