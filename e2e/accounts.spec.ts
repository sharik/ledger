import { expect, test } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'

/**
 * "Which periods did I forget to import?" had no surface: the `stmt-gap` note fires once at
 * import and is dismissible, and drift hints need a balance anchor on *both* sides of a hole,
 * so neither can see a period simply skipped — least of all the trailing one.
 */
test.describe('statement coverage', () => {
  test('the account panel charts what was imported and names the gap', async ({ page }) => {
    await setupVault(page, { demo: false })
    await page.getByTestId('import-btn').click()
    await page.getByTestId('import-file').setInputFiles(F1)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    await goTab(page, 'accounts')
    // Collapsed by default — this is reference material, not something to look at every visit.
    await expect(page.getByTestId('coverage')).toHaveCount(0)

    await page.locator('[aria-label="View snapshot history"]').first().click()
    await expect(page.getByTestId('coverage')).toBeVisible()

    // f1 covers 2026-02-05 → 2026-06-11 against a 2026-07-12 clock: one trailing gap.
    await expect(page.getByTestId('coverage-covered')).toHaveCount(1)
    await expect(page.getByTestId('coverage-covered')).toHaveAttribute('title', /2026-02-05 → 2026-06-11.*f1\.xlsx.*330 rows/)
    await expect(page.getByTestId('coverage-summary')).toContainText('1 gap')
    await expect(page.getByTestId('coverage-gap-row')).toContainText('Nothing imported since 2026-06-12')

    // drawn to scale: 127 covered days against 31 missing ones
    const covered = (await page.getByTestId('coverage-covered').boundingBox())!
    const gap = (await page.getByTestId('coverage-gap').boundingBox())!
    expect(covered.width).toBeGreaterThan(gap.width * 2)
  })

  test('re-importing the same period reports no gap rather than an overlap', async ({ page }) => {
    await setupVault(page, { demo: false })
    for (const _ of [0, 1]) {
      await page.getByTestId('import-btn').click()
      await page.getByTestId('import-file').setInputFiles(F1)
      // The second pass short-circuits as already-imported (§12.3); either way no hole appears.
      await page.waitForTimeout(1500)
      const confirm = page.getByTestId('confirm-import')
      if (await confirm.count()) await confirm.click()
      else await page.getByTestId('import-cancel').click()
      await page.waitForTimeout(500)
    }
    await goTab(page, 'accounts')
    await page.locator('[aria-label="View snapshot history"]').first().click()
    await expect(page.getByTestId('coverage-covered')).toHaveCount(1)
  })
})

/**
 * Retiring an account (`Account.hidden`) must take it out of every total and list while
 * leaving the row — and the underlying data — intact and recoverable.
 */
test.describe('hidden accounts', () => {
  /** Expand an account's row by its balance testid and open the detail panel. */
  const expand = async (page: import('@playwright/test').Page, name: string) => {
    await page.getByTestId(`balance-${name}`).locator('xpath=ancestor::*[@aria-label="View snapshot history"]').click()
  }

  test('hiding drops the balance from the tiles but keeps the row', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')

    const nw = page.getByTestId('kpi-networth')
    const assets = page.getByTestId('kpi-assets')
    const beforeNw = (await nw.textContent())!
    const beforeAssets = (await assets.textContent())!
    const beforeChartEnd = (await page.getByTestId('nw-chart-last').textContent())!
    const livret = (await page.getByTestId('balance-Livret A').textContent())!
    expect(livret).toContain('35,000')

    await expand(page, 'Livret A')
    await page.getByTestId('account-hide').click()

    // the row survives, dimmed and badged, still showing its own balance
    await expect(page.getByTestId('account-hidden-badge-Livret A')).toBeVisible()
    await expect(page.getByTestId('balance-Livret A')).toHaveText(livret)
    await expect(page.getByTestId('hidden-accounts-note')).toContainText('1 hidden account')

    // …but €35,000 has left both tiles
    await expect(assets).not.toHaveText(beforeAssets)
    await expect(nw).not.toHaveText(beforeNw)
    // netLbl signs with a Unicode minus (U+2212), so parse the sign before stripping.
    const eur = (s: string) => (/[−-]/.test(s) ? -1 : 1) * Number(s.replace(/[^0-9.]/g, ''))
    expect(eur(beforeAssets) - eur((await assets.textContent())!)).toBe(35000)
    expect(eur(beforeNw) - eur((await nw.textContent())!)).toBe(35000)

    // the net-worth history re-derived too, not just the current tile
    await expect(page.getByTestId('nw-chart-last')).not.toHaveText(beforeChartEnd)
  })

  test('the flag persists across a lock/unlock, and unhiding restores the exact totals', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')
    const nw = page.getByTestId('kpi-networth')
    const before = (await nw.textContent())!

    await expand(page, 'Livret A')
    await page.getByTestId('account-hide').click()
    await expect(page.getByTestId('account-hidden-badge-Livret A')).toBeVisible()

    // survives a real reload → it went through encrypt/decrypt, not just React state
    await page.waitForTimeout(1400)
    await page.reload()
    await unlock(page)
    await goTab(page, 'accounts')
    await expect(page.getByTestId('account-hidden-badge-Livret A')).toBeVisible()
    await expect(nw).not.toHaveText(before)

    await expand(page, 'Livret A')
    await page.getByTestId('account-unhide').click()
    await expect(page.getByTestId('account-hidden-badge-Livret A')).toHaveCount(0)
    await expect(page.getByTestId('hidden-accounts-note')).toHaveCount(0)
    await expect(nw).toHaveText(before)
  })

  test('undo from the toast restores the totals', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')
    const nw = page.getByTestId('kpi-networth')
    const before = (await nw.textContent())!

    await expand(page, 'Livret A')
    await page.getByTestId('account-hide').click()
    await expect(nw).not.toHaveText(before)

    await page.getByTestId('toast').getByText('Undo').click()
    await expect(nw).toHaveText(before)
    await expect(page.getByTestId('account-hidden-badge-Livret A')).toHaveCount(0)
  })

  test('hiding every account zeroes the tiles without breaking the screen', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await setupVault(page)
    await goTab(page, 'accounts')

    for (const name of ['BNP Joint', 'Revolut · EUR', 'Livret A', 'Mortgage']) {
      await expand(page, name)
      await page.getByTestId('account-hide').click()
    }
    await expect(page.getByTestId('kpi-networth')).toHaveText(/^[+−]?€0$/) // netLbl always signs
    await expect(page.getByTestId('kpi-assets')).toHaveText('€0')
    await expect(page.getByText('No balance history yet.')).toBeVisible()
    await expect(page.getByTestId('hidden-accounts-note')).toContainText('4 hidden accounts')
    expect(errors).toEqual([])
  })
})
