export interface BrregAddress {
  adresse?: string[]
  postnummer?: string
  poststed?: string
  kommune?: string
  kommunenummer?: string
  landkode?: string
}

export interface BrregEntity {
  organisasjonsnummer: string
  navn: string
  organisasjonsform?: { kode: string; beskrivelse: string }
  forretningsadresse?: BrregAddress
  postadresse?: BrregAddress
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

export interface OrganizationRow {
  orgnr: string
  navn: string
  org_type: string
  org_type_label: string
  address_text: string | null
  postnummer: string | null
  kommunenummer: string | null
  lat: number | null
  lng: number | null
  konkurs: number
  under_avvikling: number
  vat_registered: number
  deleted: number
  updated_at: string
}
