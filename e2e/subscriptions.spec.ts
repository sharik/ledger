// The recurring/subscriptions surface. Two rules are load-bearing and are asserted here:
// the total counts CONFIRMED rows only, and a cadence is never presented as a due date.
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('recurring & subscriptions', () => {
  // The caption said "N confirmed" while counting only the LIVE rows, with the stopped ones
  // listed directly beneath it — so the number contradicted the list it sat above.
  test('shows a total and names which rows the count describes', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await expect(page.getByTestId('subscriptions')).toBeVisible()
    await expect(page.getByTestId('sub-total')).toContainText('/ month')
    await expect(page.getByTestId('sub-total')).toContainText('active')
  })

  // A stopped charge has a last date, not a next one, and the year matters: "last 19 Aug" on a
  // July screen was eleven months old and rendered like this month.
  test('a stopped row carries the year, and its detail says how long and how much', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    const stopped = page.locator('[data-sub-state="lapsed"]')
    if (await stopped.count()) {
      await expect(stopped.first()).toContainText(/none since \d+ \w+ \d{4}/)
    }
    // Any row opens a detail with the count, the span and the money — all previously uncomputed.
    await page.getByTestId('sub-expand').first().click()
    const detail = page.getByTestId('sub-detail')
    await expect(detail).toContainText('charges counted')
    await expect(detail).toContainText('in total')
    await expect(detail).toContainText('BY YEAR')
    // Bounded by what Ledger can know.
    await expect(detail).toContainText('Counted, not billed')
  })

  // The refusal the questionary makes explicit (§2, Q15–Q20): Ledger has no billing
  // calendar, so it must never imply one.
  test('never says a charge is due — only that it is expected', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    // No ROW may imply a due date…
    for (const r of await page.getByTestId('sub-row').all()) {
      const t = (await r.textContent()) ?? ''
      expect(t).not.toMatch(/\bdue\b/i)
      expect(t).toMatch(/expected ≈|last /)
    }
    // …and the section states the refusal outright.
    expect(await page.getByTestId('subscriptions').textContent()).toContain('not a due date')
  })

  test('a suggestion is shown apart from the total, and says so', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    const unconfirmed = page.getByTestId('subs-unconfirmed')
    if (await unconfirmed.count()) {
      await expect(unconfirmed).toContainText('not in the total')
      for (const r of await unconfirmed.getByTestId('sub-row').all()) {
        await expect(r).toHaveAttribute('data-confirmed', '0')
      }
    }
  })

  test('a row drills to its own transactions', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    // The merchant name is the drill; the row also carries an expand control, so the row itself
    // cannot be one button any more.
    const rows = page.getByTestId('sub-row')
    if (await rows.count()) {
      await rows.first().locator('button').first().click()
      await expect(page).toHaveURL(/#\/txns/)
    }
  })
})
