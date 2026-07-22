import type { ColorScheme, DistrictLevel, MapSettings, VisualizationMode } from '../types'

export const defaultSettings: MapSettings = {
  orgTypes: [],
  excludeKonkurs: true,
  excludeUnderAvvikling: true,
  vatRegisteredOnly: false,
  naeringskodeSections: [],
  employeeBands: [],
  entityKinds: ['enhet'],
  konsernMode: false,
  konsernMembersOnly: false,
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

export function toggleNaeringskodeSection(section: string) {
  if (mapSettings.naeringskodeSections.includes(section)) {
    mapSettings.naeringskodeSections = mapSettings.naeringskodeSections.filter((s) => s !== section)
  } else {
    mapSettings.naeringskodeSections = [...mapSettings.naeringskodeSections, section]
  }
}

export function toggleEmployeeBand(band: import('../utils/employeeBands').EmployeeBand) {
  if (mapSettings.employeeBands.includes(band)) {
    mapSettings.employeeBands = mapSettings.employeeBands.filter((b) => b !== band)
  } else {
    mapSettings.employeeBands = [...mapSettings.employeeBands, band]
  }
}

export function toggleEntityKind(kind: 'enhet' | 'underenhet') {
  if (mapSettings.entityKinds.includes(kind)) {
    const next = mapSettings.entityKinds.filter((k) => k !== kind)
    mapSettings.entityKinds = next.length > 0 ? next : ['enhet']
  } else {
    mapSettings.entityKinds = [...mapSettings.entityKinds, kind]
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
