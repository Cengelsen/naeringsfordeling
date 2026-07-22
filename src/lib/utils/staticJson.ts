function isHtmlResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/html')
}

async function parseGzipJson<T>(response: Response): Promise<T> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Nettleseren støtter ikke gzip-dekomprimering')
  }

  const stream = response.body!.pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  return JSON.parse(text) as T
}

/** Load a JSON file from the static API bundle (prefers pre-gzipped copy). */
export async function fetchStaticJson<T>(baseUrl: string): Promise<T> {
  const gzResponse = await fetch(`${baseUrl}.gz`)
  if (gzResponse.ok && !isHtmlResponse(gzResponse)) {
    try {
      return await parseGzipJson<T>(gzResponse)
    } catch {
      // Vite dev can return index.html for missing .gz files; fall back to plain JSON.
    }
  }

  const response = await fetch(baseUrl)
  if (!response.ok) {
    throw new Error(`Kunne ikke laste ${baseUrl}`)
  }

  return response.json() as Promise<T>
}
