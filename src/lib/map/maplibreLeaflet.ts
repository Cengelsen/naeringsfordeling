import type { Map as LeafletMap } from 'leaflet'

interface MaplibreGlLeafletLayer {
  getMaplibreMap?: () => unknown
  remove?: () => void
}

function isMaplibreGlLeafletLayer(layer: unknown): layer is MaplibreGlLeafletLayer {
  return (
    typeof layer === 'object' &&
    layer !== null &&
    'getMaplibreMap' in layer &&
    typeof (layer as MaplibreGlLeafletLayer).getMaplibreMap === 'function'
  )
}

/** Remove maplibre-gl-leaflet layers left behind after a failed WebGL init. */
export function removeOrphanMaplibreGlLayers(map: LeafletMap): void {
  const layers: MaplibreGlLeafletLayer[] = []

  map.eachLayer((layer) => {
    if (isMaplibreGlLeafletLayer(layer)) layers.push(layer)
  })

  for (const layer of layers) {
    try {
      layer.remove?.()
    } catch {
      // Layer may already be partially destroyed after WebGL init failure
    }
  }
}
