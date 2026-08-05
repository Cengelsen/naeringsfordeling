import L from 'leaflet'
import type { KonsernNode, Organization, OrganizationPoint, Organisasjonsform } from '../types'
import { fetchKonsernstruktur } from '../services/api'
import { organizationFromPoint } from './points'
import {
  orgPopupHtml,
  flattenKonsernOrgnrs,
  konsernTreeHtml,
  addressPopupHtml,
  formatOrgTypeBreakdownHtml,
  wireKonsernPopupLinks,
  resolveOrganization,
  resolveOrganizations,
  seedHint,
} from './organizationPopups'
import { clearKonsernOverlay, showKonsernOverlay } from './konsernOverlayController'

export interface PopupContext {
  getMap: () => L.Map | null
  getAllPoints: () => OrganizationPoint[]
  getSettings: () => { konsernMode: boolean }
  getOrgForms: () => Organisasjonsform[]
  navigateToOrganization: (orgnr: string) => void
}

export function showOrganizationDetails(
  ctx: PopupContext,
  org: Organization,
  latlng: L.LatLng,
  note?: string,
) {
  const map = ctx.getMap()
  if (!map) return
  const extra = note ? `<br/><em>${note}</em>` : ''
  L.popup({ maxWidth: 320 })
    .setLatLng(latlng)
    .setContent(`${orgPopupHtml(org)}${extra}`)
    .openOn(map)
}

export async function showOrganizationPopup(
  ctx: PopupContext,
  orgnr: string,
  latlng: L.LatLng,
  note?: string,
  hint?: Partial<OrganizationPoint> | null,
) {
  const map = ctx.getMap()
  if (!map) return

  seedHint(hint)
  const popup = L.popup({ maxWidth: 360, className: 'org-popup' })
    .setLatLng(latlng)
    .setContent('Laster organisasjon…')
    .openOn(map)

  const hinted =
    hint?.orgnr && hint.navn
      ? organizationFromPoint({
          orgnr: hint.orgnr,
          orgType: hint.orgType ?? '',
          lat: latlng.lat,
          lng: latlng.lng,
          navn: hint.navn,
          orgTypeLabel: hint.orgTypeLabel,
          addressText: hint.addressText,
          postnummer: hint.postnummer,
          kommunenummer: hint.kommunenummer,
        })
      : null
  if (hinted) {
    const extra = note ? `<br/><em>${note}</em>` : ''
    popup.setContent(`${orgPopupHtml(hinted)}${extra}`)
  }

  map.once('popupclose', clearKonsernOverlay)

  try {
    const allPoints = ctx.getAllPoints()
    const org = await resolveOrganization(orgnr, allPoints)
    const extra = note ? `<br/><em>${note}</em>` : ''
    popup.setContent(`${orgPopupHtml(org)}${extra}`)

    if (ctx.getSettings().konsernMode && org.erIKonsern) {
      const konsern = await fetchKonsernstruktur(orgnr)
      if (konsern) {
        const tree = konsernTreeHtml(konsern as KonsernNode)
        popup.setContent(
          `${orgPopupHtml(org, `<hr/><p><strong>Konsern</strong></p><div class="konsern-tree">${tree}</div>`)}${extra}`,
        )
        wireKonsernPopupLinks(popup, (nav) => void ctx.navigateToOrganization(nav))
        const members = flattenKonsernOrgnrs(konsern as KonsernNode)
        showKonsernOverlay(map, orgnr, members, allPoints)
      }
    }
  } catch (err) {
    popup.setContent(err instanceof Error ? err.message : 'Kunne ikke vise organisasjon')
  }
}

export async function showAddressPopup(
  ctx: PopupContext,
  orgnrs: string[],
  latlng: L.LatLng,
  hint?: Partial<OrganizationPoint> | null,
) {
  const map = ctx.getMap()
  if (!map) return

  seedHint(hint)
  const popup = L.popup({ maxWidth: 360, className: 'address-popup' })
    .setLatLng(latlng)
    .setContent('Laster organisasjoner…')
    .openOn(map)

  if (hint?.addressText && hint?.postnummer) {
    popup.setContent(
      `<p class="address-popup-header"><strong>${hint.addressText}, ${hint.postnummer}</strong></p><p class="address-popup-summary">Laster ${orgnrs.length} organisasjoner…</p>`,
    )
  }

  try {
    const allPoints = ctx.getAllPoints()
    const orgs = await resolveOrganizations(orgnrs, allPoints)
    orgs.sort((a, b) => a.navn.localeCompare(b.navn, 'nb'))
    popup.setContent(addressPopupHtml(orgs, [...new Set(allPoints.map((p) => p.orgType))].sort()))
  } catch (err) {
    popup.setContent(err instanceof Error ? err.message : 'Kunne ikke vise organisasjoner')
  }
}

export function handleMarkerClick(
  ctx: PopupContext,
  orgnrs: string[],
  latlng: L.LatLng,
  hint?: Partial<OrganizationPoint> | null,
) {
  if (orgnrs.length === 1) {
    void showOrganizationPopup(ctx, orgnrs[0]!, latlng, undefined, hint)
  } else {
    void showAddressPopup(ctx, orgnrs, latlng, hint)
  }
}

export function handleAggregateClick(
  map: L.Map | null,
  orgForms: Organisasjonsform[],
  info: {
    orgType: string
    count: number
    latlng: L.LatLng
    label?: string
    total?: number
    districtLevel?: string
    orgTypeBreakdown?: string
  },
) {
  if (!map) return
  const place =
    info.label ??
    (info.districtLevel === 'fylke'
      ? 'Fylke'
      : info.districtLevel === 'grunnkrets'
        ? 'Grunnkrets'
        : 'Kommune')
  const totalLine =
    info.total != null
      ? `<br>${info.total.toLocaleString('nb-NO')} organisasjoner totalt i ${place}`
      : ''
  const breakdownLine = formatOrgTypeBreakdownHtml(info.orgTypeBreakdown, orgForms)
  L.popup({ maxWidth: 320 })
    .setLatLng(info.latlng)
    .setContent(
      `<strong>${place}</strong>${totalLine}${breakdownLine}<br><em>Zoom inn for enkeltadresser</em>`,
    )
    .openOn(map)
}
