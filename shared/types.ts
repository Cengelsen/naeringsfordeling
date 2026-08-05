import type { EmployeeBand } from './employeeBands.js'

export type EntityKind = 'enhet' | 'underenhet'

export interface MapFilters {
  orgTypes: string[]
  excludeKonkurs: boolean
  excludeUnderAvvikling: boolean
  vatRegisteredOnly: boolean
  naeringskodeSections: string[]
  employeeBands: EmployeeBand[]
  entityKinds: EntityKind[]
  konsernMode: boolean
  konsernMembersOnly: boolean
}
