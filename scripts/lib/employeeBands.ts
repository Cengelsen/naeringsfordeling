export { EMPLOYEE_BANDS, EMPLOYEE_BAND_LABELS, employeeBand, bandMatchesFilter } from '../../shared/employeeBands.js'
export type { EmployeeBand } from '../../shared/employeeBands.js'

export function naeringskodeSection(kode: string | null | undefined): string | null {
  if (!kode) return null
  const digits = kode.replace(/\D/g, '')
  if (digits.length < 2) return null
  return digits.slice(0, 2)
}
