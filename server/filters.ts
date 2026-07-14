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
}

export function parseFilters(req: {
  query: (key: string) => string | undefined
}): ApiFilters {
  return {
    orgTypes: req.query('orgTypes')?.split(',').filter(Boolean) ?? [],
    excludeKonkurs: req.query('excludeKonkurs') !== 'false',
    excludeUnderAvvikling: req.query('excludeUnderAvvikling') !== 'false',
    vatRegisteredOnly: req.query('vatRegisteredOnly') === 'true',
    kommunenummer: req.query('kommunenummer'),
    fylke: req.query('fylke'),
  }
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
