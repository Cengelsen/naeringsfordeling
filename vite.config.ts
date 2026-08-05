import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

function resolveSharedJsToTs(): Plugin {
  return {
    name: 'resolve-shared-js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.endsWith('.js')) return null
      if (source.startsWith('\0') || source.includes('node_modules')) return null

      const dir = path.dirname(importer)
      const candidate = path.resolve(dir, source.replace(/\.js$/, '.ts'))
      if (fs.existsSync(candidate)) return candidate
      return null
    },
  }
}

function swCacheVersion(): Plugin {
  return {
    name: 'sw-cache-version',
    writeBundle(options) {
      const swPath = path.join(options.dir ?? 'dist', 'sw.js')
      if (fs.existsSync(swPath)) {
        let content = fs.readFileSync(swPath, 'utf-8')
        content = content.replace('__BUILD_TIMESTAMP__', Date.now().toString())
        fs.writeFileSync(swPath, content)
      }
    },
  }
}

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

const SHARED_DIR = path.resolve(import.meta.dirname, 'shared')

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? (process.env.VITE_BASE ?? '/') : '/',
  plugins: [resolveSharedJsToTs(), svelte(), pmtilesHeaders(), swCacheVersion()],
  resolve: {
    alias: [
      {
        find: /^(\.\.\/)*shared\/(.+)\.js$/,
        replacement: `${SHARED_DIR}/$2.ts`,
      },
    ],
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
