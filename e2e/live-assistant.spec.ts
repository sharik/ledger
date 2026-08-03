// The assistant against a REAL provider. Opt-in: `npx playwright test --project=live`.
//
// Not part of `npm run test:e2e` — it costs money and its timing depends on someone else's
// queue. What it buys is the one thing the stubbed specs cannot give: proof that a real model,
// handed the tool catalogue and the system prompt, picks the right tool on its own. A canned
// `page.route` reply tests the wire and the UI; it can never fail because the model chose badly.
//
// Needs `.env.test` (see `.env.test.example`). Without a key every test here skips.
import { expect, test } from '@playwright/test'
import { setupVault } from './helpers'
import { configureLive, liveConfig } from './live'

const cfg = liveConfig()

test.describe('a real provider', () => {
  test.skip(cfg === null, 'no key — copy .env.test.example to .env.test and fill one in')
  // The 60s default is sized for a stubbed provider answering instantly. A real one is queued,
  // and a reasoning model spends its budget before the first character.
  test.setTimeout(240_000)

  test('a real model passes the tool-calling gate', async ({ page }) => {
    await setupVault(page, { demo: true })
    await configureLive(page, cfg!)

    // The gate is the honest smoke test for a live key: it makes the model actually emit a tool
    // call, so it fails on a bad key, an unreachable endpoint, CORS, or a model without tools —
    // and distinguishes those, because the probe reports each outcome as its own sentence.
    await page.getByTestId('assistant-probe').click()
    await expect(page.getByTestId('assistant-probe-msg')).toContainText('can call tools', { timeout: 180_000 })
    await expect(page.getByTestId('assistant-chat-toggle')).toBeEnabled()
  })

  test('it answers from the vault and shows the tool it used', async ({ page }) => {
    await setupVault(page, { demo: true })
    await configureLive(page, cfg!)

    await page.getByTestId('assistant-probe').click()
    await expect(page.getByTestId('assistant-probe-msg')).toContainText('can call tools', { timeout: 180_000 })
    await page.getByTestId('assistant-chat-toggle').click()
    // Fresh vaults are Safe (§2.2); listing categories needs no amounts, so Safe is enough here
    // and keeps this test off the path where real figures would leave the machine.
    await expect(page.getByTestId('assistant-access')).toHaveText('Safe')

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('what categories do I have?')
    await page.getByTestId('assistant-send').click()

    // Assert on the receipts, not the prose: which tool ran is a fact, while the wording of a real
    // model's reply is not something a test may pin down. Match ANY receipt rather than the first —
    // the prompt tells the model to "start with get_overview when you need bearings", so leading
    // with it is correct behaviour, and pinning the order would pin a judgement call the model is
    // entitled to make.
    await expect(page.getByTestId('assistant-receipt').filter({ hasText: 'Categories' }).first()).toBeVisible({ timeout: 180_000 })
    await expect(page.getByTestId('assistant-reply')).not.toBeEmpty()
  })
})
