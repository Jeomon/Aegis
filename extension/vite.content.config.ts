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
    minify: false,
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
