/** Zoom band for fylke district colour tiles. */
export const FYLKE_MIN_ZOOM = 4
export const FYLKE_MAX_ZOOM = 6

/** Zoom band for kommune district colour tiles (includes z11). */
export const KOMMUNE_MIN_ZOOM = 7
export const KOMMUNE_MAX_ZOOM = 11

/** Zoom band for grunnkrets district colour tiles. */
export const GRUNNKRETS_MIN_ZOOM = KOMMUNE_MAX_ZOOM + 1
/** Last zoom where grunnkrets (or other aggregate) tiles are shown. */
export const GRUNNKRETS_MAX_ZOOM = 14

/** First Leaflet zoom where individual addresses replace district colour tiles. */
export const DETAIL_MIN_ZOOM = 15

export function isDetailZoom(zoom: number | null | undefined): boolean {
  return zoom != null && Number.isFinite(zoom) && zoom >= DETAIL_MIN_ZOOM
}
