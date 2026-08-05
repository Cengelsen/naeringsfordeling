import L from 'leaflet'
import type { Organization, OrganizationPoint, KonsernNode } from '../types'
import { colorForOrgType } from '../utils/orgTypeColors'
import { naeringskodeSectionLabel } from '../utils/naeringskode'
import {
  fetchOrganizationDetail,
  fetchOrganizationsBatch,
  lookupOrganizationLocal,
  seedOrganizationDetail,
} from '../services/api'
import { normalizeOrgnr, organizationFromPoint } from './points'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return entities[ch] ?? ch
  })
}

export function formatEmployeeCount(org: Organization): string {
  if (org.antallAnsatte == null) return 'Antall ansatte: ukjent'
  return `Antall ansatte: ${org.antallAnsatte.toLocaleString('nb-NO')}`
}

export function orgPopupHtml(org: Organization, konsernHtml = ''): string {
  const naering = org.naeringskode
    ? `Næring: ${escapeHtml(naeringskodeSectionLabel(org.naeringskode.slice(0, 2), org.naeringskodeLabel))}<br/>`
    : ''
  const entityKind =
    org.entityKind === 'underenhet' && org.overordnetEnhet
      ? `Underenhet · mor ${escapeHtml(org.overordnetEnhet)}<br/>`
      : org.entityKind === 'underenhet'
        ? 'Underenhet<br/>'
        : ''
  const geocode =
    org.geocodeQuality === 'mismatch'
      ? '<br/><em>Adressekommune avviker fra BRREG</em>'
      : ''

  return `<strong>${escapeHtml(org.navn)}</strong><br/>
       ${escapeHtml(org.orgTypeLabel ?? '')} (${escapeHtml(org.orgType)})<br/>
       Org.nr ${escapeHtml(org.orgnr)}<br/>
       ${naering}${formatEmployeeCount(org)}<br/>
       ${entityKind}${escapeHtml(org.addressText ?? '')}, ${escapeHtml(org.postnummer ?? '')}${geocode}${konsernHtml}`
}

export function flattenKonsernOrgnrs(node: KonsernNode): string[] {
  const orgnrs = [node.organisasjonsnummer]
  for (const child of node.underenheter ?? []) {
    orgnrs.push(...flattenKonsernOrgnrs(child))
  }
  return orgnrs
}

export function konsernTreeHtml(node: KonsernNode, depth = 0): string {
  const indent = '&nbsp;'.repeat(depth * 2)
  const label = escapeHtml(node.navn ?? node.organisasjonsnummer)
  const line = `<button type="button" class="konsern-link" data-orgnr="${escapeHtml(node.organisasjonsnummer)}">${indent}${label} (${escapeHtml(node.organisasjonsnummer)})</button>`
  const children = (node.underenheter ?? [])
    .map((child) => konsernTreeHtml(child, depth + 1))
    .join('')
  return `${line}${children}`
}

export function addressPopupHtml(
  orgs: Organization[],
  orgTypesForColors: string[],
): string {
  const addressLine =
    orgs[0]?.addressText && orgs[0]?.postnummer
      ? `<p class="address-popup-header"><strong>${escapeHtml(orgs[0].addressText)}, ${escapeHtml(orgs[0].postnummer)}</strong></p>`
      : ''
  const items = orgs
    .map((org) => {
      const color = colorForOrgType(org.orgType, orgTypesForColors)
      return `<div class="address-popup-item">
          <span class="address-popup-swatch" style="background:${color}"></span>
          <div>
            <strong>${escapeHtml(org.navn)}</strong><br/>
            ${escapeHtml(org.orgTypeLabel ?? '')} (${escapeHtml(org.orgType)})<br/>
            Org.nr ${escapeHtml(org.orgnr)}
          </div>
        </div>`
    })
    .join('')

  return `${addressLine}<p class="address-popup-summary">${orgs.length} organisasjoner på denne adressen</p><div class="address-popup-list">${items}</div>`
}

