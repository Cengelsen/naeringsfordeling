import L from 'leaflet'

/** Leaflet GeoJSON wraps MultiPolygon features in nested layer groups. */
export function forEachPathLayer(layer: L.Layer, fn: (path: L.Path) => void): void {
  if (layer instanceof L.LayerGroup) {
    for (const child of layer.getLayers()) {
      forEachPathLayer(child, fn)
    }
    return
  }

  if (layer instanceof L.Path) {
    fn(layer)
  }
}
