<script lang="ts">
  import { legendStops } from '../utils/colors'
  import type { ColorScheme } from '../types'

  interface Props {
    scheme: ColorScheme
    max: number
  }

  let { scheme, max }: Props = $props()

  const stops = $derived(legendStops(scheme))
</script>

<div class="legend">
  <span class="legend-title">Antall organisasjoner</span>
  <div class="gradient" style:background="linear-gradient(to right, {stops.join(', ')})"></div>
  <div class="labels">
    <span>0</span>
    <span>{Math.round(max / 2).toLocaleString('nb-NO')}</span>
    <span>{max.toLocaleString('nb-NO')}</span>
  </div>
</div>

<style>
  .legend {
    background: rgba(15, 23, 42, 0.92);
    color: #e2e8f0;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    min-width: 180px;
  }

  .legend-title {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 0.5rem;
  }

  .gradient {
    height: 12px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .labels {
    display: flex;
    justify-content: space-between;
    margin-top: 0.35rem;
    font-size: 0.72rem;
    color: #cbd5e1;
  }
</style>
