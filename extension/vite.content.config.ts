import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Content scripts are injected as classic scripts, so this bundle must be a self-contained
// IIFE with every dependency inlined. emptyOutDir is off so it lands alongside the main build.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    // On for the submitted build: client resource use is a scored metric, and an unpacked
    // extension ships whatever is in dist/. Sourcemaps stay so the code is still readable
    // to anyone reviewing it — they are separate files the browser only fetches on demand.
    minify: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/content.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'content.js',
      },
    },
  },
})
