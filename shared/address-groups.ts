export const LOCATION_PRECISION = 5

export function locationKey(lat: number, lng: number): string {
  return `${lat.toFixed(LOCATION_PRECISION)}:${lng.toFixed(LOCATION_PRECISION)}`
}

export function addressGroupKey(
  lat: number,
  lng: number,
  adresseId?: string | null,
): string {
  const id = adresseId?.trim()
  if (id) return `id:${id}`
  return `ll:${locationKey(lat, lng)}`
}
