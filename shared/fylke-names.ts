export const FYLKE_NAMES: Record<string, string> = {
  '03': 'Oslo',
  '11': 'Rogaland',
  '15': 'Møre og Romsdal',
  '18': 'Nordland',
  '21': 'Svalbard',
  '22': 'Jan Mayen',
  '30': 'Viken',
  '31': 'Østfold',
  '32': 'Akershus',
  '33': 'Buskerud',
  '34': 'Innlandet',
  '38': 'Vestfold og Telemark',
  '39': 'Vestfold',
  '40': 'Telemark',
  '42': 'Agder',
  '46': 'Vestland',
  '50': 'Trøndelag',
  '54': 'Troms og Finnmark',
  '55': 'Troms',
  '56': 'Finnmark',
}

export function fylkeName(kode: string): string {
  return FYLKE_NAMES[kode] ?? `Fylke ${kode}`
}
