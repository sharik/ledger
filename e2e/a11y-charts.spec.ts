// Keyboard reachability of the chart layer. Before this, only BarChart segments and the
// Trips timeline were reachable; the LineChart crosshair — the only way to read a single
// day's figure — was pointer-only, and Compare's twelve drill targets were plain divs.
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('charts without a mouse', () => {
  test('a line chart crosshair steps with the arrow keys and announces the value', async ({ page }) => {
    await setupVault(page)
    const plot = page.locator('[data-testid="hero-chart"] svg [role="application"]')
    await plot.focus()
    await expect(page.locator('[data-testid="hero-chart"] [data-testid="chart-tip"]')).toHaveCount(0)

    await page.keyboard.press('ArrowRight')
    const tip = page.locator('[data-testid="hero-chart"] [data-testid="chart-tip"]')
    await expect(tip).toBeVisible()
    const first = await tip.innerText()

    await page.keyboard.press('ArrowRight')
    await expect(tip).not.toHaveText(first)

    // The same reading reaches a screen reader, not just the eye.
    await expect(page.locator('[data-testid="hero-chart"] [data-testid="chart-live"]')).toContainText('Day')

    await page.keyboard.press('Escape')
    await expect(tip).toHaveCount(0)
  })

  test('Compare category bars are real buttons, reachable and activatable by keyboard', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'compare')
    const bar = page.locator('[data-cmp-bar]').first()
    await expect(bar).toHaveJSProperty('tagName', 'BUTTON')
    await bar.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#\/txns/)
  })

  test('bar segments announce a category name, not a record id', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    const seg = page.locator('[data-testid="trend-yearly"] rect[role="button"]').first()
    const label = await seg.getAttribute('aria-label')
    expect(label).not.toMatch(/cat[-_]/)
  })

  test('keyboard focus is visible somewhere in the app', async ({ page }) => {
    await setupVault(page)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const outline = await page.evaluate(() => {
      const el = document.activeElement
      return el ? getComputedStyle(el).outlineStyle : 'none'
    })
    expect(outline).not.toBe('none')
  })
})
