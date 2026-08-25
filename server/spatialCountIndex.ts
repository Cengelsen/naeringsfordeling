/**
 * Exact axis-aligned range counting in O(log N) via a wavelet matrix.
 *
 * Points are sorted by X (lng). A wavelet matrix over Y-ranks then answers
 * “how many points in x-index [L,R) have y-rank in [yLo, yHi)?” in O(log N).
 * Combined with binary search on X, a bbox count is O(log N).
 */

export interface Point2D {
  x: number
  y: number
}

/** Wavelet matrix over integer symbols in [0, sigma). */
class WaveletMatrix {
  private readonly n: number
  private readonly height: number
  private readonly layers: Uint32Array[]
  private readonly zeros: number[]

  constructor(values: Uint32Array, sigma: number) {
    this.n = values.length
    this.height = Math.max(1, Math.ceil(Math.log2(Math.max(sigma, 2))))
    this.layers = []
    this.zeros = []

    let current = values
    for (let level = this.height - 1; level >= 0; level -= 1) {
      const bit = 1 << level
      const layer = new Uint8Array(this.n)
      let zeroCount = 0
      for (let i = 0; i < this.n; i += 1) {
        if ((current[i]! & bit) === 0) zeroCount += 1
      }
      this.zeros.push(zeroCount)

      const next = new Uint32Array(this.n)
      let z = 0
      let o = zeroCount
      for (let i = 0; i < this.n; i += 1) {
        if ((current[i]! & bit) === 0) {
          layer[i] = 0
          next[z] = current[i]!
          z += 1
        } else {
          layer[i] = 1
          next[o] = current[i]!
          o += 1
        }
      }
      this.layers.push(prefixBits(layer))
      current = next
    }
  }

  /** Count values in [left, right) whose symbol is in [lo, hi). */
  rangeCount(left: number, right: number, lo: number, hi: number): number {
    if (left >= right || lo >= hi || this.n === 0) return 0
    return this.rangeCountRec(0, left, right, 0, 1 << this.height, lo, hi)
  }

  private rangeCountRec(
    level: number,
    left: number,
    right: number,
    nodeLo: number,
    nodeHi: number,
    lo: number,
    hi: number,
  ): number {
    if (left >= right || hi <= nodeLo || lo >= nodeHi) return 0
    if (lo <= nodeLo && nodeHi <= hi) return right - left
    if (level >= this.height) return 0

    const mid = (nodeLo + nodeHi) >> 1
    const zeros = this.zeros[level]!
    const rank0Left = this.rank0(level, left)
    const rank0Right = this.rank0(level, right)
    const rank1Left = left - rank0Left
    const rank1Right = right - rank0Right

    return (
      this.rangeCountRec(level + 1, rank0Left, rank0Right, nodeLo, mid, lo, hi) +
      this.rangeCountRec(level + 1, zeros + rank1Left, zeros + rank1Right, mid, nodeHi, lo, hi)
    )
  }

  private rank0(level: number, index: number): number {
    if (index <= 0) return 0
    const pref = this.layers[level]!
    // pref[i] = number of 1-bits in [0, i)
    return index - pref[index]!
  }
}

function prefixBits(bits: Uint8Array): Uint32Array {
  const pref = new Uint32Array(bits.length + 1)
  for (let i = 0; i < bits.length; i += 1) {
    pref[i + 1] = pref[i]! + bits[i]!
  }
  return pref
}

function lowerBound(arr: ArrayLike<number>, value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(arr: ArrayLike<number>, value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Exact bbox point count in O(log N).
 * Points may share coordinates; each entry is counted once as given.
 */
export class SpatialCountIndex {
  private readonly xs: Float64Array
  private readonly ySorted: Float64Array
  private readonly wm: WaveletMatrix

  constructor(points: Point2D[]) {
    const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
    const n = sorted.length
    this.xs = new Float64Array(n)
    const ys = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      this.xs[i] = sorted[i]!.x
      ys[i] = sorted[i]!.y
    }

    const yUnique = Array.from(new Set(Array.from(ys))).sort((a, b) => a - b)
    this.ySorted = Float64Array.from(yUnique)
    const yRanks = new Uint32Array(n)
    for (let i = 0; i < n; i += 1) {
      yRanks[i] = lowerBound(this.ySorted, ys[i]!)
    }

    this.wm = new WaveletMatrix(yRanks, Math.max(yUnique.length, 1))
  }

  get size(): number {
    return this.xs.length
  }

  /** Inclusive bbox in WGS84 degrees. */
  countBbox(minLng: number, minLat: number, maxLng: number, maxLat: number): number {
    if (this.xs.length === 0) return 0
    if (minLng > maxLng || minLat > maxLat) return 0

    const left = lowerBound(this.xs, minLng)
    const right = upperBound(this.xs, maxLng)
    if (left >= right) return 0

    const yLo = lowerBound(this.ySorted, minLat)
    const yHi = upperBound(this.ySorted, maxLat)
    if (yLo >= yHi) return 0

    return this.wm.rangeCount(left, right, yLo, yHi)
  }
}
