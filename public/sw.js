const CACHE_VERSION = '__BUILD_TIMESTAMP__'
const CACHE = `naeringsfordeling-v${CACHE_VERSION}`
const PRECACHE = ['data/points/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new URL(path, self.location).href))).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (
    url.pathname.includes('/data/points/') ||
    url.pathname.endsWith('/data/points.pmtiles')
  ) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(event.request)
        if (cached) return cached

        const response = await fetch(event.request)
        if (response.ok) {
          cache.put(event.request, response.clone())
        }
        return response
      }),
    )
  }
})
