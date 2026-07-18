import type { Map as LeafletMap } from 'leaflet'
import { createLeafletDotsLayer } from './leafletDotsLayer'
import {
  createMaplibreDotsLayer,
  type MaplibreDotsController,
  type MaplibreDotsLayerOptions,
} from './maplibreDotsLayer'
import { isWebglDotsFailed, markWebglDotsFailed } from './webgl'

export type DotsLayerController = MaplibreDotsController
export type DotsLayerOptions = MaplibreDotsLayerOptions

export function createDotsLayer(
  map: LeafletMap,
  options: DotsLayerOptions,
): { controller: DotsLayerController; usedWebgl: boolean } {
  if (isWebglDotsFailed()) {
    return {
      controller: createLeafletDotsLayer(map, {
        ...options,
        vectorTilesUrl: null,
      }),
      usedWebgl: false,
    }
  }

  try {
    return {
      controller: createMaplibreDotsLayer(map, options),
      usedWebgl: true,
    }
  } catch (error) {
    markWebglDotsFailed()
    console.warn('MapLibre/WebGL failed, falling back to Leaflet dots', error)
    return {
      controller: createLeafletDotsLayer(map, {
        ...options,
        vectorTilesUrl: null,
      }),
      usedWebgl: false,
    }
  }
}
