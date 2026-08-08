declare const __CACHE_VERSION__: string

const CACHE = `naeringsfordeling-v${__CACHE_VERSION__}`
const PRECACHE = ['data/points/manifest.json']

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(PRECACHE.map((path) => new URL(path, self.location.href).href)),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)

  if (url.pathname.includes('/data/points/') || url.pathname.endsWith('/data/points.pmtiles')) {
    // PMTiles uses HTTP Range (206). The Cache API rejects 206 bodies, and
    // caching Range/HEAD responses can break subsequent tile reads — pass through.
    if (event.request.method !== 'GET' || event.request.headers.has('Range')) {
      return
    }

    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(event.request)
        if (cached) return cached

        const response = await fetch(event.request)
        if (response.status === 200) {
          void cache.put(event.request, response.clone()).catch(() => {})
        }
        return response
      }),
    )
  }
})
