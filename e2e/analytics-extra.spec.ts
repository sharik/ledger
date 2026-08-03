import { test, expect } from '@playwright/test'
import { setupVault, goTab } from './helpers'

// Phase E/F: year-in-review report and the smart-categorization settings card.
test('year in review opens from Trends and reports yearly figures', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'trends')
  await page.getByTestId('year-in-review-btn').click()
  const report = page.getByTestId('year-in-review')
  await expect(report).toBeVisible()
  await expect(report).toContainText('INCOME')
  await expect(report).toContainText('NET')
  await page.getByTestId('yir-close').click()
  await expect(report).toHaveCount(0)
})

// The card's promise used to be "never amounts, dates, or account numbers", while "Improve name
// with AI" — gated on this very toggle — sent the trip's dates and unredacted merchants. A privacy
// claim a sibling feature contradicts is worse than no claim, so the card names both payloads.
test('the assist card owns up to every payload this one toggle enables', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'settings')
  const card = page.getByTestId('assist-card')
  await expect(card).toContainText('never amounts, dates, or account numbers')
  await expect(card).toContainText('Improve name with AI')
  await expect(card).toContainText(/trip.s dates and merchant\s*names/)
})

test('smart-categorization card toggles on, captures config, and clears when off', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'settings')
  // Off by default: no fields shown.
  await expect(page.getByTestId('assist-model')).toHaveCount(0)
  await page.getByTestId('assist-toggle').click()
  await expect(page.getByTestId('assist-toggle')).toHaveText('On')
  await page.getByTestId('assist-model').fill('claude-haiku-4-5-20251001')
  await page.getByTestId('assist-key').fill('sk-test-123')
  await page.getByTestId('assist-key').blur()
  // Presets cover the hosted and local providers (§10.6); the catalog adds the rest at runtime.
  const provider = page.getByTestId('assist-provider')
  await expect(provider.locator('option[value="openrouter"]')).toHaveCount(1)
  await expect(provider.locator('option[value="ollama"]')).toHaveCount(1)
  // A local runtime takes no key, so the key row goes away entirely — and the model id must not
  // survive the switch, since it means nothing to the new endpoint.
  await provider.selectOption('ollama')
  await expect(page.getByTestId('assist-key')).toHaveCount(0)
  await expect(page.getByTestId('assist-model')).not.toHaveValue('claude-haiku-4-5-20251001')
  // A key belongs to the endpoint that issued it: it must not follow you to a different provider…
  await provider.selectOption('openrouter')
  await expect(page.getByTestId('assist-key')).toHaveValue('')
  await page.getByTestId('assist-key').fill('sk-or-key')
  await page.getByTestId('assist-key').blur()
  // …and must not be thrown away either — each provider keeps its own.
  await provider.selectOption('anthropic')
  await expect(page.getByTestId('assist-key')).toHaveValue('sk-test-123')
  await provider.selectOption('openrouter')
  await expect(page.getByTestId('assist-key')).toHaveValue('sk-or-key')
  await provider.selectOption('anthropic')
  await expect(page.getByTestId('assist-key')).toHaveCount(1)
  // The browse list offers the provider's whole catalogue, not just ids matching the filled-in
  // model — the failure mode a <datalist> silently produces. Guarded: the catalogue is a network
  // fetch, so the assertion only runs when it actually loaded.
  const pick = page.getByTestId('assist-model-pick')
  if (await pick.count()) expect(await pick.locator('option').count()).toBeGreaterThan(3)
  // Toggling off tears the config down.
  await page.getByTestId('assist-toggle').click()
  await expect(page.getByTestId('assist-toggle')).toHaveText('Off')
  await expect(page.getByTestId('assist-model')).toHaveCount(0)
})
