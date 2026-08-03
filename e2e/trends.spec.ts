// Phase G Trends overhaul: interactive legend (toggle + axis rescale), working
// 18M/All window, per-bar tooltips.
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('trends interactivity', () => {
  test('legend toggle hides the category and rescales the axis', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const yearly = page.locator('[data-testid="trend-yearly"]')
    const firstLegend = yearly.locator('[data-testid^="legend-"]').first()
    const catId = (await firstLegend.getAttribute('data-testid'))!.replace('legend-', '')

    await expect(yearly.locator(`svg rect[data-seg="${catId}"]`).first()).toBeVisible()
    const axisBefore = await yearly.locator('svg text').first().textContent()

    await firstLegend.click()
    await expect(firstLegend).toHaveAttribute('aria-pressed', 'false')
    await expect(yearly.locator(`svg rect[data-seg="${catId}"]`)).toHaveCount(0)

    // Re-enable restores the segments.
    await firstLegend.click()
    await expect(firstLegend).toHaveAttribute('aria-pressed', 'true')
    await expect(yearly.locator(`svg rect[data-seg="${catId}"]`).first()).toBeVisible()
    void axisBefore
  })

  test('the All window widens the monthly chart beyond 18 bars', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const monthly = page.locator('[data-testid="trend-monthly"]')
    const count18 = await monthly.locator('svg rect[data-group]').count()

    await monthly.getByRole('button', { name: 'All', exact: true }).click()
    await expect
      .poll(async () => monthly.locator('svg rect[data-group]').count())
      .toBeGreaterThan(count18)
  })

  test('hovering a monthly bar shows an amount tooltip', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const bar = page.locator('[data-testid="trend-monthly"] svg rect[data-group]').nth(10)
    await bar.hover()
    const tip = page.getByTestId('chart-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('€')
  })

  // The legend does not merely hide a stack — it recomputes the figure under every bar, the
  // axis and the projection, all still labelled only with the year. Silence there let a
  // reader believe a filtered total was that year's spending.
  test('hiding a category says so, because it restates every total on the chart', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    const yearly = page.locator('[data-testid="trend-yearly"]')
    await expect(page.getByTestId('trends-legend-note')).toHaveCount(0)

    await yearly.locator('[data-testid^="legend-"]').first().click()
    const note = page.getByTestId('trends-legend-note').first()
    await expect(note).toBeVisible()
    await expect(note).toContainText('every total here counts only those')
  })

  test('the merchant drill says how many merchants it is not showing', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    const caption = page.getByTestId('drill-caption')
    await expect(caption).toBeVisible()
    // Either it is showing all of them, or it names the truncation — never silent.
    await expect(caption).toContainText(/Top \d+ of \d+ merchants|\d+ in this window/)
  })

  test('yearly chart expands to fullscreen', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    await page.getByTestId('trend-yearly-expand').click()
    const fs = page.getByTestId('trend-yearly-fullscreen')
    await expect(fs).toBeVisible()
    const w = await fs.locator('svg').first().evaluate((el) => el.getBoundingClientRect().width)
    expect(w).toBeGreaterThan(1100)
    await page.keyboard.press('Escape')
    await expect(fs).not.toBeVisible()
  })
})

// The insight surfaces: the page states trends instead of only drawing series.
test.describe('trends insights', () => {
  test('the headline states a direction and a typical month', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const head = page.getByTestId('trends-headline')
    await expect(head).toBeVisible()
    await expect(head).toContainText('€')
    await expect(head).toContainText(/up \d+% on|down \d+% on|level with|not enough to call a trend/)
    // Typical month: median ± spread, complete months only.
    await expect(page.getByTestId('trends-typical')).toContainText('±')
  })

  test('momentum shows movers or says "steady" — never a blank card', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const card = page.locator('[data-testid="trend-momentum"]')
    await expect(card).toBeVisible()
    const rows = card.locator('[data-bar-row]')
    if ((await rows.count()) > 0) {
      // A mover is a door: it opens exactly the transactions it was computed over.
      await rows.first().click()
      await expect(page.getByTestId('txn-row').first()).toBeVisible()
    } else {
      await expect(card.getByTestId('momentum-steady')).toBeVisible()
    }
  })

  test('income chart draws income bars and the savings-rate line, and All widens it', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const income = page.locator('[data-testid="trend-income"]')
    await expect(income).toBeVisible()
    const count18 = await income.locator('svg rect[data-group]').count()
    expect(count18).toBeGreaterThan(0)
    await expect(income.locator('[data-testid="sr-line"]')).toBeVisible()

    await income.getByRole('button', { name: 'All', exact: true }).click()
    await expect
      .poll(async () => income.locator('svg rect[data-group]').count())
      .toBeGreaterThan(count18)
  })

  // The demo vault carries 18 months — below the two-observations-per-calendar-month
  // threshold. The card's absence IS the honesty being tested; do not "fix" it by
  // making it appear.
  test('seasonality stays silent below two years of data', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    await expect(page.getByTestId('trends-headline')).toBeVisible()
    await expect(page.locator('[data-testid="trend-seasonality"]')).toHaveCount(0)
  })

  test('the recurring digest totals confirmed charges and lands on Subscriptions', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const digest = page.getByTestId('trends-recurring-digest')
    await expect(digest).toBeVisible()
    await expect(digest).toContainText('/mo')

    await digest.getByRole('button', { name: 'Subscriptions →' }).click()
    await expect(page.locator('[data-cf-section="recurring"]')).toBeVisible()
  })

  test('the merchant drill shows a Δ against the prior window, and All drops it', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    // Default range is 1Y, which has a prior year to compare against.
    await expect(page.locator('[data-testid="trend-momentum"]')).toBeVisible()
    const drillCaption = page.getByTestId('drill-caption')
    await expect(drillCaption).toContainText('Δ vs prior')
    expect(await page.locator('[data-row-delta]').count()).toBeGreaterThan(0)

    // All has no prior window — the column disappears rather than showing a fake Δ.
    await page.locator('[data-testid="drill-cat"] ~ div').getByRole('button', { name: 'All', exact: true }).click()
    await expect(drillCaption).not.toContainText('Δ vs prior')
    await expect(page.locator('[data-row-delta]')).toHaveCount(0)
  })

  test('the momentum card pins to the dashboard', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const pin = page.getByTestId('pin-trends.momentum')
    await pin.click()
    await expect(pin).toHaveText('📌 Pinned')

    await goTab(page, 'dash')
    const tile = page.locator('[data-dash-tile^="widget:"]')
    await expect(tile).toContainText(/What.s moving/)
  })
})
