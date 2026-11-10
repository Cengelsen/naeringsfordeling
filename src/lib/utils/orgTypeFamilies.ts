/**
 * Group ~40 org types into 7 visual families for colour-blind-safe map rendering.
 * Uses a Paul Tol qualitative palette that remains distinguishable under
 * deuteranopia, protanopia and tritanopia.
 */

export interface OrgTypeFamily {
  id: string
  label: string
  color: string
  types: readonly string[]
}

export const ORG_TYPE_FAMILIES: readonly OrgTypeFamily[] = [
  {
    id: 'individual',
    label: 'Enkeltpersonforetak',
    color: '#EE7733',
    types: ['ENK', 'PERS', 'IKJP', 'TVAM'],
  },
  {
    id: 'partnership',
    label: 'Ansvarlige selskaper',
    color: '#0077BB',
    types: ['ANS', 'DA', 'KS', 'PRE', 'KTRF'],
  },
  {
    id: 'corporation',
    label: 'Aksje- og kapitalselskaper',
    color: '#33BBEE',
    types: ['AS', 'ASA', 'NUF', 'SE', 'UTLA', 'EOFG'],
  },
  {
    id: 'cooperative',
    label: 'Samvirke og bolig',
    color: '#009988',
    types: ['SA', 'BA', 'SAM', 'ESEK', 'BRL', 'BBL'],
  },
  {
    id: 'voluntary',
    label: 'Frivillig sektor',
    color: '#EE3377',
    types: ['FLI', 'STI', 'KIRK', 'ANNA'],
  },
  {
    id: 'financial',
    label: 'Finansielle og særskilte',
    color: '#CC3311',
    types: ['SPA', 'GFS', 'PK', 'VPFO', 'SÆR', 'BO', 'KBO', 'OPMV'],
  },
  {
    id: 'public',
    label: 'Offentlig og underenheter',
    color: '#BBBBBB',
    types: ['ORGL', 'BEDR', 'AAFY', 'ADOS', 'IKS', 'KF', 'FKF', 'KOMM', 'FYLK', 'SF', 'STAT'],
  },
] as const

const typeToFamily = new Map<string, OrgTypeFamily>()
for (const family of ORG_TYPE_FAMILIES) {
  for (const type of family.types) {
    typeToFamily.set(type, family)
  }
}

export function familyForOrgType(orgType: string): OrgTypeFamily | undefined {
  return typeToFamily.get(orgType)
}

export function familyColorForOrgType(orgType: string): string {
  return typeToFamily.get(orgType)?.color ?? '#BBBBBB'
}
