
# Næringsfordeling

Visuell oversikt over organisasjoner i Norge, fordelt etter kommune og organisasjonstype.

All data synkroniseres nattlig fra BRREG til en **SQLite-database** via GitHub Actions. For prikkevisning bygges i tillegg **vektorfliser (PMTiles)** med tippecanoe. Kartet bruker [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet, med MapLibre GL for GPU-tegning av prikker.

## Funksjoner

- Interaktivt kart over hele Norge med kommuner
- Filtrering på organisasjonstype (AS, ENK, BRL, osv.)
- Filtrering på næringskode (NACE-seksjon), antall ansatte (bånd), enhetstype (hovedenheter/underenheter)
- Filtrering på fylke, kommune, konkurs, avvikling og MVA-registrering
- Konsern-modus: vis konsernstruktur i popup med kartoverlay
- To visualiseringsmoduser: distrikter (fylker/kommuner) og adresser (prikker)
- **Nightly sync** via GitHub Actions til SQLite + forhåndsbygde PMTiles
- Prikker lastes primært fra vektorfliser; API/SQLite brukes som fallback

## Kom i gang

```bash
yarn
yarn download-db      # after GitHub Action has run once
yarn download-points  # optional: PMTiles for fast dots mode
# or, for local dev before the release exists:
yarn sync:dev

yarn server        # terminal 1
yarn dev           # terminal 2
```

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
| `KARTVERKET_CACHE_DIR` | `data/cache/national-build` | Cache for Kartverket CSV-zip; importeres automatisk ved geokoding hvis tabellen mangler. |

Geokoding (`yarn sync`, `yarn build-db`, server) bruker **lokal Kartverket-database** (`kartverket_addresses` eller zip i cache) når tilgjengelig, og faller tilbake til Kartverket Adresse-API ved miss.

### Eksport og nedlasting

| Kommando | Beskrivelse | Flagg / miljøvariabler |
|----------|-------------|------------------------|
| `yarn export-vector-tiles` | Bygg PMTiles med tippecanoe | `DATABASE_PATH`. `POINTS_OUTPUT_DIR` (standard: `public/data`). Krever `tippecanoe` på PATH. |
| `yarn export-points` | Bygg JSON-kommune-tiles (fallback-cache) | `DATABASE_PATH`. `POINTS_OUTPUT_DIR` (standard: `public/data/points`). |
| `yarn export-static-api` | Eksporter statisk JSON-API til `public/data/api/` | `STATIC_API_DIR` (standard: `public/data/api`). Leser `DATABASE_PATH`. |
| `yarn download-db` | Last ned `organizations.db` fra GitHub Release | Ingen flagg (bruker `gh release download`). |
| `yarn download-kommuner` | Last ned kommunegrenser (GeoJSON) | Ingen flagg (fast URL). |
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

`yarn build-national-db` bygger én SQLite-fil med **hele landet** uten live Kartverket-API-kall:

1. Laster ned [Matrikkelen Adresse](https://kartkatalog.geonorge.no/) (CSV, EPSG:4258, ~150 MB zip)
2. Importerer alle adresser til tabellen `kartverket_addresses`
3. Streamer BRREG bulk (enheter + underenheter)
4. Geokoder organisasjoner mot lokal Kartverket-database
5. Bygger R-tree-indeks

Standard output: `data/norway.db` (overstyr med `--output=` eller `DATABASE_PATH`).

| Flagg | Beskrivelse |
|-------|-------------|
| `--fresh` | Slett eksisterende output-fil først. |
| `--output=PATH` | SQLite-fil (standard: `data/norway.db`). |
| `--reuse-downloads` | Hopp over Kartverket-nedlasting hvis zip finnes i cache. |
| `--cache-dir=PATH` | Cache for Kartverket-zip (standard: `data/cache/national-build`). |
| `--skip-kartverket` | Bruk eksisterende `kartverket_addresses` i databasen. |
| `--skip-brreg` | Hopp over BRREG-import. |
| `--skip-geocode` | Importer kun rådata. |
| `--skip-underenheter` | Importer kun hovedenheter fra BRREG. |
| `--metadata-only` | Oppdater kun geokode-metadata (krever eksisterende koordinater). |

Krever `unzip` på PATH (`dnf install unzip`). Kartverket-cachen kan gjenbrukes mellom kjøringer.

```bash
yarn build-national-db --fresh
yarn build-national-db --fresh --reuse-downloads   # raskere re-kjøring
DATABASE_PATH=data/norway.db yarn server
```

`--fresh` sletter fortsatt databasen og starter helt på nytt. `--backfill` upserter inn i eksisterende SQLite – koordinater beholdes når adressen er uendret. Uten `--fylke` lastes **hele landet** fra BRREG bulk; med `--fylke=46` oppdateres kun det fylket (samme scope som `--dev --fylke=46`).

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
        ├─ yarn export-vector-tiles ──► NDJSON ──► tippecanoe ──► MBTiles
        │                                                    │
        │                                                    ▼
        │                                              pmtiles convert
        │                                                    │
        │                                    public/data/points.pmtiles
        │                                    public/data/points/manifest.json
        │
        ├─ yarn export-points ──► public/data/points/{kommune}.json  (valgfritt)
        │
        └─ yarn server ──► GET /api/organizations/points (R-tree bbox)

Frontend (MapView, modus «dots»):
  1. PMTiles + MapLibre vector source   ← foretrukket
  2. JSON-kommune-tiles + GeoJSON       ← hvis default-filtre og filer finnes
  3. SQLite API + GeoJSON               ← alltid tilgjengelig
  4. Leaflet circleMarker               ← hvis WebGL/MapLibre feiler
```

Basekartet er Leaflet (OSM-raster). Prikkene tegnes i et transparent MapLibre GL-lag (`@maplibre/maplibre-gl-leaflet`) i Leaflet sitt `markerPane`, slik at Leaflet eier pan/zoom og MapLibre eier GPU-sirkler.

### 1. Vektorfliser (tippecanoe → PMTiles)

**Script:** [`scripts/export-vector-tiles.ts`](scripts/export-vector-tiles.ts) (`yarn export-vector-tiles`)

**Forutsetninger:**

- [tippecanoe](https://github.com/felt/tippecanoe) på `PATH` (se [Fedora-instruksjoner](#installere-tippecanoe-fedora) under)
- [go-pmtiles](https://github.com/protomaps/go-pmtiles) CLI (lastes automatisk ned til `.cache/bin/` hvis den mangler)
- Ferdig geokodet `data/organizations.db`

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

Deretter:

```bash
yarn download-db          # eller yarn build-db / yarn sync:dev
yarn export-vector-tiles
```

**Pipeline:**

1. Les geokodede organisasjoner fra SQLite med faste filtre:
   - `deleted = 0`, `konkurs = 0`, `under_avvikling = 0`
   - `lat` / `lng` ikke null
   - *ikke* filtrert på MVA (`vatRegisteredOnly: false`)
2. Skriv GeoJSON **NDJSON** (én Feature per linje) med properties `orgnr` og `orgType`
3. Kjør tippecanoe → `public/data/points.mbtiles` (lag-navn: `organizations`)
4. `pmtiles convert` → `public/data/points.pmtiles`
5. Slett midlertidig MBTiles
6. Skriv `public/data/points/manifest.json` med total, org-typer, bake-in filtre og tidspunkt

**Tippecanoe-flagg:**

| Flagg | Betydning |
|-------|-----------|
| `-z14` | Maks zoom 14 |
| `-P` | Parallell prosessering |
| `--drop-densest-as-needed` | Dropp tetteste punkter hvis flisen blir for stor |
| `--coalesce-densest-as-needed` | Slå sammen tette punkter ved behov |
| `--extend-zooms-if-still-dropping` | Utvid zoomnivåer til alt får plass |
| `--maximum-tile-bytes=2000000` | ~2 MB budsjett per flise |
| `--no-tile-compression` | Ukomprimert MVT (enklere HTTP range / PMTiles) |
| `--force` | Overskriv eksisterende output |
| `-l organizations` | Vektorlag-navn brukt av MapLibre |

Miljøvariabler: `DATABASE_PATH`, `POINTS_OUTPUT_DIR` (standard `public/data`).

**Manifest** (eksempel):

```json
{
  "total": 120668,
  "layer": "organizations",
  "format": "pmtiles",
  "path": "/data/points.pmtiles",
  "filters": {
    "excludeKonkurs": true,
    "excludeUnderAvvikling": true,
    "vatRegisteredOnly": false
  },
  "orgTypes": ["ANNA", "ANS", "AS", "..."],
  "generatedAt": "2026-07-18T00:00:00.000Z"
}
```

### 2. Frontend: lasting og tegning

**Nøkkelfiler:**

| Fil | Rolle |
|-----|-------|
| [`src/lib/map/vectorTiles.ts`](src/lib/map/vectorTiles.ts) | PMTiles-protokoll, probe, manifest |
| [`src/lib/map/maplibreDotsLayer.ts`](src/lib/map/maplibreDotsLayer.ts) | MapLibre-lag, clustering, styling |
| [`src/lib/map/dotsLayer.ts`](src/lib/map/dotsLayer.ts) | Velger MapLibre eller Leaflet-fallback |
| [`src/lib/components/MapView.svelte`](src/lib/components/MapView.svelte) | Orchestrering og filter-logikk |
| [`vite.config.ts`](vite.config.ts) | `Accept-Ranges` for `.pmtiles` i dev/preview |

Ved oppstart kjører `probeVectorTiles()`: HEAD på `/data/points.pmtiles` + fetch av manifest. Vektormodus brukes bare når:

- begge filene finnes
- WebGL/MapLibre fungerer
- UI-filtrene matcher bake-in-filtrene (`excludeKonkurs` + `excludeUnderAvvikling`, ikke `vatRegisteredOnly`) — se `canUseStaticTiles()`

Hvis brukeren skrur av konkurs-/avviklingsfilter eller krever kun MVA-registrerte, deaktiveres PMTiles og appen faller tilbake til API/JSON.

**MapLibre i vektormodus:**

- Registrerer `pmtiles://`-protokoll (`pmtiles`-pakken)
- Source `org-dots`: `type: 'vector'`, URL `pmtiles://{origin}/data/points.pmtiles`
- Layer `org-points`: `circle` med `source-layer: organizations`
- Farge via `match` på `orgType`; radius interpoleres med zoom
- Org-typefilter: client-side `setFilter` — ingen ny nedlasting
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
