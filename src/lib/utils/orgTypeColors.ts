const BASE_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#22c55e',
  '#f59e0b',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#06b6d4',
  '#e11d48',
  '#8b5cf6',
  '#10b981',
  '#d946ef',
  '#0ea5e9',
  '#eab308',
  '#64748b',
  '#78716c',
  '#0891b2',
]

const NAMED: Record<string, string> = {
  AS: '#3b82f6',
  ENK: '#ef4444',
  ASA: '#6366f1',
  NUF: '#f59e0b',
  ANS: '#22c55e',
  DA: '#14b8a6',
  BRL: '#a855f7',
  BBL: '#ec4899',
  SA: '#f97316',
  STI: '#06b6d4',
  FLI: '#84cc16',
  KOMM: '#64748b',
  FYLK: '#475569',
  STAT: '#1e293b',
  KS: '#8b5cf6',
  BA: '#10b981',
}

export function colorForOrgType(kode: string, allTypes: string[]): string {
  if (NAMED[kode]) return NAMED[kode]
  const index = allTypes.indexOf(kode)
  if (index >= 0) return BASE_COLORS[index % BASE_COLORS.length]
  let hash = 0
  for (const char of kode) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return BASE_COLORS[hash % BASE_COLORS.length]
}

export function orgTypeLabels(
  types: Array<{ kode: string; label: string; color: string }>,
): Array<{ kode: string; label: string; color: string }> {
  return types.sort((a, b) => a.label.localeCompare(b.label, 'nb'))
}
