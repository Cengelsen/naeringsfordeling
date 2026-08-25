<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import L from 'leaflet'
  import type {
    DotsLoadState,
    MapSettings,
    MunicipalityCount,
    OrganizationPoint,
    Organisasjonsform,
  } from '../types'
  import { kommuneScaleMax, roundUpTo10k } from '../utils/colors'
  import { fylkeFromKommune } from '../utils/geo'
  import { colorForOrgType } from '../utils/orgTypeColors'
  import type { FeatureCollection } from 'geojson'
  import { canUseStaticTiles } from '../map/points'
  import {
    lodTilesAvailable,
    orgDetailTilesCoverLeafletZoom,
    type VectorTilesManifest,
  } from '../map/vectorTiles'
  import { detailLevelLabel, type DistrictColorsManifest } from '../map/districtColors'
  import { MapController, type LocateRequest } from '../map/mapController'
  import Legend from './Legend.svelte'
  import OrgTypeLegend from './OrgTypeLegend.svelte'
  import MapStatusOverlay from './MapStatusOverlay.svelte'

  interface Props {
    geojson: FeatureCollection | null
    counts: MunicipalityCount[]
    settings: MapSettings
    orgForms: Organisasjonsform[]
    locateRequest?: LocateRequest | null
    onDotsStateChange?: (state: DotsLoadState) => void
  }

  let {
    geojson,
    counts,
    settings,
    orgForms,
    locateRequest = null,
    onDotsStateChange,
  }: Props = $props()

  let mapContainer: HTMLDivElement
  let map: L.Map | null = null
  let controller: MapController | null = null
  let mapZoom = $state(5)
  let allPoints = $state<OrganizationPoint[]>([])
  let dotsState = $state<DotsLoadState>({
    loading: false,
    phase: 'idle',
    organizations: 0,
    geocoded: 0,
    skipped: 0,
    kommuner: 0,
    message: null,
  })

  let vectorTilesManifest = $state<VectorTilesManifest | null>(null)
  let districtColorsManifest = $state<DistrictColorsManifest | null>(null)
  let vectorTilesDisabled = $state(false)
  let webglUnavailable = $state(false)
  let webglBannerDismissed = $state(false)
  let orgFocusActive = $state(false)

  const districtColorsReady = $derived(districtColorsManifest !== null)

  const vectorTilesReady = $derived(
    vectorTilesManifest !== null &&
      !vectorTilesDisabled &&
      !webglUnavailable &&
      canUseStaticTiles(settings),
  )

  const detailOrgTilesReady = $derived(
    vectorTilesReady &&
      orgDetailTilesCoverLeafletZoom(vectorTilesManifest, settings.dotsDetailMinZoom),
  )

  const pmtilesLodReady = $derived(
    vectorTilesReady && !districtColorsReady && lodTilesAvailable(vectorTilesManifest),
  )

  const aggregateZoomActive = $derived(
    settings.visualization === 'dots' && mapZoom < settings.dotsDetailMinZoom,
  )

  const currentDetailLevel = $derived(
    detailLevelLabel(mapZoom, {
      visualization: settings.visualization,
      districtLevel: settings.districtLevel,
      dotsDetailMinZoom: settings.dotsDetailMinZoom,
      manifest: districtColorsManifest,
    }),
  )

  const dotsSourceLabel = $derived.by(() => {
    if (districtColorsReady && aggregateZoomActive) return 'distriktsfliser'
    if (pmtilesLodReady && aggregateZoomActive) return 'vektorfliser (LOD)'
    if (detailOrgTilesReady) return 'vektorfliser'
    if (webglUnavailable) return 'Leaflet-fallback'
    return 'SQLite-database'
  })

  const fylkeCountMap = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- accumulator, not reactive state
    const map = new Map<string, number>()
    for (const { kommunenummer, count } of counts) {
      const fylke = fylkeFromKommune(kommunenummer)
      map.set(fylke, (map.get(fylke) ?? 0) + count)
    }
    return map
  })

  const isFylkeLevel = $derived(
    settings.visualization === 'choropleth' && settings.districtLevel === 'fylke',
  )

  const maxCount = $derived.by(() => {
    if (isFylkeLevel) {
      return roundUpTo10k(Math.max(...fylkeCountMap.values(), 1))
    }
    return kommuneScaleMax(counts.map((c) => c.count))
  })

  const totalVisible = $derived(
    settings.visualization === 'dots'
      ? dotsState.statsLoading
        ? null
        : (dotsState.viewportSummary?.addressesInBbox ?? null)
      : counts.reduce((sum, c) => sum + c.count, 0),
  )

  const orgTypeLegendItems = $derived.by(() => {
    const manifestTypes = districtColorsManifest?.orgTypes ?? vectorTilesManifest?.orgTypes ?? null
    if (manifestTypes) {
      return manifestTypes.map((kode) => {
        const meta = orgForms.find((f) => f.kode === kode)
        return {
          kode,
          label: meta?.beskrivelse ?? kode,
          color: colorForOrgType(kode, manifestTypes),
        }
      })
    }

    const types = [...new Set(allPoints.map((point) => point.orgType))].sort()
    return types.map((kode) => {
      const meta = orgForms.find((f) => f.kode === kode)
      return {
        kode,
        label: meta?.beskrivelse ?? kode,
        color: colorForOrgType(kode, types),
      }
    })
  })

  onMount(() => {
    map = L.map(mapContainer, {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 4,
      maxZoom: 18,
      maxBounds: [
        [90, -Infinity],
        [-90, Infinity],
      ],
      maxBoundsViscosity: 1,
    }).setView([65.0, 12.0], 5)
    mapZoom = 5

    L.control.zoom({ position: 'topright' }).addTo(map)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · BRREG · Kartverket',
      maxZoom: 19,
    }).addTo(map)

    controller = new MapController(map, {
      onDotsStateChange: (state) => {
        dotsState = state
        onDotsStateChange?.(state)
      },
      onPointsChange: (_visible, all) => {
        allPoints = all
      },
      onLoadingChange: () => {},
      onOrgFocusChange: (active) => {
        orgFocusActive = active
      },
      onMapZoomChange: (zoom) => {
        mapZoom = zoom
      },
      onWebglUnavailableChange: (unavailable) => {
        webglUnavailable = unavailable
      },
      onVectorTilesManifestChange: (manifest) => {
        vectorTilesManifest = manifest
      },
      onDistrictColorsManifestChange: (manifest) => {
        districtColorsManifest = manifest
      },
      onVectorTilesDisabledChange: (disabled) => {
        vectorTilesDisabled = disabled
      },
      getDotsState: () => dotsState,
    })

    controller.updateCachedState(settings, orgForms, geojson, counts)

    void controller.probeAssets(settings)

    const ctrl = controller

    const onMoveEnd = () => ctrl.scheduleDotsReloadOnMove(settings)
    const onMove = () => ctrl.schedulePrefetchDuringMove(settings)
    const onZoomEnd = () => {
      mapZoom = ctrl.handleMapZoomEnd(settings)
    }

    map.on('moveend', onMoveEnd)
    map.on('move', onMove)
    map.on('zoomend', onZoomEnd)

    const resizeObserver = new ResizeObserver(() => {
      map?.invalidateSize({ animate: false })
    })
    resizeObserver.observe(mapContainer)

    controller.updateVisualization(settings, geojson, counts, orgForms)

    return () => {
      resizeObserver.disconnect()
      map?.off('moveend', onMoveEnd)
      map?.off('move', onMove)
      map?.off('zoomend', onZoomEnd)
      ctrl.destroy()
      map?.remove()
      map = null
      controller = null
    }
  })

  $effect(() => {
    geojson
    controller?.updateKommuneBounds(geojson)
  })

  $effect(() => {
    settings.visualization
    settings.districtLevel
    settings.colorScheme
    settings.selectedFylke
    settings.selectedKommune
    counts
    geojson
    untrack(() => {
      controller?.updateCachedState(settings, orgForms, geojson, counts)
      controller?.updateVisualization(settings, geojson, counts, orgForms)
    })
  })

  $effect(() => {
    if (settings.visualization !== 'dots') return

    settings.excludeKonkurs
    settings.excludeUnderAvvikling
    settings.vatRegisteredOnly
    settings.naeringskodeSections
    settings.employeeBands
    settings.entityKinds
    settings.konsernMembersOnly
    settings.selectedFylke
    settings.selectedKommune

    untrack(() => {
      controller?.updateCachedState(settings, orgForms, geojson, counts)
      controller?.handleDataFilterChange(settings)
    })
  })

  $effect(() => {
    if (settings.visualization !== 'dots') return
    settings.orgTypes
    settings.naeringskodeSections
    settings.employeeBands
    settings.entityKinds
    untrack(() => {
      controller?.applyOrgTypeVisibility(settings, orgForms, geojson)
    })
  })

  $effect(() => {
    settings.visualization
    settings.districtLevel
    settings.selectedFylke
    settings.selectedKommune
    untrack(() => {
      controller?.exitOrgFocusMode(settings, geojson, counts)
    })
  })

  $effect(() => {
    const request = locateRequest
    if (!request || !map) return
    untrack(() => {
      controller?.locateOrganization(request, settings, orgForms)
    })
  })
