export interface Organisasjonsform {
  kode: string
  beskrivelse: string
}

export interface Kommune {
  nummer: string
  navn: string
}

export interface MapFilters {
  orgTypes: string[]
  excludeKonkurs: boolean
  excludeUnderAvvikling: boolean
  vatRegisteredOnly: boolean
}

export type VisualizationMode = 'choropleth' | 'bubbles'
export type ColorScheme = 'blues' | 'oranges' | 'greens' | 'purples'

export interface MapSettings extends MapFilters {
  visualization: VisualizationMode
  colorScheme: ColorScheme
  showLegend: boolean
  selectedFylke: string
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

export interface KommuneFeatureProperties {
  kommunenummer: string
  kommunenavn: string
  name?: string
}
