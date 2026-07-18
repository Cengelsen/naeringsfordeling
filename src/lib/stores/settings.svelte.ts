import type { ColorScheme, DistrictLevel, MapSettings, VisualizationMode } from '../types'

export const defaultSettings: MapSettings = {
  orgTypes: [],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  visualization: 'choropleth',
  districtLevel: 'kommune',
  colorScheme: 'blues',
  showLegend: true,
  selectedFylke: '',
  selectedKommune: '',
  dotsDetailMinZoom: 12,
}

export const mapSettings = $state<MapSettings>({ ...defaultSettings })

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

export function setDistrictLevel(level: DistrictLevel) {
  mapSettings.districtLevel = level
  if (level === 'fylke') {
    mapSettings.selectedKommune = ''
  }
}

export function setColorScheme(scheme: ColorScheme) {
  mapSettings.colorScheme = scheme
}
