// Phase G chart kit: hover tooltips on line charts and true fullscreen expand
// (bigger geometry, not CSS scaling).
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('chart kit', () => {
  test('hero chart shows a crosshair tooltip on hover', async ({ page }) => {
    await setupVault(page)
    const svg = page.locator('[data-testid="hero-chart"] svg')
    await svg.hover({ position: { x: 400, y: 120 } })
    const tip = page.getByTestId('chart-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('Day')
    // Named, not deictic. The dashboard can be pointed at any month now, so a tooltip reading
    // "this month" over a March chart would be false; it says which period it is drawing.
    await expect(tip).toContainText('July')
    await expect(tip).toContainText('June')
  })

  test('expand opens a fullscreen dialog with larger geometry; Esc closes', async ({ page }) => {
    await setupVault(page)
    const cardSvgWidth = await page.locator('[data-testid="hero-chart"] svg').evaluate((el) => el.getBoundingClientRect().width)

    await page.getByTestId('hero-chart-expand').click()
    const fs = page.getByTestId('hero-chart-fullscreen')
    await expect(fs).toBeVisible()
    await expect(fs).toHaveRole('dialog')
    const fsSvgWidth = await fs.locator('svg').evaluate((el) => el.getBoundingClientRect().width)
    expect(fsSvgWidth).toBeGreaterThan(cardSvgWidth)
    expect(fsSvgWidth).toBeGreaterThan(1100)

    await page.keyboard.press('Escape')
    await expect(fs).not.toBeVisible()
  })

  test('net-worth chart tooltip shows month and value', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')
    const svg = page.locator('[data-testid="nw-card"] svg')
    await svg.hover({ position: { x: 300, y: 100 } })
    await expect(page.getByTestId('chart-tip')).toBeVisible()
  })

  // The category card opens on its head; the tail used to be unreachable, so a category outside
  // the top six — exactly the one a reader comes here doubting — could not be seen at all.
  test('Compare’s category card opens its whole list and folds back', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'compare')
    const rows = page.locator('[data-cmp-bar^="A-"]')
    await expect(rows).toHaveCount(6)

    const toggle = page.getByTestId('cmp-cats-all')
    await expect(toggle).toContainText(/Show all \d+/)
    const total = Number((await toggle.innerText()).match(/\d+/)![0])
    expect(total).toBeGreaterThan(6)

    await toggle.click()
    await expect(rows).toHaveCount(total)
    await expect(toggle).toHaveText('Show top 6')
    await toggle.click()
    await expect(rows).toHaveCount(6)
  })

  // Movers is the same head-of-list card, and its tail was unreachable for the same reason. The
  // demo vault moves exactly six categories, so the condition has to be made before it can be
  // tested: three of this month's rows into three categories that were not moving.
  test('Compare’s movers card opens its whole list once there is a tail to open', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'compare')
    await expect(page.getByTestId('cmp-movers-all')).toHaveCount(0) // six movers ⇒ nothing to expand

    await goTab(page, 'txns')
    for (const [i, cat] of ['Health', 'Insurance', 'Taxes & fees'].entries()) {
      await page.getByTestId('select-mode').click()
      await page.getByTestId('txn-check').nth(i).check()
      const pick = page.locator(`[data-bulk-cat="${cat}"]`)
      if ((await pick.count()) === 0) await page.getByTestId('bulk-more').click() // past the 8 inline
      await pick.click()
    }

    await goTab(page, 'compare')
    const section = page.locator('[data-screen="compare"] section').filter({ hasText: 'Movers' }).first()
    const rows = section.locator('[data-bar-row]')
    await expect(rows).toHaveCount(6)

    const toggle = page.getByTestId('cmp-movers-all')
    const total = Number((await toggle.innerText()).match(/\d+/)![0])
    expect(total).toBeGreaterThan(6)
    await toggle.click()
    await expect(rows).toHaveCount(total)
    await expect(section).toContainText(`All ${total} that moved`)
    await toggle.click()
    await expect(rows).toHaveCount(6)
  })

  // Both sides offered five presets, every one of them relative to now — any other month or year
  // could only be reached by asking the assistant to open the comparison.
  test('Compare puts any month or year on a side', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'compare')
    const sideA = page.getByTestId('cmp-side-A')
    await expect(sideA).toContainText('July 2026')

    await sideA.click()
    await page.getByTestId('cmp-A-prev-month').click()
    await page.getByTestId('cmp-A-prev-month').click()
    await expect(sideA).toContainText('May 2026')
    // The menu stays open while stepping — the next month is one click, not three.
    await expect(page.getByTestId('cmp-A-month')).toBeVisible()

    await page.getByTestId('cmp-A-gran').getByRole('button', { name: 'Year' }).click()
    await expect(sideA).toContainText('2026')
    await expect(page.getByTestId('cmp-A-next-month')).toBeDisabled() // never the future
  })

  test('Compare cumulative keeps its day-aligned tooltip', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'compare')
    const svg = page.locator('[data-testid="cmp-cum"] svg')
    await svg.hover({ position: { x: 300, y: 100 } })
    const tip = page.getByTestId('chart-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('Day')
  })
})
