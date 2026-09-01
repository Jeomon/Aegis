#!/usr/bin/env node
/**
 * Score redaction against the labelled corpus.
 *
 *   node tests/score.mjs
 *
 * Builds a bare extension around the built content script, serves tests/corpus, drives it
 * in headless Chrome, and reports recall and precision against the ground truth marked up
 * in the page. Run it after any change to the detectors or the scan — a drop tells you
 * which item regressed rather than that something feels off.
 *
 * Chrome for Testing is used rather than the installed browser, because branded Chrome
 * refuses --load-extension. Override with AEGIS_CHROME if yours lives elsewhere.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CORPUS = join(HERE, 'corpus')
const CONTENT = join(ROOT, 'extension/dist/content.js')

const CHROME =
  process.env.AEGIS_CHROME ??
  join(
    process.env.HOME ?? '',
    'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )

if (!existsSync(CONTENT)) {
  console.error('No built content script. Run `npm run build` in extension/ first.')
  process.exit(2)
}
if (!existsSync(CHROME)) {
  console.error(`Chrome for Testing not found at:\n  ${CHROME}\nSet AEGIS_CHROME to override.`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------
// The probe extension: the real content script, plus a worker that scans and scores.
// ---------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'aegis-score-'))
const ext = join(work, 'ext')
mkdirSync(ext, { recursive: true })
writeFileSync(join(ext, 'content.js'), readFileSync(CONTENT))
writeFileSync(
  join(ext, 'manifest.json'),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'aegis corpus scorer',
      version: '1.0',
      permissions: ['scripting', 'tabs'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'bg.js', type: 'module' },
      content_scripts: [
        { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true },
      ],
    },
    null,
    2,
  ),
)

const worker = (port) => `
const send = (tabId, m) => new Promise((r) => chrome.tabs.sendMessage(tabId, m, { frameId: 0 }, r))
const openTab = (url) => new Promise((res) => chrome.tabs.create({ url, active: true }, (tab) => {
  const d = (id, i) => { if (id === tab.id && i.status === 'complete') { chrome.tabs.onUpdated.removeListener(d); res(tab.id) } }
  chrome.tabs.onUpdated.addListener(d)
}))

;(async () => {
  let payload
  try {
    const tabId = await openTab('http://127.0.0.1:${port}/index.html')
    await new Promise((r) => setTimeout(r, 900))
    const scan = await send(tabId, { type: 'AEGIS_SCAN' })

    // Ground truth in top-viewport coordinates, descending into shadow roots and the
    // same-origin iframe — the same translation the scan itself performs.
    const truth = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const rows = []
        const collect = (root, ox, oy) => {
          for (const el of root.querySelectorAll('[data-pii], [data-decoy]')) {
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            rows.push({
              kind: el.dataset.pii || null, why: el.dataset.decoy || null,
              text: el.textContent.trim().slice(0, 24),
              x: r.x + ox, y: r.y + oy, w: r.width, h: r.height,
            })
          }
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, ox, oy)
        }
        collect(document, 0, 0)
        const f = document.querySelector('iframe')
        if (f) {
          const fr = f.getBoundingClientRect(), cs = getComputedStyle(f)
          try {
            collect(f.contentDocument, fr.x + parseFloat(cs.borderLeftWidth), fr.y + parseFloat(cs.borderTopWidth))
          } catch { /* cross-origin: not reachable from here */ }
        }
        return rows
      },
    }).then((r) => r[0].result)

    payload = { scan: { piiRegions: scan.piiRegions, elements: scan.elements }, truth }
  } catch (err) {
    payload = { error: String((err && err.stack) || err) }
  }
  await fetch('http://127.0.0.1:${port}/result', { method: 'POST', body: JSON.stringify(payload) })
})()
`

// ---------------------------------------------------------------------------------------
// Serve the corpus, collect the result, score it.
// ---------------------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' }

let settle
const answer = new Promise((r) => (settle = r))

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(204).end()
      settle(JSON.parse(body))
    })
    return
  }
  const name = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  try {
    const file = readFileSync(join(CORPUS, name))
    res.writeHead(200, { 'content-type': TYPES[name.slice(name.lastIndexOf('.'))] ?? 'text/plain' })
    res.end(file)
  } catch {
    res.writeHead(404).end()
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(join(ext, 'bg.js'), worker(port))

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--window-size=900,1400',
      `--user-data-dir=${join(work, 'profile')}`,
      `--load-extension=${ext}`,
      `--disable-extensions-except=${ext}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const timer = setTimeout(() => settle({ error: 'timed out waiting for the scan' }), 90_000)

  answer.then((result) => {
    clearTimeout(timer)
    chrome.kill()
    server.close()
    rmSync(work, { recursive: true, force: true })
    report(result)
  })
})

/** A region covers a span when their rectangles intersect; masks are dilated on purpose. */
const intersects = (r, t) =>
  r.x < t.x + t.w && r.x + r.width > t.x && r.y < t.y + t.h && r.y + r.height > t.y

function report(result) {
  if (result.error) {
    console.error(`\n  scoring failed: ${result.error}\n`)
    process.exit(1)
  }

  const { scan, truth } = result
  const covered = (t) => scan.piiRegions.some((r) => intersects(r, t))

  const positives = truth.filter((t) => t.kind)
  const decoys = truth.filter((t) => t.why)
  const found = positives.filter(covered)
  const missed = positives.filter((t) => !covered(t))
  const wrong = decoys.filter(covered)

  const recall = positives.length ? (found.length / positives.length) * 100 : 0
  const precision =
    found.length + wrong.length ? (found.length / (found.length + wrong.length)) * 100 : 100

  console.log(
    `\n  corpus: ${positives.length} identifiers, ${decoys.length} decoys, ` +
      `${scan.piiRegions.length} regions painted\n`,
  )
  console.log(`  RECALL     ${recall.toFixed(1)}%   (${found.length}/${positives.length} covered)`)
  console.log(`  PRECISION  ${precision.toFixed(1)}%   (${wrong.length} decoys wrongly covered)`)

  if (missed.length) {
    console.log('\n  missed:')
    for (const m of missed) console.log(`    ${String(m.kind).padEnd(12)} ${JSON.stringify(m.text)}`)
  }
  if (wrong.length) {
    console.log('\n  false positives:')
    for (const w of wrong) console.log(`    ${JSON.stringify(w.text).padEnd(22)} ${w.why}`)
  }

  const classified = scan.elements.filter((e) => e.sensitive)
  console.log(`\n  fields classified by layer 1: ${classified.length}`)
  for (const e of classified) {
    console.log(`    [${e.id}] ${JSON.stringify(e.name).slice(0, 26).padEnd(28)} -> ${e.sensitive}`)
  }
  console.log()

  // Only a false positive fails the run. A miss is a known gap, recorded in score.md.
  process.exit(wrong.length ? 1 : 0)
}
