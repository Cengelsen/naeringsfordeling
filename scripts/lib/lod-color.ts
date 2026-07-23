import {
  dominantOrgType,
  mixOrgTypeColors,
  orgTypeBreakdownJson,
} from '../../src/lib/utils/orgTypeColors.ts'

export type OrgTypeCounts = Map<string, number>

export interface BakedAggregateProps {
  color: string
  count: number
  dominantOrgType: string
  orgTypeBreakdown: string
}

export function bakeAggregateProps(typeCounts: OrgTypeCounts): BakedAggregateProps | null {
  if (typeCounts.size === 0) return null

  const entries = [...typeCounts.entries()]
  const count = entries.reduce((sum, [, value]) => sum + value, 0)
  if (count === 0) return null

  return {
    color: mixOrgTypeColors(entries),
    count,
    dominantOrgType: dominantOrgType(entries),
    orgTypeBreakdown: orgTypeBreakdownJson(entries),
  }
}
