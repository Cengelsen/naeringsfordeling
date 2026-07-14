<script lang="ts">
  import { onMount } from 'svelte'
  import L from 'leaflet'
  import type { FeatureCollection } from 'geojson'
  import type { MapSettings, MunicipalityCount } from '../types'
  import { colorForValue } from '../utils/colors'
  import { centroid, fylkeFromKommune, kommuneFeatures, type KommuneFeature } from '../utils/geo'
  import Legend from './Legend.svelte'

  interface Props {
    geojson: FeatureCollection | null
    counts: MunicipalityCount[]
    settings: MapSettings
  }

  let { geojson, counts, settings }: Props = $props()

  let mapContainer: HTMLDivElement
  let map: L.Map | null = null
  let geoLayer: L.GeoJSON | null = null
  let bubbleLayer: L.LayerGroup | null = null

  const countMap = $derived(new Map(counts.map((c) => [c.kommunenummer, c.count])))
  const maxCount = $derived(Math.max(...counts.map((c) => c.count), 1))
  const totalVisible = $derived(counts.reduce((sum, c) => sum + c.count, 0))

  function isVisible(kommunenummer: string): boolean {
    if (!settings.selectedFylke) return true
    return fylkeFromKommune(kommunenummer) === settings.selectedFylke
  }

  function styleFeature(feature?: KommuneFeature) {
    const kommunenummer = feature?.properties.kommunenummer ?? ''
    const visible = isVisible(kommunenummer)
    const count = visible ? (countMap.get(kommunenummer) ?? 0) : 0
    return {
      fillColor: colorForValue(count, maxCount, settings.colorScheme),
      weight: visible ? 1 : 0.3,
      opacity: visible ? 1 : 0.35,
      color: '#475569',
      fillOpacity: visible ? 0.78 : 0.15,
    }
  }

  function bindFeatureEvents(layer: L.Layer, feature: KommuneFeature) {
    const props = feature.properties
    const count = countMap.get(props.kommunenummer) ?? 0
    layer.bindPopup(
      `<strong>${props.kommunenavn ?? props.name}</strong><br/>
       Kommune ${props.kommunenummer}<br/>
       <strong>${count.toLocaleString('nb-NO')}</strong> organisasjoner`,
    )
    layer.on({
      mouseover: (e) => {
        const target = e.target as L.Path
        target.setStyle({ weight: 2, color: '#0ea5e9' })
        target.bringToFront()
      },
      mouseout: (e) => {
        geoLayer?.resetStyle(e.target as L.Layer)
      },
    })
  }

  function renderChoropleth() {
    if (!map || !geojson) return
    bubbleLayer?.remove()
    bubbleLayer = null

    if (geoLayer) {
      geoLayer.remove()
    }

    geoLayer = L.geoJSON(geojson, {
      style: (feature) => styleFeature(feature as KommuneFeature),
      onEachFeature: (feature, layer) => bindFeatureEvents(layer, feature as KommuneFeature),
    }).addTo(map)
  }

  function bubbleRadius(count: number): number {
    if (count <= 0) return 0
    return Math.max(4, Math.min(28, Math.sqrt(count / maxCount) * 28))
  }

  function renderBubbles() {
    if (!map || !geojson) return
    geoLayer?.remove()
    geoLayer = null

    if (bubbleLayer) {
      bubbleLayer.remove()
    }

    bubbleLayer = L.layerGroup().addTo(map)

    for (const feature of kommuneFeatures(geojson)) {
      const kommunenummer = feature.properties.kommunenummer
      if (!isVisible(kommunenummer)) continue

      const count = countMap.get(kommunenummer) ?? 0
      if (count <= 0) continue

      const [lat, lng] = centroid(feature)
      const circle = L.circleMarker([lat, lng], {
        radius: bubbleRadius(count),
        fillColor: colorForValue(count, maxCount, settings.colorScheme),
        color: '#1e293b',
        weight: 1,
        fillOpacity: 0.75,
      })

      circle.bindPopup(
        `<strong>${feature.properties.kommunenavn ?? feature.properties.name}</strong><br/>
         ${count.toLocaleString('nb-NO')} organisasjoner`,
      )
      circle.addTo(bubbleLayer)
    }
  }

  function updateVisualization() {
    if (!map) return
    if (settings.visualization === 'choropleth') {
      renderChoropleth()
    } else {
      renderBubbles()
    }
  }

  onMount(() => {
    map = L.map(mapContainer, {
      zoomControl: false,
      minZoom: 4,
      maxZoom: 12,
    }).setView([65.0, 12.0], 5)

    L.control.zoom({ position: 'topright' }).addTo(map)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · BRREG',
      maxZoom: 18,
    }).addTo(map)

    updateVisualization()

    return () => {
      map?.remove()
      map = null
    }
  })

  $effect(() => {
    settings.visualization
    settings.colorScheme
    settings.selectedFylke
    counts
    geojson
    updateVisualization()
  })
</script>

<div class="map-shell">
  <div class="map" bind:this={mapContainer}></div>
  {#if settings.showLegend}
    <div class="legend-wrap">
      <Legend scheme={settings.colorScheme} max={maxCount} />
    </div>
  {/if}
  <div class="attribution">
    {totalVisible.toLocaleString('nb-NO')} organisasjoner i visningen
  </div>
</div>

<style>
  .map-shell {
    position: relative;
    width: 100%;
    height: 100%;
    background: #cbd5e1;
  }

  .map {
    width: 100%;
    height: 100%;
  }

  .legend-wrap {
    position: absolute;
    left: 1rem;
    bottom: 2.5rem;
    z-index: 1000;
  }

  .attribution {
    position: absolute;
    right: 1rem;
    bottom: 0.75rem;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.88);
    color: #e2e8f0;
    padding: 0.4rem 0.65rem;
    border-radius: 0.35rem;
    font-size: 0.78rem;
  }

  :global(.leaflet-container) {
    font-family: inherit;
  }
</style>
