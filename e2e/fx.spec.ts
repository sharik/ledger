import { test, expect } from '@playwright/test'
import { setupVault, goTab } from './helpers'

// Phase E: FX stack end-to-end — a foreign account, a manual override, an API
// refresh via route interception, and the converted figure on the Accounts table.
test.describe('exchange rates', () => {
  async function addUsdAccount(page: import('@playwright/test').Page) {
    await goTab(page, 'accounts')
    await page.getByTestId('add-account').click()
    await page.getByTestId('account-name-input').fill('US Savings')
    await page.locator('input[placeholder="Balance today"]').fill('1000')
    await page.locator('select[title="Currency"]').selectOption('USD')
    await page.getByTestId('add-account-go').click()
    await expect(page.getByTestId('balance-US Savings')).toBeVisible()
  }

  test('a manual override converts a foreign balance into the base currency', async ({ page }) => {
    await setupVault(page)
    await addUsdAccount(page)

    await goTab(page, 'settings')
    await expect(page.getByTestId('fx-source-USD')).toContainText(/no rate/i)
    await page.getByTestId('fx-ov-rate').fill('0.9')
    await page.getByTestId('fx-ov-add').click()
    await expect(page.getByTestId('fx-source-USD')).toContainText(/override/i)

    await goTab(page, 'accounts')
    // 1000 USD × 0.9 = €900, exact (override) ⇒ '=' marker.
    await expect(page.getByTestId('balance-conv-US Savings')).toContainText('900')
    await expect(page.getByTestId('balance-conv-US Savings')).toContainText('=')
  })

  test('Refresh rates fetches the API tier (mocked); nearest-earlier shows ≈', async ({ page }) => {
    await setupVault(page)
    await addUsdAccount(page)

    // Intercept the provider so the test never hits the network.
    await page.route('**/currencies/eur.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: '2026-07-01', eur: { usd: 1.25 } }) }),
    )

    await goTab(page, 'settings')
    await page.getByTestId('fx-refresh').click()
    // Table is dated the 1st; the balance is dated the 12th ⇒ nearest-earlier ≈.
    await expect(page.getByTestId('fx-source-USD')).toContainText('≈')

    await goTab(page, 'accounts')
    await expect(page.getByTestId('balance-conv-US Savings')).toContainText('≈')
    await expect(page.getByTestId('balance-conv-US Savings')).toContainText('800') // 1000 / 1.25
  })
})
