import type { FeatureCollection } from 'geojson'
import { assetUrl } from './assets'

async function parseGzipGeojson(response: Response): Promise<FeatureCollection> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Nettleseren støtter ikke gzip-dekomprimering')
  }

  const stream = response.body!.pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  return JSON.parse(text) as FeatureCollection
}

/** Load kommune boundaries bundled with the site (prefers pre-gzipped copy). */
export async function fetchKommunerGeojson(): Promise<FeatureCollection> {
  const geojsonUrl = assetUrl('data/kommuner.geojson')

  const gzResponse = await fetch(`${geojsonUrl}.gz`)
  if (gzResponse.ok) {
    return parseGzipGeojson(gzResponse)
  }

  const response = await fetch(geojsonUrl)
  if (!response.ok) {
    throw new Error('Kunne ikke laste kartdata')
  }

  return response.json() as Promise<FeatureCollection>
}
