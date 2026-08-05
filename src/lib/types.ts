export interface Organisasjonsform {
  kode: string
  beskrivelse: string
}

export interface Kommune {
  nummer: string
  navn: string
}

export interface BrregAddress {
  adresse?: string[]
  postnummer?: string
  poststed?: string
  kommune?: string
  kommunenummer?: string
  landkode?: string
}

export type { MapFilters, EntityKind } from '../../shared/types'
import type { MapFilters } from '../../shared/types'

export type VisualizationMode = 'choropleth' | 'dots'
export type DistrictLevel = 'fylke' | 'kommune'
export type ColorScheme = 'blues' | 'oranges' | 'greens' | 'purples'

export interface MapSettings extends MapFilters {
  visualization: VisualizationMode
  /** Aggregation level when visualization is choropleth (Distrikter) */
  districtLevel: DistrictLevel
  colorScheme: ColorScheme
  showLegend: boolean
  selectedFylke: string
  selectedKommune: string
  /** Map zoom at which individual address dots use detail styling */
  dotsDetailMinZoom: number
}

export interface MunicipalityCount {
  kommunenummer: string
  count: number
}

export interface LoadingState {
  loading: boolean
  progress: number
  total: number
  error: string | null
}

export interface DotsLoadState {
  loading: boolean
  phase: 'idle' | 'fetching' | 'geocoding'
  organizations: number
  geocoded: number
  skipped: number
  kommuner: number
  message: string | null
  /** True when MapLibre could not start (e.g. WebGL disabled in LibreWolf) */
  webglUnavailable?: boolean
  viewportSummary?: ViewportSummary | null
  /** True while viewport address/org stats are being calculated. */
  statsLoading?: boolean
  renderedFeatureCount?: number
  statsApproximate?: boolean
}

export interface ViewportSummary {
  totalInViewport: number
  geocodedInBbox: number
  /** Unique addresses among geocoded orgs in the bbox (all zoom levels). */
  addressesInBbox: number
  ungeocodedInViewport: number
  byOrgType: Record<string, number>
  renderMode: 'aggregate' | 'individual'
  kommunerInViewport: number
}

export interface Organization {
  orgnr: string
  navn: string
  orgType: string
  orgTypeLabel: string
  addressText: string
  postnummer: string
  kommunenummer: string
  lat: number | null
  lng: number | null
  naeringskode?: string | null
  naeringskodeLabel?: string | null
  antallAnsatte?: number | null
  employeeBand?: import('./utils/employeeBands').EmployeeBand
  entityKind?: 'enhet' | 'underenhet'
  overordnetEnhet?: string | null
  erIKonsern?: boolean
  geocodeQuality?: string | null
  matrikkelKey?: string | null
}

export interface KonsernNode {
  organisasjonsnummer: string
  navn?: string
  organisasjonsform?: { kode?: string; beskrivelse?: string }
  underenheter?: KonsernNode[]
}

export interface Konsernstruktur {
  organisasjonsnummer: string
  navn?: string
  underenheter?: KonsernNode[]
}

export interface OrganizationSearchHit {
  orgnr: string
  navn: string
  orgType: string
  orgTypeLabel: string
  kommunenummer: string
  lat: number | null
  lng: number | null
  addressText?: string
  postnummer?: string
}

export type OrganizationLocationSource = 'database' | 'cache' | 'geocoded' | 'none'

export interface OrganizationLocation {
  orgnr: string
  lat: number | null
  lng: number | null
  kommunenummer: string
  source: OrganizationLocationSource
}

/** Compact point payload for map rendering */
export interface OrganizationPoint {
  orgnr: string
  orgType: string
  lat: number
  lng: number
  navn?: string
  orgTypeLabel?: string
  addressText?: string
  postnummer?: string
  kommunenummer?: string
  naeringskode?: string | null
  employeeBand?: import('./utils/employeeBands').EmployeeBand
  entityKind?: 'enhet' | 'underenhet'
  /** Kartverket address id when geocoded; used to group co-located orgs. */
  adresseId?: string | null
  /**
   * When set, this point is already one feature per address (API/bake).
   * `orgnrs` lists all organisations at the address.
   */
  orgCount?: number
  orgnrs?: string
  typeList?: string
}

export interface KommuneFeatureProperties {
  kommunenummer: string
  kommunenavn: string
  name?: string
}

export interface FylkeFeatureProperties {
  fylkesnummer: string
  fylkesnavn: string
}

export interface BrregEntity {
  organisasjonsnummer: string
  navn: string
  organisasjonsform?: { kode: string; beskrivelse: string }
  forretningsadresse?: BrregAddress
  postadresse?: BrregAddress
}
