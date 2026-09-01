import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// onnxruntime-web loads its WASM binary + JS glue at runtime. In an MV3 extension the
// default CDN fallback is blocked by CSP, so we copy the pair into dist/ort/ and point
// ort.env.wasm.wasmPaths at chrome-extension://.../ort/ from the runtime code.
function copyOrtAssets() {
  return {
    name: 'copy-ort-assets',
    closeBundle() {
      const src = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist')
      const out = resolve(import.meta.dirname, 'dist/ort')
      mkdirSync(out, { recursive: true })
      for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
        copyFileSync(resolve(src, f), resolve(out, f))
      }
    },
  }
}

// Both entries are ES modules: the service worker declares "type": "module" and the side
// panel is a normal document. No content script yet, so no IIFE build is needed.
export default defineConfig({
  publicDir: 'public',
  plugins: [copyOrtAssets()],
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
