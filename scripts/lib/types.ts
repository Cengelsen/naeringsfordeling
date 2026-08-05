export interface BrregAddress {
  adresse?: string[]
  postnummer?: string
  poststed?: string
  kommune?: string
  kommunenummer?: string
  landkode?: string
}

export interface BrregNaeringskode {
  kode: string
  beskrivelse: string
}

export interface BrregEntity {
  organisasjonsnummer: string
  navn: string
  organisasjonsform?: { kode: string; beskrivelse: string }
  forretningsadresse?: BrregAddress
  postadresse?: BrregAddress
  naeringskode1?: BrregNaeringskode
  antallAnsatte?: number
  harRegistrertAntallAnsatte?: boolean
  erIKonsern?: boolean
  overordnetEnhet?: string
  konkurs?: boolean
  underAvvikling?: boolean
  registrertIMvaregisteret?: boolean
  slettedato?: string | null
}

export interface BrregUnderenhet {
  organisasjonsnummer: string
  navn: string
  organisasjonsform?: { kode: string; beskrivelse: string }
  beliggenhetsadresse?: BrregAddress
  postadresse?: BrregAddress
  overordnetEnhet: string
  naeringskode1?: BrregNaeringskode
  antallAnsatte?: number
  harRegistrertAntallAnsatte?: boolean
  konkurs?: boolean
  underAvvikling?: boolean
  registrertIMvaregisteret?: boolean
  slettedato?: string | null
}

export interface BrregUpdate {
  oppdateringsid: number
  dato: string
  organisasjonsnummer: string
  endringstype: string
}

export type { EntityKind } from '../../shared/types.js'
import type { EntityKind } from '../../shared/types.js'

export type GeocodeQuality = 'verified' | 'fallback' | 'mismatch' | 'failed'

export interface OrganizationRecord {
  orgnr: string
  navn: string
  org_type: string
  org_type_label: string
  address_text: string | null
  postnummer: string | null
  kommunenummer: string | null
  address_key: string | null
  konkurs: number
  under_avvikling: number
  vat_registered: number
  deleted: number
  updated_at: string
  entity_kind: EntityKind
  overordnet_enhet: string | null
  naeringskode: string | null
  naeringskode_label: string | null
  antall_ansatte: number | null
  har_registrert_antall_ansatte: number
  er_i_konsern: number
  adresse_id: string | null
  matrikkel_key: string | null
  kommunenummer_geo: string | null
  geocode_quality: GeocodeQuality | null
}
