import { test, expect } from '@playwright/test'
import { setupVault, goTab } from '../helpers'

/**
 * The phone navigation contract.
 *
 * The desktop header carries eight nav tabs; the phone header carries none, because they moved
 * to a bottom bar. That makes the bar the only way between screens — so these are not cosmetic
 * assertions. The Import case in particular is a regression test: the bar was briefly hidden on
 * that tab to avoid stacking with its sticky action bar, which left the screen with no exit at
 * all. (It could not stack anyway — the bar is a flex sibling *below* the scroller, so a
 * `position: sticky` element inside the scroller stops above it.)
 */
test.describe('phone navigation', () => {
  test('every screen can be left again — including Import', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('import-btn').click()
    await expect(page.getByTestId('dropzone')).toBeVisible()

    await expect(page.getByTestId('mobile-nav')).toBeVisible()
    await goTab(page, 'dash')
    await expect(page.locator('[data-pane="dash"][data-active]')).toBeVisible()
  })

  test('the four primary tabs and the More sheet reach all nine screens', async ({ page }) => {
    await setupVault(page)
    for (const tab of ['dash', 'txns', 'trends', 'plan', 'compare', 'trips', 'accounts', 'settings', 'import']) {
      await goTab(page, tab)
      await expect(page.locator(`[data-pane="${tab}"][data-active]`)).toBeVisible()
    }
  })

  test('the header collapses its actions into a sheet rather than dropping them', async ({ page }) => {
    await setupVault(page)
    // Not on the bar at this width — but reachable, which is the point.
    await expect(page.getByTestId('theme-toggle')).toBeHidden()
    await page.getByTestId('header-more').click()
    await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
