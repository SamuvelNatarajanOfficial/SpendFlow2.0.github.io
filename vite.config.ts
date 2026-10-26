/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves project sites from /<repo>/. A relative base ('./') works
// for any repo name. Override with VITE_BASE if you prefer an absolute base.
const base = process.env.VITE_BASE ?? './'

/**
 * Content-Security-Policy for the PRODUCTION build, delivered as a <meta> tag because GitHub Pages cannot set
 * response headers (so frame-ancestors / report-uri are not available). Everything is same-origin: no remote
 * scripts, fonts, styles, images or network connections are permitted. Not applied in dev (HMR needs inline code).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const cspPlugin = (): Plugin => ({
  name: 'spendflow-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  base,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    cspPlugin(),
    VitePWA({
      registerType: 'prompt', // never reload silently: the user decides when to update
      includeAssets: ['favicon.svg', 'offline.html'],
      manifest: {
        name: 'SpendFlow 2.0',
        short_name: 'SpendFlow',
        description: 'Every rupee. Every goal. Under control.',
        theme_color: '#0b1f3a',
        background_color: '#0b1f3a',
        display: 'standalone',
        orientation: 'portrait',
        // relative values resolve against the manifest URL, so they work under /<repo>/
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
})
