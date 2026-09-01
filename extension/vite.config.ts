import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Both entries are ES modules: the service worker declares "type": "module" and the side
// panel is a normal document. No content script yet, so no IIFE build is needed.
export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    // On for the submitted build: client resource use is a scored metric, and an unpacked
    // extension ships whatever is in dist/. Sourcemaps stay so the code is still readable
    // to anyone reviewing it — they are separate files the browser only fetches on demand.
    minify: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background.ts'),
        sidepanel: resolve(import.meta.dirname, 'src/sidepanel.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
