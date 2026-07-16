export function jitterCoordinates(
  lat: number,
  lng: number,
  index: number,
  total: number,
): [number, number] {
  if (total <= 1) return [lat, lng]
  const angle = (index / total) * Math.PI * 2
  const radius = 0.00008 * Math.min(total, 8)
  return [lat + Math.cos(angle) * radius, lng + Math.sin(angle) * radius]
}
