/** Resolve a public asset path against Vite's base URL (e.g. GitHub Pages subpath). */
export function assetUrl(path: string): string {
  const normalized = path.startsWith('/') ? path.slice(1) : path
  return `${import.meta.env.BASE_URL}${normalized}`
}
