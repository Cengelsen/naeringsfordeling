import path from 'node:path'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
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

const cacheVersion = Date.now().toString()

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? (process.env.VITE_BASE ?? '/') : '/',
  define: {
    __CACHE_VERSION__: JSON.stringify(cacheVersion),
  },
  plugins: [svelte(), pmtilesHeaders()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        sw: path.resolve(import.meta.dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    server: {
      deps: {
        inline: [/shared\//],
      },
    },
  },
})
