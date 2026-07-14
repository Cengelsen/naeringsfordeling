# Næringsfordeling

Visuell oversikt over organisasjoner i Norge, fordelt etter kommune og organisasjonstype.

Data hentes fra [BRREG Enhetsregisteret](https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/) og vises på et kart med [OpenStreetMap](https://www.openstreetmap.org/) via Leaflet.

## Funksjoner

- Interaktivt kart over hele Norge med kommuner
- Filtrering på organisasjonstype (AS, ENK, BRL, osv.)
- Filtrering på fylke, konkurs, avvikling og MVA-registrering
- To visualiseringsmoduser: fargekart (koroplet) og bobler
- Venstre panel styrer kartet i sanntid

## Kom i gang

```bash
yarn
yarn dev
```

Åpne [http://localhost:5173](http://localhost:5173).

Første gangs lasting henter antall organisasjoner per kommune fra BRREG (~350 forespørsler). Resultatet caches i nettleseren i 24 timer.

## Bygg

```bash
yarn build
yarn preview
```

## Datakilder

- **BRREG** – antall enheter per kommune og filter
- **OpenStreetMap** – kartfliser
- **Kartverket** (via [robhop/fylker-og-kommuner](https://github.com/robhop/fylker-og-kommuner)) – kommunegrenser (GeoJSON)

## Lisens

Se [LICENSE](LICENSE).
