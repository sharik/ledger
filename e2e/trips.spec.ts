import { test, expect } from '@playwright/test'
import { setupVault, goTab, unlock } from './helpers'

// Phase E: Trips & Trackings screen — cards, creation flow, and the per-trip detail route.
test.describe('trips', () => {
  test('opens a trip as a route that survives a reload, and Back returns to the list', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    await expect(page.getByTestId('trip-card').first()).toBeVisible()
    expect(await page.getByTestId('trip-card').count()).toBeGreaterThanOrEqual(3)

    const tripId = await page.getByTestId('trip-card').first().getAttribute('data-trip')
    await page.getByTestId('trip-card').first().getByTestId('trip-card-open').click()

    await expect(page.getByTestId('trip-detail')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#/trips\\?trip=${tripId}`))

    // Deep-linkable: a reload lands back on the same trip. The old trip mode was React state and
    // could not do this. (The vault re-locks on reload; the query survives it.)
    await page.reload()
    await unlock(page)
    await expect(page.getByTestId('trip-detail')).toBeVisible()

    await page.goBack()
    await expect(page.getByTestId('trip-card').first()).toBeVisible()
    await expect(page.getByTestId('trip-detail')).toHaveCount(0)
  })

  test('a category row drills to that trip AND that category', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    const card = page.getByTestId('trip-card').first()
    const tripId = await card.getAttribute('data-trip')
    await card.getByTestId('trip-card-cat').first().click()

    await expect(page).toHaveURL(new RegExp(`tracking=${tripId}`))
    await expect(page).toHaveURL(/cat=/)
    // Both filters show as active chips, so the list is not silently narrowed.
    await expect(page.getByText(/^Trip: /)).toBeVisible()
  })

  test('the trip title drills by membership, not by dates', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    const card = page.getByTestId('trip-card').first()
    const tripId = await card.getAttribute('data-trip')
    await card.getByTestId('trip-card-rows').click()

    await expect(page).toHaveURL(new RegExp(`tracking=${tripId}`))
    // Membership is curated — a date range is NOT a substitute for it (route.ts).
    await expect(page).not.toHaveURL(/from=/)
  })

  test('the create-trip flow adds a new trip via one atomic mutation', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    const before = await page.getByTestId('trip-card').count()

    await page.getByTestId('new-trip').click()
    await page.getByTestId('trip-name').fill('Summer')
    await page.getByTestId('trip-from').fill('2026-07-01')
    await page.getByTestId('trip-to').fill('2026-07-12')
    await page.getByTestId('trip-to-preview').click()
    await page.getByTestId('trip-to-excl').click()
    await page.getByTestId('trip-create-go').click()

    await expect(page.getByTestId('trip-card').filter({ hasText: 'Summer' })).toBeVisible()
    expect(await page.getByTestId('trip-card').count()).toBe(before + 1)
  })

  test('delete is the only lifecycle action, and it asks first', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    const before = await page.getByTestId('trip-card').count()
    const card = page.getByTestId('trip-card').first()

    await card.getByRole('button', { name: /^Options for / }).click()
    await expect(card.getByText('Archive trip')).toHaveCount(0)
    await card.getByTestId('trip-delete').click()
    await expect(card.getByTestId('trip-delete-confirm')).toBeVisible()
    await card.getByTestId('trip-delete-confirm').click()

    await expect(page.getByTestId('trip-card')).toHaveCount(before - 1)
  })

  test('removing a row from a trip moves its total, and undo puts it back', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    await page.getByTestId('open-current-trip').click()
    await expect(page.getByTestId('trip-detail')).toBeVisible()

    const total = page.getByTestId('trip-detail-total')
    const before = await total.textContent()
    const rows = page.getByTestId('trip-member-row')
    const rowsBefore = await rows.count()
    await rows.first().getByTestId('trip-member-remove').click()

    await expect(rows).toHaveCount(rowsBefore - 1)
    await expect(total).not.toHaveText(before ?? '')

    await page.getByTestId('toast-undo').click()
    await expect(rows).toHaveCount(rowsBefore)
    await expect(total).toHaveText(before ?? '')
  })

  test('a member row recategorizes in place, like a Transactions row', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    await page.getByTestId('open-current-trip').click()

    const row = page.getByTestId('trip-member-row').first()
    const chip = row.getByTestId('recat-chip')
    const before = await chip.textContent()
    await chip.click()
    await page.getByTestId('cat-menu').locator('[data-cat="Groceries"]').click()

    await expect(chip).toHaveText(/Groceries/)
    expect(before).not.toMatch(/Groceries/)
  })

  test('“+ New trip” brings the wizard into view instead of opening it off-screen', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trips')
    await page.getByTestId('new-trip').click()
    // The form lives below the timeline, the cards and the forecast; the button has to take you there.
    await expect(page.getByTestId('trip-name')).toBeInViewport()
  })
})
