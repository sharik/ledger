---
name: cdp-debug-browser
description: Debug the Ledger dev app live, together with the user, in their real Chrome over the DevTools Protocol (CDP) on port 9222 — the browser where their vault is unlocked at http://localhost:5173. Use whenever the user says "check the browser", "read the current state", "look at what I'm seeing", or wants a UI/state bug diagnosed against their running vault.
---

# Debug live with the user (CDP :9222)

The user keeps a real, visible Google Chrome open with the Ledger dev app at
`http://localhost:5173`, their vault unlocked, launched with `--remote-debugging-port=9222`.
You attach over CDP to read exactly what they see and diagnose it with them — they drive the
UI, you read the resulting state.

## 1. Connect to the right browser

Reach the user's Chrome over **CDP on :9222** (via `playwright-core`'s `connectOverCDP`, or the
`cdp.mjs` helper here). The `browser_*` MCP tools are a *different* Chrome with its own profile and
a locked vault — don't read state from there; always go through :9222.

Check it's up:

```sh
curl -s http://localhost:9222/json/list | head        # lists open tabs when it's running
ps aux | grep -oE 'remote-debugging-port=[0-9]+' | sort -u   # find the port if it moved
```

## 2. If the browser is down: start it, then unlock with the user

Start the dev server if needed (`npm run dev`, Vite on 5173), then launch Chrome on the CDP port:

```sh
/opt/google/chrome/chrome \
  --user-data-dir="$(mktemp -d)/chrome-profile" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --window-size=1920,1200 \
  http://localhost:5173 &
```

A fresh profile opens on the create/unlock screen. **Ask the user to enter their master password
in that window** and tell you when the app is up — never type or ask for the password yourself.
Once they confirm it's unlocked, start reading state and debugging.

## 3. Read state

`cdp.mjs` attaches, finds the 5173 tab, reads, and exits. Run it from anywhere inside the repo so
`node_modules/playwright-core` resolves.

```sh
# Snapshot the current screen (url, screen, review/assist counts, first rows):
node .claude/skills/cdp-debug-browser/cdp.mjs

# Evaluate any read-only expression in the page:
node .claude/skills/cdp-debug-browser/cdp.mjs "document.querySelectorAll('[data-testid=review-row]').length"
node .claude/skills/cdp-debug-browser/cdp.mjs "[...document.querySelectorAll('[data-testid=review-row]')].map(r=>({m:r.dataset.merchant, t:r.textContent.replace(/\\s+/g,' ').trim()}))"

# Screenshot the app tab, then Read the PNG:
node .claude/skills/cdp-debug-browser/cdp.mjs --shot /tmp/ledger.png

# Overrides:
CDP_PORT=9333 APP=http://localhost:5174 node .claude/skills/cdp-debug-browser/cdp.mjs
```

Or inline, for anything the helper doesn't cover:

```js
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://localhost:9222')
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://localhost:5173'))
const data = await page.evaluate(() => document.title)   // read-only DOM access
console.log(data)
process.exit(0)   // detach by exiting; do NOT browser.close()
```

## While attached

- **Don't navigate or reload.** The decrypted vault lives only in memory; a reload boots back to the
  lock screen and loses the user's session. Read the DOM in place.
- **Don't call `browser.close()`** — Playwright would close the user's real Chrome. Detach by letting
  the process exit (the helper does `process.exit(0)`).
- **Read-only unless the user asks.** Clicking/typing changes their real vault, and running the AI
  assist sends their data to a provider — do those only on request, and confirm first.

## Selectors for this app

- Import review: `[data-testid="review-row"]` (`data-merchant`) · chip `[data-testid="recat-chip"]` ·
  counts `[data-testid="review-counts"]` · AI offer/outcome `[data-testid="assist-strip"]` /
  `[data-testid="assist-outcome"]`.
- Transactions: `[data-testid="txn-row"]` (`data-merchant`) · count `[data-testid="txn-showing"]`.
- Toast `[data-testid="toast"]` · current pane `[data-screen]`.
