import { expect, test, type Page } from '@playwright/test'
import { appUrl, goTab, setupVault } from './helpers'

/**
 * Visual baselines. Boot screens + the shell in both themes, the Phase-C import/
 * transactions surfaces, and the Phase-D analytics screens (dashboard, compare,
 * trends, plan, accounts). Deterministic via fixed ?now=, seeded demo data and UTC.
 * `shell — light`/`shell — dark` capture the dashboard (setup lands on it).
 */

async function shot(page: Page, name: string): Promise<void> {
  // Force the IBM Plex web fonts to finish loading before capture — `fonts.ready`
  // alone can resolve mid-swap and flake text-heavy screens.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("400 14px 'IBM Plex Sans'"),
      document.fonts.load("600 14px 'IBM Plex Sans'"),
      document.fonts.load("700 20px 'IBM Plex Sans'"),
      document.fonts.load("400 11px 'IBM Plex Mono'"),
    ])
    await document.fonts.ready
  })
  await page.waitForTimeout(200)
  await expect(page).toHaveScreenshot(`${name}.png`)
}

test('setup screen', async ({ page }) => {
  await page.goto(appUrl())
  await page.evaluate(() => document.fonts.ready)
  await shot(page, 'setup')
})

test('unlock screen', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'settings')
  await page.getByTestId('lock-now').click()
  await expect(page.getByTestId('password')).toBeVisible()
  await shot(page, 'unlock')
})

test('shell — light', async ({ page }) => {
  await setupVault(page)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await shot(page, 'shell-light')
})

test('shell — dark', async ({ page }) => {
  await setupVault(page)
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await shot(page, 'shell-dark')
})

// Phase D analytics screens — deterministic via the seeded demo data + fixed ?now=.
test('compare', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'compare')
  await expect(page.getByText('Difference', { exact: false }).first()).toBeVisible()
  await shot(page, 'compare')
})

test('trends', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'trends')
  await expect(page.getByText('Yearly spending', { exact: false }).first()).toBeVisible()
  await shot(page, 'trends')
})

test('plan', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'plan')
  await expect(page.getByText('Spend is always derived', { exact: false }).first()).toBeVisible()
  await shot(page, 'plan')
})

test('accounts', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'accounts')
  await expect(page.getByText('Net worth', { exact: false }).first()).toBeVisible()
  await shot(page, 'accounts')
})

// Phase C screens — driven by the committed Revolut fixture so the pixels are deterministic.
const F1 = 'tests/fixtures/revolut/f1.xlsx'

test('import — drop step', async ({ page }) => {
  await setupVault(page, { demo: false })
  await page.getByTestId('import-btn').click()
  await expect(page.getByTestId('dropzone')).toBeVisible()
  await shot(page, 'import-drop')
})

test('import — review', async ({ page }) => {
  await setupVault(page, { demo: false })
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
  await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
  await shot(page, 'import-review')
})

test('transactions', async ({ page }) => {
  await setupVault(page, { demo: false })
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
  await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('txn-row').first()).toBeVisible()
  await shot(page, 'transactions')
})

test('settings — rules card', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'settings')
  await expect(page.getByTestId('rules-card')).toBeVisible()
  await shot(page, 'rules-settings')
})

// Phase E/F screens — seeded demo data + fixed ?now= keep the pixels deterministic.
test('trips', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'trips')
  await expect(page.getByTestId('trip-card').first()).toBeVisible()
  await shot(page, 'trips')
})

test('settings — fx + assist cards', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'settings')
  await expect(page.getByTestId('fx-card')).toBeVisible()
  await expect(page.getByTestId('assist-card')).toBeVisible()
  await shot(page, 'fx-assist-settings')
})

test('year in review', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'trends')
  await page.getByTestId('year-in-review-btn').click()
  await expect(page.getByTestId('year-in-review')).toBeVisible()
  await shot(page, 'year-in-review')
})
