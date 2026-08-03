import { test, expect } from '@playwright/test'
import { setupVault, goTab } from './helpers'

// The trip detail view at phone width, under the 390×844 `mobile` project. This replaces the old
// "trip mode" overlay: the same focused one-trip reading, but a route rather than an overlay, so
// it deep-links, survives a reload and answers to Back.
test('the trip detail renders a focused view on a phone viewport', async ({ page }) => {
  await setupVault(page)
  await goTab(page, 'trips')
  await page.getByTestId('open-current-trip').click()

  const detail = page.getByTestId('trip-detail')
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/#\/trips\?trip=/)
  // Both per-trip charts render, not just a truncated category list.
  await expect(page.getByTestId('trip-chart-daily')).toBeVisible()
  await expect(page.getByTestId('trip-chart-cats')).toBeVisible()
  await expect(page.getByTestId('trip-members')).toBeVisible()

  // The page body must not scroll horizontally at phone width.
  const overflow = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)
  expect(overflow).toBe(true)

  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("400 14px 'IBM Plex Sans'"),
      document.fonts.load("600 14px 'IBM Plex Sans'"),
      document.fonts.load("400 11px 'IBM Plex Mono'"),
    ])
    await document.fonts.ready
  })
  await page.waitForTimeout(200)
  await expect(page).toHaveScreenshot('trip-detail.png')

  await page.getByTestId('trip-detail-back').click()
  await expect(detail).toHaveCount(0)
  await expect(page.getByTestId('trip-card').first()).toBeVisible()
})
