export function sectionMatchesFilter(
  section: string | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true
  if (!section) return false
  return selected.includes(section)
}
