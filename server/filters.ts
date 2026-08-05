import type { EmployeeBand } from '../shared/employeeBands.js'
import type { EntityKind, MapFilters } from '../shared/types.js'

export type { MapFilters }

export function employeeBandSql(tableAlias = ''): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `CASE
    WHEN ${prefix}har_registrert_antall_ansatte = 0 OR ${prefix}antall_ansatte IS NULL THEN 'unknown'
    WHEN ${prefix}antall_ansatte = 0 THEN '0'
    WHEN ${prefix}antall_ansatte <= 4 THEN '1-4'
    WHEN ${prefix}antall_ansatte <= 19 THEN '5-19'
    ELSE '20+'
  END`
}

export function naeringskodeSectionSql(tableAlias = ''): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `substr(${prefix}naeringskode, 1, 2)`
}

export function buildFilterQuery(filters: MapFilters, geocodedOnly = false, tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  const conditions = [`${prefix}deleted = 0`]
  const params: Array<string | number> = []

  if (geocodedOnly) {
    conditions.push(`${prefix}lat IS NOT NULL`, `${prefix}lng IS NOT NULL`)
  }

  if (filters.orgTypes.length > 0) {
    conditions.push(`${prefix}org_type IN (${filters.orgTypes.map(() => '?').join(',')})`)
    params.push(...filters.orgTypes)
  }

  if (filters.excludeKonkurs) conditions.push(`${prefix}konkurs = 0`)
  if (filters.excludeUnderAvvikling) conditions.push(`${prefix}under_avvikling = 0`)
  if (filters.vatRegisteredOnly) conditions.push(`${prefix}vat_registered = 1`)

  if (filters.naeringskodeSections.length > 0) {
    conditions.push(
      `${prefix}naeringskode_section IN (${filters.naeringskodeSections.map(() => '?').join(',')})`,
    )
    params.push(...filters.naeringskodeSections)
  }

  if (filters.employeeBands.length > 0) {
    conditions.push(
      `${prefix}employee_band IN (${filters.employeeBands.map(() => '?').join(',')})`,
    )
    params.push(...filters.employeeBands)
  }

  if (filters.entityKinds.length > 0) {
    conditions.push(
      `${prefix}entity_kind IN (${filters.entityKinds.map(() => '?').join(',')})`,
    )
    params.push(...filters.entityKinds)
  }

  if (filters.konsernMembersOnly) {
    conditions.push(`${prefix}er_i_konsern = 1`)
  }

  return { conditions, params }
}

export interface ApiFilters extends MapFilters {
  kommunenummer?: string
  fylke?: string
  /** minLng, minLat, maxLng, maxLat */
  bbox?: [number, number, number, number]
  zoom?: number
}

const VALID_EMPLOYEE_BANDS = new Set<EmployeeBand>(['0', '1-4', '5-19', '20+', 'unknown'])
const VALID_ENTITY_KINDS = new Set<EntityKind>(['enhet', 'underenhet'])

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

  const entityKindsRaw = req.query('entityKinds')
  const entityKinds = entityKindsRaw
    ? entityKindsRaw
        .split(',')
        .filter((value): value is EntityKind => VALID_ENTITY_KINDS.has(value as EntityKind))
    : (['enhet'] as EntityKind[])

  const employeeBandsRaw = req.query('employeeBands')
  const employeeBands = employeeBandsRaw
    ? employeeBandsRaw
        .split(',')
        .filter((value): value is EmployeeBand => VALID_EMPLOYEE_BANDS.has(value as EmployeeBand))
    : []

  const naeringskodeSections =
    req
      .query('naeringskodeSections')
      ?.split(',')
      .map((value) => value.trim())
      .filter((value) => /^\d{2}$/.test(value)) ?? []

  return {
    orgTypes: req.query('orgTypes')?.split(',').filter(Boolean) ?? [],
    excludeKonkurs: req.query('excludeKonkurs') !== 'false',
    excludeUnderAvvikling: req.query('excludeUnderAvvikling') !== 'false',
    vatRegisteredOnly: req.query('vatRegisteredOnly') === 'true',
    naeringskodeSections,
    employeeBands,
    entityKinds,
    konsernMembersOnly: req.query('konsernMembersOnly') === 'true',
    kommunenummer: req.query('kommunenummer'),
    fylke: req.query('fylke'),
    bbox,
    zoom,
  }
}

export { limitForZoom, MAX_VIEWPORT_DOTS } from '../scripts/lib/point-sampling.js'

export function appendAreaFilters(
  filters: ApiFilters,
  conditions: string[],
  params: Array<string | number>,
  tableAlias = '',
) {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  if (filters.kommunenummer) {
    const values = filters.kommunenummer.split(',').map((value) => value.trim()).filter(Boolean)
    if (values.length === 1) {
      conditions.push(`${prefix}kommunenummer = ?`)
      params.push(values[0])
    } else if (values.length > 1) {
      conditions.push(`${prefix}kommunenummer IN (${values.map(() => '?').join(',')})`)
      params.push(...values)
    }
  }

  if (filters.fylke) {
    conditions.push(`substr(${prefix}kommunenummer, 1, 2) = ?`)
    params.push(filters.fylke)
  }
}

export function appendBboxFilter(
  bbox: [number, number, number, number] | undefined,
  conditions: string[],
  params: Array<string | number>,
  tableAlias = '',
) {
  if (!bbox) return

  const prefix = tableAlias ? `${tableAlias}.` : ''
  const [minLng, minLat, maxLng, maxLat] = bbox
  conditions.push(
    `${prefix}lat >= ?`,
    `${prefix}lat <= ?`,
    `${prefix}lng >= ?`,
    `${prefix}lng <= ?`,
  )
  params.push(minLat, maxLat, minLng, maxLng)
}

/** R-tree intersection params for bbox [minLng, minLat, maxLng, maxLat]. */
export function rtreeBboxParams(bbox: [number, number, number, number]) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  return [minLng, maxLng, minLat, maxLat]
}
