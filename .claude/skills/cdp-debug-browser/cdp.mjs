#!/usr/bin/env node
/**
 * Read the user's LIVE, UNLOCKED Ledger browser over the Chrome DevTools Protocol.
 *
 * This attaches to the visible Chrome the user keeps open (their vault is decrypted in it),
 * NOT the separate MCP-Playwright browser. It is READ-ONLY by design.
 *
 * HARD RULES (see SKILL.md):
 *   • Never navigate / reload — a reload drops the in-memory session and RE-LOCKS the vault.
 *   • Never call browser.close() — Playwright would close the user's real Chrome. We just exit.
 *   • Clicking / typing mutates the user's real vault. Don't, unless the user asked.
 *
 * Usage (run from anywhere inside the repo so node_modules resolves):
 *   node .claude/skills/cdp-debug-browser/cdp.mjs                 # snapshot of the current screen
 *   node .claude/skills/cdp-debug-browser/cdp.mjs "EXPR"          # eval a read-only JS expression
 *   node .claude/skills/cdp-debug-browser/cdp.mjs --shot out.png  # screenshot the app tab
 *   CDP_PORT=9333 APP=http://localhost:5174 node ...              # override port / app origin
 */
import { chromium } from 'playwright-core'

const PORT = process.env.CDP_PORT || '9222'
const APP = process.env.APP || 'http://localhost:5173'
const [, , mode, shotPath] = process.argv

const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`)
const pages = browser.contexts().flatMap((c) => c.pages())
const page = pages.find((p) => p.url().startsWith(APP))
if (!page) {
  console.error(`No ${APP} tab found on CDP :${PORT}. Open tabs:\n` + pages.map((p) => '  ' + p.url()).join('\n'))
  process.exit(2)
}

if (mode === '--shot') {
  const out = shotPath || '/tmp/ledger-cdp.png'
  await page.screenshot({ path: out })
  console.log('screenshot →', out)
} else if (mode) {
  // Arbitrary READ-ONLY expression, e.g.  cdp.mjs "document.querySelectorAll('[data-testid=review-row]').length"
  const val = await page.evaluate((expr) => (0, eval)(expr), mode)
  console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2))
} else {
  // Default: a compact snapshot of whatever screen is showing.
  const state = await page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null
    const rows = [...document.querySelectorAll('[data-testid="review-row"],[data-testid="txn-row"]')]
      .slice(0, 12)
      .map((r) => ({ merchant: r.getAttribute('data-merchant'), text: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) }))
    return {
      url: location.href,
      screen: document.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null,
      reviewCounts: txt('[data-testid="review-counts"]'),
      assistStrip: txt('[data-testid="assist-strip"]'),
      assistOutcome: txt('[data-testid="assist-outcome"]'),
      toast: txt('[data-testid="toast"]'),
      rowCount: document.querySelectorAll('[data-testid="review-row"],[data-testid="txn-row"]').length,
      rows,
    }
  })
  console.log(JSON.stringify(state, null, 2))
}

// Detach by exiting — dropping the CDP socket leaves the user's Chrome running.
process.exit(0)
