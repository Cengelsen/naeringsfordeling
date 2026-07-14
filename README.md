# Næringsfordeling

Visuell oversikt over organisasjoner i Norge, fordelt etter kommune og organisasjonstype.

All data kommer fra en **SQLite-database** som synkroniseres nattlig fra BRREG via GitHub Actions. Kartet bruker [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet.

## Funksjoner

- Interaktivt kart over hele Norge med kommuner
- Filtrering på organisasjonstype (AS, ENK, BRL, osv.)
- Filtrering på fylke, kommune, konkurs, avvikling og MVA-registrering
- Tre visualiseringsmoduser: fargekart (koroplet), bobler og adresser (prikker)
- **Nightly sync** via GitHub Actions til SQLite-database med geokodede adresser
- Frontend henter **kun** fra lokal API som leser SQLite

## Kom i gang

```bash
yarn
yarn download-db   # after GitHub Action has run once
# or, for local dev before the release exists:
yarn sync:dev

yarn server        # terminal 1
yarn dev           # terminal 2
```

Åpne [http://localhost:5173](http://localhost:5173).

Frontend proxyer `/api` til `http://localhost:3001` i dev. Uten API og database starter ikke appen med data.

## Database-sync

| Kommando | Beskrivelse |
|----------|-------------|
| **`yarn build-db`** | **Bygg komplett SQLite-database** (BRREG import + geokoding til ferdig) |
| `yarn sync:dev` | Rask lokal database (3 små kommuner) |
| `yarn sync` | Inkrementell oppdatering + én geokodingsbatch |
| `yarn sync:full` | Full import fra BRREG bulk + én geokodingsbatch |
| `yarn sync:geocode` | Kun geokode adresser som mangler koordinater |
| `yarn server` | Start API som leser `data/organizations.db` |
| `yarn download-db` | Last ned database fra GitHub Release |

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

## GitHub Actions

Workflow: [`.github/workflows/sync-organizations.yml`](.github/workflows/sync-organizations.yml)

- Kjører **hver natt kl. 02:00 UTC**
- Laster ned forrige `organizations.db` fra GitHub Release `database`
- Kjører inkrementell sync mot BRREG + geokoder nye adresser
- Publiserer oppdatert database til samme release

## API-endepunkter

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/health` | Database-status |
| `GET /api/organisasjonsformer` | Org-typer fra databasen |
| `GET /api/kommuner` | Kommuner med antall |
| `GET /api/municipality-counts` | Aggregert fordeling per kommune |
| `GET /api/organizations` | Geokodede organisasjoner for kart (prikker) |

## Bygg

```bash
yarn build
yarn preview
```

## Datakilder

- **BRREG** (sync-script) – enheter og oppdateringer
- **Kartverket Adresse-API** (sync-script) – geokoding ved synk
- **SQLite** (runtime) – eneste datakilde for frontend
- **OpenStreetMap** – kartfliser
- **Kartverket** (via [robhop/fylker-og-kommuner](https://github.com/robhop/fylker-og-kommuner)) – kommunegrenser (GeoJSON)

## Lisens

Se [LICENSE](LICENSE).
