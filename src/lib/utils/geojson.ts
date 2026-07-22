import type { FeatureCollection } from 'geojson'
import { assetUrl } from './assets'
import { fetchStaticJson } from './staticJson'

/** Load kommune boundaries bundled with the site (prefers pre-gzipped copy). */
export async function fetchKommunerGeojson(): Promise<FeatureCollection> {
  try {
    return await fetchStaticJson<FeatureCollection>(assetUrl('data/kommuner.geojson'))
  } catch {
    throw new Error('Kunne ikke laste kartdata')
  }
}
