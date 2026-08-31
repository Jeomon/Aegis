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
    minify: false,
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