export function formatOrgTypeBreakdownHtml(
  breakdownJson: string | undefined,
  orgForms: Array<{ kode: string; beskrivelse: string }>,
  limit = 6,
): string {
  if (!breakdownJson) return ''
  try {
    const breakdown = JSON.parse(breakdownJson) as Record<string, number>
    const lines = Object.entries(breakdown)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([kode, count]) => {
        const label = orgForms.find((form) => form.kode === kode)?.beskrivelse ?? kode
        return `${escapeHtml(label)}: ${count.toLocaleString('nb-NO')}`
      })
    if (lines.length === 0) return ''
    return `<br><br>${lines.join('<br>')}`
  } catch {
    return ''
  }
}

export function formatOrgTypeBreakdownFromRecord(
  byOrgType: Record<string, number>,
  orgForms: Array<{ kode: string; beskrivelse: string }>,
  limit = 6,
): string {
  const lines = Object.entries(byOrgType)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([kode, count]) => {
      const label = orgForms.find((form) => form.kode === kode)?.beskrivelse ?? kode
      return `${escapeHtml(label)}: ${count.toLocaleString('nb-NO')}`
    })
  if (lines.length === 0) return ''
  return `<br><br>${lines.join('<br>')}`
}

export function wireKonsernPopupLinks(
  popup: L.Popup,
  onNavigate: (orgnr: string) => void,
) {
  const element = popup.getElement()
  if (!element) return

  element.querySelectorAll<HTMLButtonElement>('.konsern-link').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const orgnr = button.dataset.orgnr
      if (orgnr) onNavigate(orgnr)
    })
  })
}

export function resolveOrganizationFromPoints(
  orgnr: string,
  allPoints: OrganizationPoint[],
): Organization | null {
  const point = allPoints.find((entry) => normalizeOrgnr(entry.orgnr) === normalizeOrgnr(orgnr))
  return point ? organizationFromPoint(point) : null
}

export async function resolveOrganization(
  orgnr: string,
  allPoints: OrganizationPoint[],
): Promise<Organization> {
  const fromPoints = resolveOrganizationFromPoints(orgnr, allPoints)
  if (fromPoints) {
    seedOrganizationDetail(fromPoints)
    return fromPoints
  }

  const local = await lookupOrganizationLocal(orgnr)
  if (local) {
    seedOrganizationDetail(local)
    return local
  }

  return fetchOrganizationDetail(orgnr)
}

export async function resolveOrganizations(
  orgnrs: string[],
  allPoints: OrganizationPoint[],
): Promise<Organization[]> {
  const fromPoints = new Map<string, Organization>()
  const missing: string[] = []

  for (const orgnr of orgnrs) {
    const pointOrg = resolveOrganizationFromPoints(orgnr, allPoints)
    if (pointOrg) {
      seedOrganizationDetail(pointOrg)
      fromPoints.set(normalizeOrgnr(orgnr), pointOrg)
    } else {
      missing.push(orgnr)
    }
  }

  if (missing.length === 0) {
    return orgnrs
      .map((orgnr) => fromPoints.get(normalizeOrgnr(orgnr)))
      .filter((org): org is Organization => org != null)
  }

  const fetched = await fetchOrganizationsBatch(missing)
  for (const org of fetched) {
    fromPoints.set(normalizeOrgnr(org.orgnr), org)
  }

  return orgnrs
    .map((orgnr) => fromPoints.get(normalizeOrgnr(orgnr)))
    .filter((org): org is Organization => org != null)
}

export function seedHint(hint?: Partial<OrganizationPoint> | null) {
  if (!hint?.orgnr || !hint.navn) return
  const org = organizationFromPoint({
    orgnr: hint.orgnr,
    orgType: hint.orgType ?? '',
    lat: hint.lat ?? 0,
    lng: hint.lng ?? 0,
    navn: hint.navn,
    orgTypeLabel: hint.orgTypeLabel,
    addressText: hint.addressText,
    postnummer: hint.postnummer,
    kommunenummer: hint.kommunenummer,
  })
  if (org) seedOrganizationDetail(org)
}
