function isHtmlResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/html')
}

async function parseGzipJson<T>(response: Response): Promise<T | null> {
  if (typeof DecompressionStream === 'undefined') {
    return null
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
      const result = await parseGzipJson<T>(gzResponse)
      if (result !== null) return result
    } catch {
      // fall through to plain JSON
    }
  }

  const response = await fetch(baseUrl)
  if (!response.ok) {
    throw new Error(`Kunne ikke laste ${baseUrl}`)
  }

  return response.json() as Promise<T>
}
