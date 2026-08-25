export const EMPLOYEE_BANDS = ['0', '1-4', '5-19', '20+', 'unknown'] as const

export type EmployeeBand = (typeof EMPLOYEE_BANDS)[number]

export const EMPLOYEE_BAND_LABELS: Record<EmployeeBand, string> = {
  '0': '0 ansatte',
  '1-4': '1–4 ansatte',
  '5-19': '5–19 ansatte',
  '20+': '20+ ansatte',
  unknown: 'Ukjent antall',
}

export function employeeBand(
  antallAnsatte: number | null | undefined,
  harRegistrert = false,
): EmployeeBand {
  if (antallAnsatte == null || !harRegistrert) return 'unknown'
  if (antallAnsatte === 0) return '0'
  if (antallAnsatte <= 4) return '1-4'
  if (antallAnsatte <= 19) return '5-19'
  return '20+'
}

export function bandMatchesFilter(band: EmployeeBand, selected: EmployeeBand[]): boolean {
  if (selected.length === 0) return true
  return selected.includes(band)
}

export function employeeBandSql(tableAlias = ''): string {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `CASE
    WHEN ${prefix}har_registrert_antall_ansatte = 0 OR ${prefix}antall_ansatte IS NULL THEN 'unknown'
    WHEN ${prefix}antall_ansatte = 0 THEN '0'
    WHEN ${prefix}antall_ansatte <= 4 THEN '1-4'
    WHEN ${prefix}antall_ansatte <= 19 THEN '5-19'
    ELSE '20+'
  END`
}