</script>

<div class="map-shell">
  <div
    class="map"
    bind:this={mapContainer}
    role="application"
    aria-label="Organisasjonskart"
    id="map"
  ></div>

  {#if !orgFocusActive && settings.visualization === 'dots' && orgTypeLegendItems.length > 0}
    <div class="legend-wrap">
      <OrgTypeLegend items={orgTypeLegendItems} />
    </div>
  {:else if !orgFocusActive && settings.showLegend && settings.visualization !== 'dots'}
    <div class="legend-wrap">
      <Legend scheme={settings.colorScheme} max={maxCount} />
    </div>
  {/if}

  <MapStatusOverlay
    {orgFocusActive}
    visualization={settings.visualization}
    {dotsState}
    {webglUnavailable}
    {webglBannerDismissed}
    {mapZoom}
    {currentDetailLevel}
    {totalVisible}
    {dotsSourceLabel}
    onDismissWebglBanner={() => (webglBannerDismissed = true)}
  />
</div>

<style>
  .map-shell {
    position: relative;
    width: 100%;
    height: 100%;
    background: #cbd5e1;
  }

  .map {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
  }

  .legend-wrap {
    position: absolute;
    left: 1rem;
    bottom: 2.5rem;
    z-index: 1000;
    pointer-events: auto;
  }

  :global(.konsern-tree) {
    margin-top: 0.35rem;
    max-height: 180px;
    overflow: auto;
    text-align: left;
  }

  :global(.konsern-link) {
    display: block;
    width: 100%;
    margin: 0.15rem 0;
    padding: 0;
    border: none;
    background: none;
    color: #0369a1;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  :global(.konsern-link:hover) {
    text-decoration: underline;
  }

  :global(.leaflet-container) {
    font-family: inherit;
  }

  :global(.maplibregl-canvas) {
    outline: none;
  }

  :global(.leaflet-marker-pane .leaflet-gl-layer),
  :global(.leaflet-marker-pane .leaflet-gl-layer .maplibregl-map),
  :global(.leaflet-marker-pane .leaflet-gl-layer .maplibregl-canvas-container),
  :global(.leaflet-marker-pane .leaflet-gl-layer canvas) {
    z-index: 650 !important;
    pointer-events: none !important;
  }
</style>
