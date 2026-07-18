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

export interface MapFilters {
  orgTypes: string[]
  excludeKonkurs: boolean
  excludeUnderAvvikling: boolean
  vatRegisteredOnly: boolean
}

export type VisualizationMode = 'choropleth' | 'bubbles' | 'dots'
export type ColorScheme = 'blues' | 'oranges' | 'greens' | 'purples'

export interface MapSettings extends MapFilters {
  visualization: VisualizationMode
  colorScheme: ColorScheme
  showLegend: boolean
  selectedFylke: string
  selectedKommune: string
  /** Map zoom at which individual address dots replace clusters */
  dotsDetailMinZoom: number
  /** Group nearby dots into count bubbles when zoomed out */
  dotsClustering: boolean
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
}

export interface Organization {
  orgnr: string
  navn: string
  orgType: string
  orgTypeLabel: string
  addressText: string
  postnummer: string
  kommunenummer: string
  lat: number
  lng: number
}

/** Compact point payload for map rendering */
export interface OrganizationPoint {
  orgnr: string
  orgType: string
  lat: number
  lng: number
}

export interface KommuneFeatureProperties {
  kommunenummer: string
  kommunenavn: string
  name?: string
}

export interface BrregEntity {
  organisasjonsnummer: string
  navn: string
  organisasjonsform?: { kode: string; beskrivelse: string }
  forretningsadresse?: BrregAddress
  postadresse?: BrregAddress
}
