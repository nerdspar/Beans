import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * A single-page app, deliberately not Next.js: there is no SSR requirement and the container stays
 * lighter without it.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The offline shell. Financial data itself comes from IndexedDB, not the service worker
      // cache — it is per-household and must be cleared on logout, which a URL cache cannot do.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'Beans',
        short_name: 'Beans',
        description: 'Your household finances.',
        start_url: '/',
        // Indistinguishable from an installed app once added to the home screen.
        display: 'standalone',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        orientation: 'portrait',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // The API runs separately in development. In production one container serves both, so this
      // proxy is the only thing that differs between the two.
      '/api': { target: 'http://localhost:3100', changeOrigin: true },
      '/health': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
