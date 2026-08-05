import L from 'leaflet'
import type { OrganizationPoint } from '../types'
import { normalizeOrgnr } from './points'

let konsernOverlay: L.LayerGroup | null = null

export function clearKonsernOverlay() {
  konsernOverlay?.remove()
  konsernOverlay = null
}

export function showKonsernOverlay(
  map: L.Map,
  rootOrgnr: string,
  memberOrgnrs: string[],
  allPoints: OrganizationPoint[],
) {
  clearKonsernOverlay()

  const rootPoint = allPoints.find(
    (point) => normalizeOrgnr(point.orgnr) === normalizeOrgnr(rootOrgnr),
  )
  if (!rootPoint) return

  konsernOverlay = L.layerGroup().addTo(map)
  const rootLatLng = L.latLng(rootPoint.lat, rootPoint.lng)

  for (const orgnr of memberOrgnrs) {
    if (normalizeOrgnr(orgnr) === normalizeOrgnr(rootOrgnr)) continue
    const member = allPoints.find(
      (point) => normalizeOrgnr(point.orgnr) === normalizeOrgnr(orgnr),
    )
    if (!member) continue

    L.polyline([rootLatLng, L.latLng(member.lat, member.lng)], {
      color: '#64748b',
      weight: 1.5,
      opacity: 0.55,
      dashArray: '6 6',
    }).addTo(konsernOverlay)
  }
}
