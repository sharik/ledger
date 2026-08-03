import { expect, test } from '@playwright/test'
import { appUrl, goTab, setupVault, unlock } from './helpers'

const TABS = ['dash', 'compare', 'trends', 'trips', 'plan', 'accounts', 'txns', 'settings']

test.describe('new app shell', () => {
  test('all 8 nav tabs are present and switch the active pane', async ({ page }) => {
    await setupVault(page)
    for (const t of TABS) {
      await goTab(page, t)
      await expect(page.locator(`[data-tab="${t}"]`)).toHaveAttribute('aria-current', 'page')
    }
    // the header Import button reaches the (non-nav) import view
    await page.getByTestId('import-btn').click()
    await expect(page.getByTestId('dropzone')).toBeVisible()
  })

  test('theme toggle flips the document theme and persists across reload', async ({ page }) => {
    await setupVault(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.goto(appUrl())
    await unlock(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('the notes counter is hidden when there are no unreviewed notes', async ({ page }) => {
    // The counter → notes-sheet open flow is exercised end-to-end in sync.spec's
    // conflict test (which needs two devices to produce a real note). Here we only
    // assert the quiescent state: an empty vault has no notes, so no counter shows.
    // (The demo seed intentionally ships a couple of notes for the "2 NOTES" chip.)
    await setupVault(page, { demo: false })
    await expect(page.getByTestId('notes-count')).toHaveCount(0)
  })
})
