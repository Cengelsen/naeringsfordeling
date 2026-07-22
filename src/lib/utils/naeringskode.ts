/** Common NACE section labels (2-digit prefix). */
export const NAERINGSKODE_SECTION_LABELS: Record<string, string> = {
  '01': 'Landbruk',
  '02': 'Skogbruk',
  '03': 'Fiske og fangst',
  '05': 'Bergverksdrift',
  '06': 'Olje og gass',
  '07': 'Bergverksdrift',
  '08': 'Annet bergverk',
  '09': 'Bergverksdrift',
  '10': 'Næringsmiddel',
  '11': 'Drikkevarer',
  '13': 'Tekstil',
  '14': 'Klær',
  '15': 'Lær og sko',
  '16': 'Trevarer',
  '17': 'Papir',
  '18': 'Trykking',
  '20': 'Kjemikalier',
  '21': 'Farmasi',
  '22': 'Plast og gummi',
  '23': 'Mineralprodukter',
  '24': 'Metall',
  '25': 'Metallvarer',
  '26': 'Elektronikk',
  '27': 'Elektrisk utstyr',
  '28': 'Maskiner',
  '29': 'Motorvogner',
  '30': 'Transportmidler',
  '31': 'Møbler',
  '32': 'Annet industri',
  '33': 'Reparasjon',
  '35': 'Kraftforsyning',
  '36': 'Vannforsyning',
  '37': 'Avløp',
  '38': 'Avfall',
  '39': 'Sanering',
  '41': 'Bygg',
  '42': 'Anlegg',
  '43': 'Spesialisert bygg',
  '45': 'Handel med motorvogner',
  '46': 'Engroshandel',
  '47': 'Detaljhandel',
  '49': 'Landtransport',
  '50': 'Sjøtransport',
  '51': 'Lufttransport',
  '52': 'Lagring',
  '53': 'Post og kurér',
  '55': 'Overnatting',
  '56': 'Servering',
  '58': 'Forlag',
  '59': 'Film og musikk',
  '60': 'Kringkasting',
  '61': 'Telekom',
  '62': 'IT-tjenester',
  '63': 'Informasjonstjenester',
  '64': 'Finans',
  '65': 'Forsikring',
  '66': 'Finansielle hjelpetjenester',
  '68': 'Eiendom',
  '69': 'Juridisk og regnskap',
  '70': 'Hovedkontortjenester',
  '71': 'Arkitekt og teknisk',
  '72': 'Forskning',
  '73': 'Reklame',
  '74': 'Annen faglig',
  '75': 'Veterinær',
  '77': 'Utleie',
  '78': 'Arbeidskraft',
  '79': 'Reisebyrå',
  '80': 'Vakttjenester',
  '81': 'Eiendomsservice',
  '82': 'Kontortjenester',
  '84': 'Offentlig administrasjon',
  '85': 'Undervisning',
  '86': 'Helse',
  '87': 'Institusjoner',
  '88': 'Sosial omsorg',
  '90': 'Kunst',
  '91': 'Bibliotek og museum',
  '92': 'Lotteri',
  '93': 'Sport og fritid',
  '94': 'Medlemsorganisasjoner',
  '95': 'Reparasjon av varer',
  '96': 'Personlig tjenesteyting',
  '97': 'Husholdninger',
  '99': 'Internasjonale org.',
}

export function naeringskodeSection(kode: string | null | undefined): string | null {
  if (!kode) return null
  const digits = kode.replace(/\D/g, '')
  if (digits.length < 2) return null
  return digits.slice(0, 2)
}

export function naeringskodeSectionLabel(section: string, fallbackLabel?: string | null): string {
  const label = NAERINGSKODE_SECTION_LABELS[section]
  if (label) return `${section} – ${label}`
  if (fallbackLabel) return `${section} – ${fallbackLabel}`
  return section
}

export function sectionMatchesFilter(
  section: string | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true
  if (!section) return false
  return selected.includes(section)
}
