# Næringsfordeling

Visuell oversikt over organisasjoner i Norge, fordelt etter kommune og organisasjonstype.

All data synkroniseres nattlig fra BRREG til en **SQLite-database** via GitHub Actions. For prikkevisning bygges i tillegg **vektorfliser (PMTiles)** med tippecanoe. Kartet bruker [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet, med MapLibre GL for GPU-tegning av prikker.

## Funksjoner

- Interaktivt kart over hele Norge med kommuner
- Filtrering på organisasjonstype (AS, ENK, BRL, osv.)
- Filtrering på fylke, kommune, konkurs, avvikling og MVA-registrering
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

## Database-sync

| Kommando | Beskrivelse |
|----------|-------------|
| **`yarn build-db`** | **Bygg komplett SQLite-database** (BRREG import + geokoding til ferdig) |
| `yarn sync:dev` | Rask lokal database (3 små kommuner) |
| `yarn sync` | Inkrementell oppdatering + én geokodingsbatch |
| `yarn sync:full` | Full import fra BRREG bulk + én geokodingsbatch |
| `yarn sync:geocode` | Kun geokode adresser som mangler koordinater |
| `yarn server` | Start API som leser `data/organizations.db` |
| `yarn download-db` | Last ned database fra GitHub Release `database` |
| `yarn download-points` | Last ned PMTiles fra GitHub Release `points` |
| `yarn export-vector-tiles` | Bygg PMTiles lokalt (krever tippecanoe) |
| `yarn export-points` | Bygg JSON-kommune-tiles (valgfri fallback-cache) |

### `yarn build-db`

Bygger `data/organizations.db` med API-grenser innbakt:

- **BRREG bulk** – én nedlasting for full import (anbefalt)
- **BRREG oppdateringer** – paginering med pause, enkeltoppslag med pause, retry ved 429/503
- **Kartverket** – begrenset parallellitet, pause mellom kall, retry ved 429/503
- **Geokoding** – kjører i batcher til alle adresser er geokodet eller ingen fremgang

```bash
yarn build-db              # oppdater eksisterende db, geokode resten
yarn build-db --fresh      # slett og bygg på nytt fra BRREG bulk
yarn build-db --skip-geocode   # kun import, ingen geokoding
```

Miljøvariabler for tuning:

- `DATABASE_PATH` – output-fil (standard: `data/organizations.db`)
- `SYNC_GEOCODE_LIMIT` – adresser per geokodingsbatch (standard: 5000)
- `SYNC_GEOCODE_CONCURRENCY` – parallelle geokodingskall (standard: 3)
- `GEOCODE_DELAY_MS` – pause mellom Kartverket-kall (standard: 200)
- `BRREG_PAGE_DELAY_MS` – pause mellom BRREG-sider (standard: 250)
- `BRREG_ENTITY_DELAY_MS` – pause mellom enkeltoppslag (standard: 150)
- `API_MAX_RETRIES` – retry ved 429/503 (standard: 5)

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

- [tippecanoe](https://github.com/felt/tippecanoe) på `PATH`
- [go-pmtiles](https://github.com/protomaps/go-pmtiles) CLI (lastes automatisk ned til `.cache/bin/` hvis den mangler)
- Ferdig geokodet `data/organizations.db`

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

# Eller bygg selv:
yarn download-db          # eller yarn build-db
yarn export-vector-tiles  # krever tippecanoe
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
- **Kartverket Adresse-API** (sync-script) – geokoding ved synk
- **SQLite** – kilde for API, aggregater og tile-export
- **PMTiles** (runtime, prikker) – forhåndsbygde vektorfliser for default-filtre
- **OpenStreetMap** – kartfliser (Leaflet)
- **Kartverket** (via [robhop/fylker-og-kommuner](https://github.com/robhop/fylker-og-kommuner)) – kommunegrenser (GeoJSON)

## Lisens

Se [LICENSE](LICENSE).
