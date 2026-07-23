
# Næringsfordeling

Visuell oversikt over organisasjoner i Norge, fordelt etter kommune og organisasjonstype.

All data synkroniseres nattlig fra BRREG til en **SQLite-database** via GitHub Actions. For prikkevisning bygges i tillegg **vektorfliser (PMTiles)** med tippecanoe. Kartet bruker [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet, med MapLibre GL for GPU-tegning av prikker.

## Funksjoner

- Interaktivt kart over hele Norge med kommuner
- Filtrering på organisasjonstype (AS, ENK, BRL, osv.)
- Filtrering på næringskode (NACE-seksjon), antall ansatte (bånd), enhetstype (hovedenheter/underenheter)
- Filtrering på fylke, kommune, konkurs, avvikling og MVA-registrering
- Konsern-modus: vis konsernstruktur i popup med kartoverlay
- To visualiseringsmoduser: distrikter (fylker/kommuner) og adresser (prikker). **Adresser er standard.**
- **Nightly sync** via GitHub Actions til SQLite + forhåndsbygde PMTiles
- Prikker lastes primært fra vektorfliser; API/SQLite brukes som fallback

## Kom i gang

```bash
yarn
yarn download-db      # after GitHub Action has run once
yarn download-kommuner
yarn download-grunnkretser
yarn export-district-colors   # pre-rendered district tiles (required for dots view)
# optional, for fast detail zoom:
yarn download-points

yarn server        # terminal 1
yarn dev           # terminal 2
```

**Adresser** (default view) uses pre-exported district GeoJSON at zoom &lt; 15 — same predefined fylke/kommune/grunnkrets boundaries as Distrikter, with one baked org-type blend colour per region. Individual addresses from zoom 15. No organisation fetch at aggregate zoom. Run `yarn export-district-colors` after syncing the database (also runs as part of `yarn export-map-tiles`).

Åpne [http://localhost:5173](http://localhost:5173).

Frontend proxyer `/api` til `http://localhost:3001` i dev. Uten API og database starter ikke appen med data. Uten `points.pmtiles` fungerer prikkevisning fortsatt via API (tregere ved mange punkter).

## Scripts og flagg

Oversikt over alle `yarn`-kommandoer i [`package.json`](package.json). CLI-flagg settes etter kommandonavnet, f.eks. `yarn sync --full`. Miljøvariabler settes foran, f.eks. `DATABASE_PATH=data/test.db yarn server`.

### Frontend

| Kommando | Beskrivelse | Flagg / miljøvariabler |
|----------|-------------|------------------------|
| `yarn dev` | Vite dev-server (port 5173) | Vite-flagg: `--host`, `--port`, `--open`, `--strictPort`, osv. |
| `yarn build` | Produksjonsbygg til `dist/` | `GITHUB_PAGES=true` – GitHub Pages base path. `VITE_BASE=/repo-navn/` – base URL (kun med `GITHUB_PAGES=true`). |
| `yarn preview` | Forhåndsvis produksjonsbygg | Samme Vite-flagg som `dev` (`--host`, `--port`, …). |
| `yarn check` | Typecheck (svelte-check + tsc) | svelte-check-flagg, f.eks. `--watch`, `--threshold error`. |

### API

| Kommando | Beskrivelse | Flagg / miljøvariabler |
|----------|-------------|------------------------|
| `yarn server` | Hono API på port 3001 | `PORT` – lytteport (standard: `3001`). `DATABASE_PATH` – SQLite-fil (standard: `data/organizations.db`). |

### Database: bygg og sync

| Kommando | Beskrivelse | Innebygde flagg |
|----------|-------------|-----------------|
| `yarn build-db` | Bygg komplett SQLite-database | Se flagg under. |
| `yarn build-db:dev` | Dev-bygg (forhåndsdefinert) | Tilsvarer `yarn build-db --dev --fresh`. |
| `yarn build-national-db` | Nasjonal database fra BRREG + Kartverket bulk | Se flagg under. Krever `unzip`. |
| `yarn build-region-db` | Database for ett fylke eller én kommune | `--fylke=46` eller `--kommune=4601`. |
| `yarn build-all-fylker` | Bygg database for alle fylker | Tilsvarer `build-all-regions --fylker`. |
| `yarn build-all-kommuner` | Bygg database for alle kommuner | Tilsvarer `yarn build-all-regions --kommuner`. |
| `yarn sync` | Inkrementell oppdatering + geokoding | Se flagg under. |
| `yarn sync:full` | Full BRREG-import + geokoding | Tilsvarer `yarn sync --full`. |
| `yarn sync:backfill` | Oppgrader eksisterende DB fra BRREG bulk | Tilsvarer `yarn sync --backfill`. |
| `yarn sync:dev` | Rask lokal database | Tilsvarer `yarn sync --dev --geocode-limit=2000`. |
| `yarn sync:geocode` | Kun geokode manglende adresser | Tilsvarer `yarn sync --geocode-only`. |

**`yarn build-db` – CLI-flagg:**

| Flagg | Beskrivelse |
|-------|-------------|
| `--fresh` | Slett eksisterende database og start full import. |
| `--backfill` | Stream BRREG inn i eksisterende database (oppgrader nye kolonner + underenheter). Uten `--fylke`: hele landet. |
| `--fylke=XX` | Med `--backfill` eller `--dev`: begrens til ett fylke (tosifret fylkeskode). |
| `--skip-underenheter-backfill` | Med `--backfill`: hopp over underenheter. |
| `--regeocode-metadata` | Oppdater Kartverket-metadata på allerede geokodede adresser. |
| `--dev` | Importer kun dev-kommuner (3 små, eller hele fylke med `--fylke`). |
| `--fylke=XX` | Dev-import for ett fylke (tosifret fylkeskode, f.eks. `46`). Kreves med `--geocode-all`. Env: `SYNC_DEV_FYLKE`. |
| `--skip-geocode` | Importer uten geokoding. |
| `--geocode-all` | Geokode alle adresser i dev-fylket (krever `--dev` og `--fylke`). |
| `--geocode-limit=N` | Maks adresser per geokodingsbatch (standard: 5000, dev: 2000). |
| `--max-rounds=N` | Maks antall geokodingsrunder (standard: 10000). Env: `BUILD_DB_MAX_ROUNDS`. |
| `--allow-api` | Tillat BRREG/Kartverket HTTP-API når lokale filer mangler. **Uten dette flagget brukes kun lokale filer** (`data/norway.db`, deretter `data/cache/reference`). |
| `--refresh-downloads` | Last ned BRREG referansefiler på nytt (krever `--allow-api`). |

**`yarn build-db` – datakilder (prioritet):**

1. `data/norway.db` (eller `NATIONAL_DB_PATH`) – kopieres i sin helhet ved `--fresh` / tom database
2. BRREG bulk i `data/cache/reference` – filtrert import ved dev/fylke-backfill
3. BRREG/Kartverket API – **kun** med `--allow-api` når lokale filer mangler

Lokalt anbefalt flyt:

```bash
yarn build-national-db --fresh    # én gang: fyll norway.db + referansecache
yarn build-db --fresh             # kopierer fra norway.db, ingen API
yarn server && yarn dev
```

**`yarn sync` – CLI-flagg:**

| Flagg | Beskrivelse |
|-------|-------------|
| `--full` | Full import fra BRREG bulk i stedet for inkrementell sync. |
| `--backfill` | Som `--full`, men eksplisitt for oppgradering av eksisterende database (ingen sletting). Uten `--fylke`: hele landet. |
| `--fylke=XX` | Med `--backfill`: begrens oppdateringen til ett fylke (for dev/fylke-databaser). |
| `--skip-underenheter-backfill` | Med `--backfill`: hopp over underenheter bulk. |
| `--regeocode-metadata` | Oppdater `geocode_quality` / `kommunenummer_geo` på allerede geokodede adresser. |
| `--dev` | Dev-import (samme kommuner/fylke som `build-db --dev`). |
| `--fylke=XX` | Dev-import for ett fylke. Env: `SYNC_DEV_FYLKE`. |
| `--geocode-only` | Hopp over BRREG-import; kun geokode adresser uten koordinater. |
| `--geocode-all` | Geokode alle gjenværende adresser (krever `--dev` eller `--geocode-only`). |
| `--geocode-limit=N` | Maks adresser per batch (standard: 10000). Env: `SYNC_GEOCODE_LIMIT`. |
| `--max-rounds=N` | Maks geokodingsrunder. Env: `BUILD_DB_MAX_ROUNDS`. |
| `--allow-api` | Tillat BRREG/Kartverket HTTP-API (standard for inkrementell sync). |
| `--local-only` | Tving lokal modus (ingen API) – overstyrrer standard for `yarn sync`. |
| `--refresh-downloads` | Last ned BRREG referansefiler på nytt (krever `--allow-api`). |

**Fylkeskoder** (tosifret prefiks i kommunenummer — brukes med `--fylke=XX` og i kartfiltre):

| Kode | Fylke | Merknad |
|------|-------|---------|
| `03` | Oslo | |
| `11` | Rogaland | |
| `15` | Møre og Romsdal | |
| `18` | Nordland | |
| `31` | Østfold | |
| `32` | Akershus | |
| `33` | Buskerud | |
| `34` | Innlandet | |
| `39` | Vestfold | |
| `40` | Telemark | |
| `42` | Agder | |
| `46` | Vestland | |
| `50` | Trøndelag | |
| `55` | Troms | |
| `56` | Finnmark | |
| `30` | Viken | Utgått (2024); bruk `31`–`33` |
| `38` | Vestfold og Telemark | Utgått (2024); bruk `39` eller `40` |
| `54` | Troms og Finnmark | Utgått (2024); bruk `55` eller `56` |
| `21` | Svalbard | |
| `22` | Jan Mayen | |

Koden er de to første sifrene i kommunenummeret (f.eks. Bergen `4601` → fylke `46`). Samme mapping brukes i kartet og i [`src/lib/utils/geo.ts`](src/lib/utils/geo.ts).

**Miljøvariabler (gjelder `build-db`, `sync` og geokoding):**

| Variabel | Standard | Beskrivelse |
|----------|----------|-------------|
| `DATABASE_PATH` | `data/organizations.db` | SQLite-fil. |
| `SYNC_GEOCODE_LIMIT` | `5000` | Adresser per geokodingsbatch. |
| `SYNC_GEOCODE_CONCURRENCY` | `3` | Parallelle Kartverket-kall. |
| `GEOCODE_DELAY_MS` | `200` | Pause mellom geokodingskall. |
| `GEOCODE_BATCH_PAUSE_MS` | `2000` | Pause mellom batches. |
| `BUILD_DB_MAX_ROUNDS` | `10000` | Maks geokodingsrunder. |
| `BUILD_DB_MAX_GEOCODE_ADDRESSES` | (ubegrenset) | Stopp geokoding etter N adresser totalt. |
| `SYNC_DEV_FYLKE` | – | Fylkeskode for dev-import (alternativ til `--fylke`). |
| `BRREG_PAGE_DELAY_MS` | `250` | Pause mellom BRREG-listesider. |
| `BRREG_ENTITY_DELAY_MS` | `150` | Pause mellom enkeltoppslag i BRREG. |
| `API_MAX_RETRIES` | `5` | HTTP-retries ved 429/503. |
| `API_RETRY_BASE_MS` | `1000` | Initial retry-backoff. |
| `KARTVERKET_CACHE_DIR` | `data/cache/reference/kartverket` | Kartverket CSV-zip; importeres automatisk ved geokoding hvis tabellen mangler. |
| `REFERENCE_CACHE_DIR` | `data/cache/reference` | Rot for referansedata (BRREG bulk + Kartverket). |
| `NATIONAL_DB_PATH` | `data/norway.db` | Nasjonal database som `build-db` kopierer fra ved `--fresh`. |

Geokoding (`yarn sync`, `yarn build-db`, server) sjekker **lokal Kartverket-database** (`kartverket_addresses` eller zip i cache) først, og faller tilbake til Kartverket Adresse-API ved miss **kun med `--allow-api`**. **`yarn build-db` bruker som standard kun lokale filer** (`norway.db` → referansecache); BRREG/Kartverket-API aktiveres bare med `--allow-api`. **`yarn sync`** tillater API som standard for inkrementelle oppdateringer, men bulk-import bruker fortsatt lokale filer når de finnes.

### Eksport og nedlasting

| Kommando | Beskrivelse | Flagg / miljøvariabler |
|----------|-------------|------------------------|
| `yarn export-district-colors` | Bygg distrikts-GeoJSON med forhåndsbakt farge per fylke/kommune/grunnkrets | `DATABASE_PATH`. Krever `yarn download-kommuner` og `yarn download-grunnkretser`. Kjøres også fra `yarn export-map-tiles` og `yarn export-static-api`. |
| `yarn export-map-tiles` | Bygg nasjonale LOD-PMTiles + distrikts-GeoJSON (detail zoom) | `DATABASE_PATH` (standard: `data/organizations.db`). Bruk `yarn export-map-tiles:norway` for `data/norway.db`. Krever `tippecanoe` + `yarn download-kommuner` + `yarn download-grunnkretser`. |
| `yarn export-map-tiles:norway` | Samme, fra nasjonal DB (`data/norway.db`) | Hele landet. |
| `yarn export-vector-tiles` | Alias for `export-map-tiles` | |
| `yarn export-points` | Bygg JSON-kommune-tiles (fallback-cache) | `DATABASE_PATH`. `POINTS_OUTPUT_DIR` (standard: `public/data/points`). |
| `yarn export-static-api` | Eksporter statisk JSON-API til `public/data/api/` | `STATIC_API_DIR` (standard: `public/data/api`). Leser `DATABASE_PATH`. |
| `yarn download-db` | Last ned `organizations.db` fra GitHub Release | Ingen flagg (bruker `gh release download`). |
| `yarn download-kommuner` | Last ned kommunegrenser (GeoJSON) | Ingen flagg (fast URL). |
| `yarn download-grunnkretser` | Last ned grunnkretsgrenser fra Geonorge/Kartverket (GeoJSON, ~100 MB) | Ingen flagg (fast URL). |
| `yarn download-points` | Last ned `points.pmtiles` fra GitHub Release | Ingen flagg (bruker `gh release download`). |

**Eksempler:**

```bash
yarn build-db --fresh --skip-geocode
yarn sync --dev --fylke=46 --geocode-limit=500
yarn sync --geocode-only --geocode-all --fylke=46
DATABASE_PATH=data/test.db PORT=4000 yarn server
POINTS_OUTPUT_DIR=/tmp/points yarn export-points
yarn dev --host --port 5174
```

## Database-sync

`yarn build-db` bygger `data/organizations.db` med API-grenser innbakt:

- **BRREG bulk** – én nedlasting for full import (anbefalt)
- **BRREG oppdateringer** – paginering med pause, enkeltoppslag med pause, retry ved 429/503
- **Kartverket** – begrenset parallellitet, pause mellom kall, retry ved 429/503
- **Geokoding** – kjører i batcher til alle adresser er geokodet eller ingen fremgang

Se [Scripts og flagg](#scripts-og-flagg) for alle kommandonavn, CLI-flagg og miljøvariabler.

Etter merge av utvidet BRREG-synk oppgraderes kolonner automatisk via `ensureColumns()` ved neste kjøring. For å **fyll inn data** i en eksisterende database uten å slette den:

```bash
# Oppdater næringskode, ansatte, konsern-felt og importer underenheter (beholder geokoding)
yarn sync --backfill

# Fylke-scoped database (f.eks. dev-import for Vestland) – importerer ikke hele Norge
yarn sync --backfill --fylke=46

# Samme via build-db
yarn build-db --backfill --fylke=46 --geocode-limit=2000

# Oppdater også Kartverket-metadata (geocode_quality, kommunenummer_geo) på eksisterende prikker
yarn sync --backfill --regeocode-metadata

# Kun metadata (ingen ny BRREG-nedlasting)
yarn sync --geocode-only --regeocode-metadata
```

### Nasjonal database (BRREG + Kartverket bulk)

`yarn build-national-db` bygger én SQLite-fil med **hele landet** uten live API-kall (når referansecache finnes):

1. Laster ned [Matrikkelen Adresse](https://kartkatalog.geonorge.no/) (CSV, EPSG:4258, ~150 MB zip) **til referansecache**
2. Laster ned BRREG bulk (enheter + underenheter) **til referansecache**
3. Importerer adresser til tabellen `kartverket_addresses`
4. Importerer BRREG fra lokale gzip-filer
5. Geokoder organisasjoner mot lokal Kartverket-database (ingen API)
6. Bygger R-tree-indeks

Referansedata lagres under `data/cache/reference/` og gjenbrukes automatisk ved nye bygg:

```
data/cache/reference/
  manifest.json
  brreg/enheter.v2.json.gz
  brreg/underenheter.v2.json.gz
  brreg/kommuner.json
  kartverket/Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip
  kartverket/fylker/ …
  kartverket/kommuner/ …
```

Etter første kjøring kan du bygge nye databaser **offline** med samme referansedata (BRREG + Kartverket).

Standard output: `data/norway.db` (overstyr med `--output=` eller `DATABASE_PATH`).

| Flagg | Beskrivelse |
|-------|-------------|
| `--fresh` | Slett eksisterende output-fil først. |
| `--output=PATH` | SQLite-fil (standard: `data/norway.db`). |
| `--refresh-downloads` | Last ned BRREG/Kartverket på nytt selv om cache finnes. |
| `--cache-dir=PATH` | Rot for referansecache (standard: `data/cache/reference`). |
| `--skip-kartverket` | Bruk eksisterende `kartverket_addresses` i databasen. |
| `--skip-brreg` | Hopp over BRREG-import. |
| `--skip-geocode` | Importer kun rådata. |
| `--skip-underenheter` | Importer kun hovedenheter fra BRREG. |
| `--metadata-only` | Oppdater kun geokode-metadata (krever eksisterende koordinater). |

Krever `unzip` på PATH (`dnf install unzip`).

```bash
yarn build-national-db --fresh                    # første gang: laster ned referansedata
yarn build-national-db --fresh                    # senere: gjenbruker cache (offline OK)
yarn build-national-db --fresh --refresh-downloads   # tving ny nedlasting
DATABASE_PATH=data/norway.db yarn server
```

### Fylkes- og kommunedatabaser

`yarn build-region-db` bygger en **komplett** SQLite-fil per fylke eller kommune. Datakilde velges automatisk (ingen BRREG-API-kall):

1. **Nasjonal SQLite** (`data/norway.db`) når den finnes — kopierer organisasjoner, geokoding og Kartverket-adresser for regionen (raskt)
2. **Referansecache** ellers — regional Kartverket-zip + filtrert BRREG bulk + lokal geokoding

Output (standard):

| Type | Sti |
|------|-----|
| Fylke | `data/regions/fylker/46-vestland.db` |
| Kommune | `data/regions/kommuner/4601-bergen.db` |

Overstyr med `--output=` eller `REGIONS_OUTPUT_DIR`.

**Enkeltregion:**

```bash
yarn build-national-db --fresh          # engangssteg: norway.db + referansecache
yarn build-region-db --fylke=46 --fresh # kopierer fra norway.db hvis den finnes
yarn build-region-db --kommune=4601 --fresh
DATABASE_PATH=data/regions/fylker/46-vestland.db yarn server
```

**Alle regioner:**

```bash
yarn build-all-fylker --skip-existing
yarn build-all-kommuner --skip-existing   # ~350 DB-filer, tar lang tid
yarn build-all-regions --kommuner --fylke=46   # alle kommuner i Vestland
```

| Flagg | Beskrivelse |
|-------|-------------|
| `--fylke=XX` / `--kommune=XXXX` | Region (`build-region-db`; nøyaktig én). |
| `--fylker` / `--kommuner` | Batch-modus (`build-all-regions`; nøyaktig én). |
| `--fresh` | Slett eksisterende output først. |
| `--skip-existing` | Hopp over regioner som allerede har DB-fil. |
| `--from-national` | Tving kopi fra nasjonal SQLite (`--national-db=PATH`, standard `data/norway.db`). |
| `--from-cache` | Tving bygg fra referansecache (BRREG gzip + regional Kartverket). |
| `--national-db=PATH` | Nasjonal SQLite for `--from-national` / auto (standard: `data/norway.db`). |
| `--refresh-downloads` | Last ned regional Kartverket-zip på nytt (kun cache-modus). |
| `--cache-dir=PATH` | Rot for referansecache (standard: `data/cache/reference`). |
| `--limit=N` | Bygg bare N regioner (testing). |
| `--skip-geocode` | Importer uten geokoding (kun cache-modus). |
| `--skip-underenheter` | Kun hovedenheter. |

Ved behov kan du kjøre GitHub Actions `workflow_dispatch` med **full import** (sletter og bygger på nytt i CI) eller legge til en backfill-jobb senere.

### Nye filterparametre (API)

| Param | Standard | Beskrivelse |
|-------|----------|-------------|
| `naeringskodeSections` | (alle) | Kommaseparerte 2-sifrede NACE-seksjoner, f.eks. `62,47` |
| `employeeBands` | (alle) | `0`, `1-4`, `5-19`, `20+`, `unknown` |
| `entityKinds` | `enhet` | `enhet`, `underenhet` (underenheter er skjult som standard) |
| `konsernMembersOnly` | `false` | Kun organisasjoner med `er_i_konsern=1` |

PMTiles inneholder `naeringskode`, `employeeBand` og `entityKind` som klientfiltre (samme mønster som `orgType`). Bake-in-filtrene (konkurs, avvikling, MVA) er uendret.

## Prikkevisning (marker rendering)

Prikker (visualiseringsmodus «adresser») tegnes med tre mulige datakilder, valgt automatisk ved runtime. Målet er å vise hundretusener av geokodede organisasjoner uten å laste alt inn i nettleseren.

### Arkitektur

```
BRREG + Kartverket
        │
        ▼
data/organizations.db
        │
        ├─ yarn export-map-tiles ──► LOD NDJSON ──► tippecanoe (4 band) ──► tile-join
        │                                                    │
        │                                                    ▼
        │                                              pmtiles convert
        │                                                    │
        │                                    public/data/points.pmtiles
        │                                    public/data/points/manifest.json
        │
        ├─ yarn export-points ──► public/data/points/{kommune}.json  (valgfritt)
        │
        ├─ yarn server ──► GET /api/viewport-summary (bbox-statistikk)
        └─ yarn server ──► GET /api/organizations/points (R-tree bbox, fallback)

Frontend (MapView, modus «dots»):
  1. PMTiles + MapLibre vector source   ← foretrukket
  2. JSON-kommune-tiles + GeoJSON       ← hvis default-filtre og filer finnes
  3. SQLite API + GeoJSON               ← alltid tilgjengelig
  4. Leaflet circleMarker               ← hvis WebGL/MapLibre feiler
```

Basekartet er Leaflet (OSM-raster). Prikkene tegnes i et transparent MapLibre GL-lag (`@maplibre/maplibre-gl-leaflet`) i Leaflet sitt `markerPane`, slik at Leaflet eier pan/zoom og MapLibre eier GPU-sirkler.

### 1. LOD-kartfliser (tippecanoe → PMTiles)

**Script:** [`scripts/export-map-tiles.ts`](scripts/export-map-tiles.ts) (`yarn export-map-tiles`, alias: `yarn export-vector-tiles`)

Bygger en **zoom-pyramide** med distriktsfliser (fylke/kommune som i «Distrikter»), grunnkretser og enkeltadresser ved høy zoom:

| Lag | Zoom | Innhold |
|-----|------|---------|
| `districts_fylke_poly` | 4–6 | Fylkepolygoner med én forhåndsbakt blandingfarge per fylke |
| `districts_kommune_poly` | 7–11 | Kommunepolygoner med én forhåndsbakt blandingfarge per kommune |
| `grunnkretser_poly` | 12–14 | Kartverket-grunnkretser med én forhåndsbakt blandingfarge per grunnkrets |
| `organizations` | 15–18 | Enkeltadresser (klikkbare) |

Fargen for distrikter og grunnkretser beregnes ved **tile-export** (`mixOrgTypeColors` i `orgTypeColors.ts`): vektet RGB-blanding av org.type-spektrumet. Klienten leser bare `color` fra vektorflisene — ingen runtime-beregning eller org-henting for disse zoom-båndene.

**Forutsetninger:**

- [tippecanoe](https://github.com/felt/tippecanoe) på `PATH` (inkl. `tile-join`; se [Fedora-instruksjoner](#installere-tippecanoe-fedora) under)
- [go-pmtiles](https://github.com/protomaps/go-pmtiles) CLI (lastes automatisk ned til `.cache/bin/` hvis den mangler)
- Ferdig geokodet database (`data/organizations.db` eller regional DB)

#### Installere tippecanoe (Fedora)

Tippecanoe finnes ikke i Fedoras offisielle repos. To vanlige måter:

**Alternativ A – COPR (raskest):**

```bash
sudo dnf install dnf-plugins-core
sudo dnf copr enable dilawar/tippecanoe
sudo dnf install tippecanoe
tippecanoe --version
```

COPR er community-maintained og ikke offisielt støttet av Fedora. Sjekk [copr.fedoraproject.org/coprs/dilawar/tippecanoe](https://copr.fedoraproject.org/coprs/dilawar/tippecanoe/) før du aktiverer repoet.

**Alternativ B – bygg fra kilde (samme som GitHub Actions):**

```bash
sudo dnf install gcc gcc-c++ make sqlite-devel zlib-devel git
git clone --depth 1 https://github.com/felt/tippecanoe.git /tmp/tippecanoe
make -C /tmp/tippecanoe -j"$(nproc)"
sudo make -C /tmp/tippecanoe install
tippecanoe --version
```

Deretter (hele Norge):

```bash
yarn download-kommuner          # kreves for fylke/kommune-fliser
yarn download-grunnkretser      # kreves for grunnkrets-fliser (z12–14)
yarn build-national-db --fresh  # eller yarn download-db / yarn sync:full
yarn export-map-tiles:norway    # data/norway.db → public/data/points.pmtiles

# Alternativ: app-databasen (samme som CI nightly sync)
yarn export-map-tiles           # data/organizations.db
```

Valgfritt – kun ett fylke (raskere test):

```bash
DATABASE_PATH=data/regions/fylker/46-vestland.db yarn export-map-tiles
```

**Pipeline:**

1. Les geokodede organisasjoner fra SQLite (standardfiltre: ikke konkurs/avvikling, `entity_kind=enhet`)
2. Aggreger org.typer per fylke og kommune; bak én blandingfarge (`color`) per distrikt og eksporter polygoner
3. Aggreger organisasjoner per grunnkrets (point-in-polygon mot Kartverket-grenser; NDJSON med `color`, `count`, `orgTypeBreakdown`)
4. Eksporter enkeltpunkter som NDJSON
5. Kjør tippecanoe per zoom-bånd → `tile-join` → én `points.mbtiles`
6. `pmtiles convert` → `public/data/points.pmtiles`
7. Skriv `public/data/points/manifest.json` med `layers[]` og filter-metadata

**Statistikk vs. tegning:** Kartet viser distriktsfliser og grunnkretser ved lav/medium zoom. Paneltallene (`GET /api/viewport-summary`) teller alle organisasjoner i kartutsnittet (geokodede i bbox + uten koordinat i overlappende kommuner). På statisk GitHub Pages brukes omtrentlige tall fra `municipality-breakdown.json`.

**Pipeline (legacy enkeltlag):** Eldre manifest uten `layers[]` vises fortsatt som ett `organizations`-lag.

**Tippecanoe (enkeltpunkter):** `--drop-densest-as-needed` brukes kun på `organizations`-laget. Aggregerte celler eksporteres uten dropping.

Miljøvariabler: `DATABASE_PATH`, `POINTS_OUTPUT_DIR` (standard `public/data`).

**Manifest** (eksempel med LOD):

```json
{
  "total": 208501,
  "layer": "organizations",
  "format": "pmtiles",
  "path": "/data/points.pmtiles",
  "layers": [
    { "name": "districts_fylke_poly", "minZoom": 4, "maxZoom": 6 },
    { "name": "districts_fylke", "minZoom": 4, "maxZoom": 6 },
    { "name": "districts_kommune_poly", "minZoom": 7, "maxZoom": 11 },
    { "name": "districts_kommune", "minZoom": 7, "maxZoom": 11 },
    { "name": "grunnkretser_poly", "minZoom": 12, "maxZoom": 14 },
    { "name": "organizations", "minZoom": 15, "maxZoom": 18 }
  ],
  "filters": {
    "excludeKonkurs": true,
    "excludeUnderAvvikling": true,
    "vatRegisteredOnly": false,
    "entityKinds": ["enhet"]
  },
  "orgTypes": ["ANNA", "ANS", "AS", "..."],
  "generatedAt": "2026-07-22T00:00:00.000Z"
}
```

### 2. Frontend: lasting og tegning

**Nøkkelfiler:**

| Fil | Rolle |
|-----|-------|
| [`src/lib/map/districtColors.ts`](src/lib/map/districtColors.ts) | Manifest + per-fylke gzip-lasting av distrikts-GeoJSON |
| [`src/lib/map/districtColorLayer.ts`](src/lib/map/districtColorLayer.ts) | Leaflet GeoJSON-lag for aggregat-zoom |
| [`src/lib/map/vectorTiles.ts`](src/lib/map/vectorTiles.ts) | PMTiles-protokoll, probe, manifest |
| [`src/lib/map/maplibreDotsLayer.ts`](src/lib/map/maplibreDotsLayer.ts) | MapLibre-lag, clustering, styling |
| [`src/lib/map/dotsLayer.ts`](src/lib/map/dotsLayer.ts) | Velger MapLibre eller Leaflet-fallback |
| [`src/lib/lodConfig.ts`](src/lib/lodConfig.ts) | Felles `DETAIL_MIN_ZOOM` (15) for klient og export |
| [`src/lib/components/MapView.svelte`](src/lib/components/MapView.svelte) | Orchestrering og filter-logikk |
| [`vite.config.ts`](vite.config.ts) | `Accept-Ranges` for `.pmtiles` i dev/preview |

Ved oppstart kjører `probeVectorTiles()`: HEAD på `/data/points.pmtiles` + fetch av manifest. Hvis filene finnes lokalt eller på Pages, brukes vektorfliser automatisk — ingen `VITE_HAS_PMTILES`-flagg nødvendig i dev.

**Aggregat-zoom (under `dotsDetailMinZoom`, standard 15):** prioritet:

1. **Distrikts-GeoJSON** (`public/data/districts/`) — Leaflet-polygoner med samme forhåndsdefinerte fylke/kommune/grunnkrets-geometri som «Distrikter» (foretrukket)
2. **PMTiles LOD-lag** — fallback hvis distrikts-GeoJSON mangler men `points.pmtiles` har aggregatlag
3. Ellers: kommune-omriss + tydelig melding om manglende export

Ingen organisasjons-henting per viewport på aggregat-zoom. Tall i panelet kommer fra `viewport-summary`.

**Detalj-zoom (15+):** alle geokodede adresser i kartutsnittet — fra PMTiles når UI-filtrene matcher bake-in-filtrene, ellers uten sampling via API.

Vektormodus krever i tillegg:
- WebGL/MapLibre fungerer
- For enkeltadresser (z15+): UI-filtrene matcher bake-in-filtrene (`excludeKonkurs` + `excludeUnderAvvikling`, ikke `vatRegisteredOnly`) — se `canUseStaticTiles()`

Hvis brukeren skrur av konkurs-/avviklingsfilter eller krever kun MVA-registrerte, vises aggregat-fliser (fylke/kommune/grunnkretser) fortsatt fra distrikts-GeoJSON ved lav zoom; enkeltadresser (z15+) faller tilbake til API/JSON.

**MapLibre i vektormodus:**

- Registrerer `pmtiles://`-protokoll (`pmtiles`-pakken)
- Source `org-dots`: `type: 'vector'`, URL `pmtiles://{origin}/data/points.pmtiles`
- Layer `org-points`: `circle` med `source-layer: organizations`
- Aggregat-lag (fylke/kommune/grunnkretser): forhåndsbakt `fill-color` fra `color`-property
- Enkeltadresser: farge via `match` på `orgType`; radius interpoleres med zoom
- Org-typefilter på aggregater: client-side `setFilter` på `dominantOrgType` — ingen ny nedlasting
- **Ingen MapLibre-clustering** i vektormodus; tippecanoe håndterer tetthet via drop/coalesce

**GeoJSON-modus** (API eller JSON-tiles):

- Source uten clustering; lag `org-points`
- Samme koordinat får litt jitter slik at overlappende punkter skilles
- Klikk: `queryRenderedFeatures` (10 px) → popup via `/api/organizations/:orgnr`

Vite setter `Accept-Ranges: bytes` på `.pmtiles` slik at klienten kan hente fliser med HTTP range requests i `yarn dev` / `yarn preview`.

### 3. Fallback: JSON-kommune-tiles

**Script:** [`scripts/export-point-tiles.ts`](scripts/export-point-tiles.ts) (`yarn export-points`)

Valgfri statisk cache (kjøres ikke i CI). Grupperer punkter per `kommunenummer`; kommuner med ≥ 10 000 punkter deles i et 0,04°-rutenett. Format: kompakte tupler `[orgnr, lng, lat, orgType]`. Brukes bare når default-filtre gjelder og viewport har kjente kommunenr.

### 4. Fallback: SQLite API

`GET /api/organizations/points` spørrer R-tree (`orgs_rtree`) med bbox og filtre. Zoom-baserte grenser og caching (minne + IndexedDB) begrenser hvor mye som hentes. Brukes når PMTiles ikke er tilgjengelig eller filtrene ikke matcher bake-in.

### 5. Fallback: Leaflet uten WebGL

Hvis MapLibre/WebGL feiler, tegnes `L.circleMarker` på canvas (`leafletDotsLayer.ts`). Ingen clustering og ingen PMTiles.

### Lokal bygg / nedlasting av fliser

```bash
# Etter at nattlig Action har publisert release "points":
yarn download-points

# Eller bygg selv (krever tippecanoe — se Fedora-instruksjoner over):
yarn download-db          # eller yarn build-db
yarn export-vector-tiles
```

## GitHub Actions

Workflow: [`.github/workflows/sync-organizations.yml`](.github/workflows/sync-organizations.yml)

- Kjører **hver natt kl. 02:00 UTC** (+ manuell `workflow_dispatch`)
- Laster ned forrige `organizations.db` fra GitHub Release `database`
- Kjører inkrementell sync mot BRREG + geokoder nye adresser
- Publiserer oppdatert database til release `database`
- Bygger tippecanoe fra source, installerer go-pmtiles
- Kjører `yarn export-vector-tiles`
- Publiserer `points.pmtiles` + `manifest.json` til release `points`

## API-endepunkter

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/health` | Database-status |
| `GET /api/organisasjonsformer` | Org-typer fra databasen |
| `GET /api/kommuner` | Kommuner med antall |
| `GET /api/municipality-counts` | Aggregert fordeling per kommune |
| `GET /api/organizations` | Geokodede organisasjoner for kart (prikker) |
| `GET /api/organizations/points` | Viewport-punkter (bbox / R-tree) |
| `GET /api/organizations/:orgnr` | Enkeltorganisasjon (popup) |

## Bygg

```bash
yarn build
yarn preview
```

## Datakilder

- **BRREG** (sync-script) – enheter og oppdateringer
- **Kartverket** (lokal bulk eller Adresse-API) – geokoding ved synk
- **SQLite** – kilde for API, aggregater og tile-export
- **PMTiles** (runtime, prikker) – forhåndsbygde vektorfliser for default-filtre
- **OpenStreetMap** – kartfliser (Leaflet)
- **Kartverket** (via [robhop/fylker-og-kommuner](https://github.com/robhop/fylker-og-kommuner)) – kommunegrenser (GeoJSON)

## Lisens

Se [LICENSE](LICENSE).
