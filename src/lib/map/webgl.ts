/**
 * Track whether MapLibre/WebGL dots have failed in this session.
 * We intentionally do not probe getContext() up front — on some browsers
 * (including when WebGL is disabled) that prompts the user repeatedly.
 */
let webglDotsFailed = false

export function isWebglDotsFailed(): boolean {
  return webglDotsFailed
}

export function markWebglDotsFailed(): void {
  webglDotsFailed = true
}
