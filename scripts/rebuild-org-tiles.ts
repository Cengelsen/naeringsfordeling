#!/usr/bin/env node
/**
 * Rebuild only the organizations layer into public/data/points.pmtiles.
 *
 * go-pmtiles convert is one-way (mbtiles → pmtiles), so we:
 * 1. tippecanoe organizations z14–18 (Leaflet z15+ via maplibre-gl-leaflet −1)
 * 2. tippecanoe-recreate district/grunnkretser bands from the DB
 * 3. tile-join + convert
 *
 * Prefer yarn export-map-tiles for a full rebuild. This script is the same
 * pipeline with SKIP_DISTRICT_COLORS semantics and clearer logging.
 */
import { spawnSync } from 'node:child_process'

const env = {
  ...process.env,
  SKIP_DISTRICT_COLORS: process.env.SKIP_DISTRICT_COLORS ?? '1',
}

const result = spawnSync('tsx', ['scripts/export-map-tiles.ts'], {
  stdio: 'inherit',
  env,
})

process.exit(result.status ?? 1)
