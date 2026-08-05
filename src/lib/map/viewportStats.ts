import type { DotsLoadState, MapSettings } from '../types'
import { fetchViewportSummary } from '../services/api'

export interface ViewportStatsContext {
  getMap(): L.Map | null
  getSettings(): MapSettings
  isOrgFocusActive(): boolean
  getKommunerInBounds(): string[]
  getBbox(bounds: L.LatLngBounds): [number, number, number, number]
  updateDotsState(partial: Partial<DotsLoadState>): void
  updateRenderedFeatureCount(): void
  abortPrevious(): AbortSignal
}

export async function loadViewportSummary(ctx: ViewportStatsContext) {
  const map = ctx.getMap()
  const settings = ctx.getSettings()
  if (!map || settings.visualization !== 'dots' || ctx.isOrgFocusActive()) return

  const targetKommuner = ctx.getKommunerInBounds()
  const zoom = map.getZoom()
  const bounds = map.getBounds()
  const bbox = ctx.getBbox(bounds)
  const signal = ctx.abortPrevious()

  ctx.updateDotsState({
    statsLoading: true,
    viewportSummary: null,
    statsApproximate: false,
  })

  try {
    const { summary, approximate } = await fetchViewportSummary(settings, {
      bbox,
      zoom,
      kommunenumre: targetKommuner,
    }, signal)
    if (signal.aborted) return

    ctx.updateDotsState({
      statsLoading: false,
      viewportSummary: summary,
      statsApproximate: approximate,
      geocoded: summary.geocodedInBbox,
      organizations: summary.geocodedInBbox,
      skipped: summary.ungeocodedInViewport,
      kommuner: summary.kommunerInViewport,
    })
    ctx.updateRenderedFeatureCount()
  } catch (err) {
    if (signal.aborted) return
    ctx.updateDotsState({
      statsLoading: false,
      viewportSummary: null,
      message: err instanceof Error ? err.message : 'Kunne ikke hente statistikk for utsnittet',
    })
  }
}
