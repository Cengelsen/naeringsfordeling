import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

function pmtilesHeaders(): Plugin {
  return {
    name: 'pmtiles-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('.pmtiles')) {
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        }
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('.pmtiles')) {
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/naeringsfordeling/' : '/',
  plugins: [svelte(), pmtilesHeaders()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
