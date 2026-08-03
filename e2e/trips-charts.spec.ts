import { test, expect } from '@playwright/test'
import { setupVault, goTab } from './helpers'

// The per-trip charts: real ChartCards, so they expand to full screen and pin to the dashboard.
// A pin carries the trip id in its params, so two trips pin as two distinct tiles.
test.describe('trip charts', () => {
  const openFirstTrip = async (page: import('@playwright/test').Page) => {
    await goTab(page, 'trips')
    await page.getByTestId('trip-card').first().getByTestId('trip-card-open').click()
    await expect(page.getByTestId('trip-detail')).toBeVisible()
  }

  test('the daily chart expands to full screen and Escape closes it', async ({ page }) => {
    await setupVault(page)
    await openFirstTrip(page)

    await page.getByTestId('trip-chart-daily-expand').click()
    await expect(page.getByTestId('trip-chart-daily-fullscreen')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('trip-chart-daily-fullscreen')).toHaveCount(0)
  })

  test('the category chart shows every category, not a top five', async ({ page }) => {
    await setupVault(page)
    await openFirstTrip(page)
    // The card caps at five and points here; the trip view is where "all" lives.
    await expect(page.getByTestId('trip-chart-cats')).toContainText(/All \d+ categor/)
  })

  test('pinning a trip chart puts it on the dashboard under that trip’s name', async ({ page }) => {
    await setupVault(page)
    await openFirstTrip(page)
    const tripName = (await page.getByTestId('trip-detail-rows').textContent())?.trim() ?? ''

    await page.getByTestId('pin-trips.daily').click()
    await expect(page.getByTestId('pin-trips.daily')).toHaveAttribute('aria-pressed', 'true')

    await goTab(page, 'dash')
    await expect(page.getByText(`${tripName} · daily spend`).first()).toBeVisible()
  })
})
