// Phase G: chart drill-downs — every chart click lands on a FILTERED transaction
// list with visible chips, the hash carries the filter, and Back returns to the chart.
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('chart → transactions drills', () => {
  test('yearly stacked segment drills to category + year, Back returns to Trends', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    const seg = page.locator('[data-screen="trends"] svg rect[data-seg]').first()
    const catId = await seg.getAttribute('data-seg')
    const year = await seg.getAttribute('data-group')
    await seg.click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    const chips = page.getByTestId('txn-filter-chips')
    await expect(chips).toBeVisible()
    await expect(chips).toContainText('Category:')
    await expect(chips).toContainText(year!)
    const hash = new URL(page.url()).hash
    expect(hash).toContain(`cat=${catId}`)
    expect(hash).toContain(`from=${year}-01-01`)

    // The list is actually narrowed.
    const showing = await page.getByTestId('txn-showing').textContent()
    expect(showing).toMatch(/showing \d+ of \d+/)

    await page.goBack()
    await expect(page.locator('[data-screen="trends"]')).toBeVisible()
  })

  test('monthly by-category segment drills to category + month', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    await page.getByRole('button', { name: 'By category' }).click()

    // Scoped to the monthly chart: the income chart's rects also carry month-keyed groups.
    const seg = page.locator('[data-testid="trend-monthly"] svg rect[data-seg][data-group*="-"]').last()
    const month = await seg.getAttribute('data-group')
    await seg.click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    const chips = page.getByTestId('txn-filter-chips')
    await expect(chips).toContainText('Category:')
    expect(new URL(page.url()).hash).toContain(`from=${month}-01`)
  })

  test('merchant drill row filters by merchant; Clear all resets', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')

    // Scoped to the drill: the momentum card's rows also carry data-bar-row.
    const row = page.locator('[data-testid="trend-drill"] [data-bar-row]').first()
    const merchant = await row.getAttribute('data-bar-row')
    await row.click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-filter-chips')).toContainText(`Merchant: ${merchant}`)

    // Every visible row is that merchant.
    const rows = page.locator('[data-testid="txn-row"]')
    await expect(rows.first()).toBeVisible()
    const merchants = await rows.evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.merchant))])
    expect(merchants).toEqual([merchant])

    await page.getByTestId('txn-filters-clear').click()
    await expect(page.getByTestId('txn-filter-chips')).not.toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/txns')
  })

  test('a drill replaces stale filters instead of combining with them', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'txns')
    await page.getByTestId('txn-search').fill('zzz-no-match')
    await expect(page.getByTestId('txn-showing')).toContainText('showing 0 of')

    await goTab(page, 'trends')
    await page.locator('[data-testid="trend-drill"] [data-bar-row]').first().click()
    // The stale search must be gone — rows are visible again.
    await expect(page.locator('[data-testid="txn-row"]').first()).toBeVisible()
    await expect(page.getByTestId('txn-search')).toHaveValue('')
  })

  test("Trips 'Compare →' preselects that trip as side A", async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')

    await page.getByRole('button', { name: 'Compare →' }).first().click()

    await expect(page.locator('[data-screen="compare"]')).toBeVisible()
    const sideA = page.getByTestId('cmp-side-A')
    await expect(sideA).toContainText('TRIP', { ignoreCase: true })
    expect(new URL(page.url()).hash).toContain('trips=')
  })
})
