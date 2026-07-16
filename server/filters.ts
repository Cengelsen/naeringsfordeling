export interface MapFilters {
  orgTypes: string[]
  excludeKonkurs: boolean
  excludeUnderAvvikling: boolean
  vatRegisteredOnly: boolean
}

export function buildFilterQuery(filters: MapFilters, geocodedOnly = false) {
  const conditions = ['deleted = 0']
  const params: Array<string | number> = []

  if (geocodedOnly) {
    conditions.push('lat IS NOT NULL', 'lng IS NOT NULL')
  }

  if (filters.orgTypes.length > 0) {
    conditions.push(`org_type IN (${filters.orgTypes.map(() => '?').join(',')})`)
    params.push(...filters.orgTypes)
  }

  if (filters.excludeKonkurs) conditions.push('konkurs = 0')
  if (filters.excludeUnderAvvikling) conditions.push('under_avvikling = 0')
  if (filters.vatRegisteredOnly) conditions.push('vat_registered = 1')

  return { conditions, params }
}

export interface ApiFilters extends MapFilters {
  kommunenummer?: string
  fylke?: string
  /** minLng, minLat, maxLng, maxLat */
  bbox?: [number, number, number, number]
  zoom?: number
}

export function parseFilters(req: {
  query: (key: string) => string | undefined
}): ApiFilters {
  const bboxRaw = req.query('bbox')
  let bbox: ApiFilters['bbox']
  if (bboxRaw) {
    const parts = bboxRaw.split(',').map((value) => Number(value.trim()))
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      bbox = parts as [number, number, number, number]
    }
  }

  const zoomRaw = Number(req.query('zoom') ?? '')
  const zoom = Number.isFinite(zoomRaw) ? zoomRaw : undefined

  return {
    orgTypes: req.query('orgTypes')?.split(',').filter(Boolean) ?? [],
    excludeKonkurs: req.query('excludeKonkurs') !== 'false',
    excludeUnderAvvikling: req.query('excludeUnderAvvikling') !== 'false',
    vatRegisteredOnly: req.query('vatRegisteredOnly') === 'true',
    kommunenummer: req.query('kommunenummer'),
    fylke: req.query('fylke'),
    bbox,
    zoom,
  }
}

export function limitForZoom(zoom?: number, explicitLimit?: number): number {
  if (explicitLimit != null) {
    return Math.min(Math.max(1, explicitLimit), 50000)
  }

  if (zoom == null || zoom < 10) return 5000
  if (zoom < 12) return 15000
  if (zoom < 14) return 30000
  return 50000
}

export function appendAreaFilters(filters: ApiFilters, conditions: string[], params: Array<string | number>) {
  if (filters.kommunenummer) {
    const values = filters.kommunenummer.split(',').map((value) => value.trim()).filter(Boolean)
    if (values.length === 1) {
      conditions.push('kommunenummer = ?')
      params.push(values[0])
    } else if (values.length > 1) {
      conditions.push(`kommunenummer IN (${values.map(() => '?').join(',')})`)
      params.push(...values)
    }
  }

  if (filters.fylke) {
    conditions.push('substr(kommunenummer, 1, 2) = ?')
    params.push(filters.fylke)
  }
}

export function appendBboxFilter(
  bbox: [number, number, number, number] | undefined,
  conditions: string[],
  params: Array<string | number>,
) {
  if (!bbox) return

  const [minLng, minLat, maxLng, maxLat] = bbox
  conditions.push('lat >= ?', 'lat <= ?', 'lng >= ?', 'lng <= ?')
  params.push(minLat, maxLat, minLng, maxLng)
}
