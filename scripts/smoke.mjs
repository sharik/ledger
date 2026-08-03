/*
 * Smoke test for the PRODUCTION build, served from a subpath.
 *
 * The e2e suite cannot cover this. It runs against the Vite dev server because it depends on
 * `?kdf=test` and friends, which `import.meta.env.DEV` compiles out of a real build — so the
 * artifact that actually gets deployed is never exercised by it. Everything checked here is
 * something that is fine in dev and broken in production:
 *
 *   - assets resolving under a subpath (`base: './'`),
 *   - the Content-Security-Policy not blocking what the app needs (Argon2id is WebAssembly, and a
 *     CSP without `wasm-unsafe-eval` means no vault can ever be created),
 *   - the pdf.js worker resolving from a hashed asset URL,
 *   - no third-party requests, which is a promise the README makes.
 *
 *   node scripts/smoke.mjs http://127.0.0.1:8899/ledger/
 */
import { chromium } from '@playwright/test'

const base = process.argv[2]
if (!base) {
  console.error('usage: node scripts/smoke.mjs <url>')
  process.exit(2)
}

const PASSWORD = 'hunter22hunter22'
const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const browser = await chromium.launch()
const page = await browser.newPage()

const consoleErrors = []
const offsite = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
page.on('request', (r) => {
  if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) offsite.push(r.url())
})

try {
  const res = await page.goto(base, { waitUntil: 'networkidle' })
  check(res?.status() === 200, 'the page loads', `HTTP ${res?.status()}`)
  check((await page.title()) === 'Ledger', 'the document titles itself')
  await page.getByTestId('password').waitFor({ timeout: 15_000 })
  check(true, 'the first-run screen renders')

  // Real Argon2id — no test KDF in a production build. This is the CSP/WebAssembly check.
  const t0 = Date.now()
  await page.getByTestId('password').fill(PASSWORD)
  await page.getByTestId('password2').fill(PASSWORD)
  await page.getByTestId('start-empty').click()
  await page.getByTestId('unlock-go').click()
  await page.getByTestId('app-shell').waitFor({ timeout: 90_000 })
  check(true, 'a vault is created with the real KDF', `${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // Hash routing: a deep link must resolve with no server rewrite.
  await page.goto(`${base}#/trends`, { waitUntil: 'networkidle' })
  await page.getByTestId('app-shell').waitFor({ timeout: 30_000 })
  check(true, 'a deep link resolves without a server rewrite')

  // A PDF import is the only thing that loads the pdf.js worker.
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles('tests/fixtures/pumb/p1.pdf')
  await page.getByTestId('review-list').waitFor({ timeout: 90_000 })
  const rows = await page.locator('[data-testid="review-row"]').count()
  check(rows === 11, 'the pdf.js worker parses a statement', `${rows} rows`)

  check(offsite.length === 0, 'no third-party requests', offsite.join(', ') || 'none')
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | ') || 'none')
} catch (err) {
  check(false, 'ran to completion', err.message)
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\nsmoke failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nsmoke passed')
