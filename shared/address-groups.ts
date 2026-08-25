export const LOCATION_PRECISION = 5

export function locationKey(lat: number, lng: number): string {
  return `${lat.toFixed(LOCATION_PRECISION)}:${lng.toFixed(LOCATION_PRECISION)}`
}

export function addressGroupKey(lat: number, lng: number, adresseId?: string | null): string {
  const id = adresseId?.trim()
  if (id) return `id:${id}`
  return `ll:${locationKey(lat, lng)}`
}

/** SQLite expression matching `addressGroupKey` (printf %.5f ≈ toFixed(5)). */
export function addressGroupKeySql(tableAlias = 'o'): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `CASE
    WHEN ${prefix}adresse_id IS NOT NULL AND trim(${prefix}adresse_id) != ''
    THEN 'id:' || trim(${prefix}adresse_id)
    ELSE 'll:' || printf('%.${LOCATION_PRECISION}f', ${prefix}lat)
      || ':' || printf('%.${LOCATION_PRECISION}f', ${prefix}lng)
  END`
}
