import type { ColorScheme, MapSettings, VisualizationMode } from '../types'

export const defaultSettings: MapSettings = {
  orgTypes: [],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  visualization: 'choropleth',
  colorScheme: 'blues',
  showLegend: true,
  selectedFylke: '',
}

export const mapSettings = $state<MapSettings>({ ...defaultSettings })

export function resetSettings() {
  Object.assign(mapSettings, defaultSettings)
}

export function toggleOrgType(kode: string) {
  if (mapSettings.orgTypes.includes(kode)) {
    mapSettings.orgTypes = mapSettings.orgTypes.filter((k) => k !== kode)
  } else {
    mapSettings.orgTypes = [...mapSettings.orgTypes, kode]
  }
}

export function setVisualization(mode: VisualizationMode) {
  mapSettings.visualization = mode
}

export function setColorScheme(scheme: ColorScheme) {
  mapSettings.colorScheme = scheme
}
