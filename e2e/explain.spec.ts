// The <Explain> panel — the affordance that replaces ~66 native `title=` attributes.
// These tests assert the things a `title` could never do: appear on keyboard focus, hold
// structure, and be dismissed predictably.
import { test, expect } from '@playwright/test'
import { goTab, setupVault } from './helpers'

test.describe('explain panel', () => {
  test('hover shows a hint; FOCUS ALONE shows it too — which a title attribute cannot', async ({ page }) => {
    await setupVault(page)
    const btn = page.getByTestId('explain-dash.spend')
    await expect(btn).toBeVisible()

    await btn.hover()
    await expect(page.getByTestId('chart-tip')).toContainText('Expenses only')
    await page.mouse.move(0, 0)

    // The whole point: reachable without a pointer.
    await btn.focus()
    await expect(page.getByTestId('chart-tip')).toContainText('Expenses only')
  })

  test('click opens a panel with all four sections in order', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.spend').click()
    const panel = page.getByTestId('explain-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('What this is')
    await expect(panel).toContainText('How it’s calculated')
    await expect(panel).toContainText('What it excludes')
    // "what am I looking at" must come before "should I trust it".
    // textContent, not innerText — the section labels are CSS-uppercased when rendered.
    const text = (await panel.textContent()) ?? ''
    expect(text.indexOf('What this is')).toBeLessThan(text.indexOf('How it’s calculated'))
    expect(text.indexOf('How it’s calculated')).toBeLessThan(text.indexOf('What it excludes'))
  })

  test('Escape closes it and returns focus to the ? button', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.spend').click()
    await expect(page.getByTestId('explain-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('explain-panel')).toHaveCount(0)
    const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(label).toBe('What is Spend · this month?')
  })

  test('a click outside closes it', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.spend').click()
    await expect(page.getByTestId('explain-panel')).toBeVisible()
    // (5, 400) is beside the panel on a desktop layout, but a phone panel spans the bottom of
    // the screen and owns that point — so aim above it there.
    const vp = page.viewportSize()!
    await page.mouse.click(5, vp.width < 720 ? 90 : 400)
    await expect(page.getByTestId('explain-panel')).toHaveCount(0)
  })

  test('opening a second ? closes the first — never two panels at once', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.spend').click()
    await expect(page.getByTestId('explain-panel')).toHaveAttribute('data-explain-id', 'dash.spend')
    await page.getByTestId('explain-dash.savings-rate').click()
    await expect(page.getByTestId('explain-panel')).toHaveCount(1)
    await expect(page.getByTestId('explain-panel')).toHaveAttribute('data-explain-id', 'dash.savings-rate')
  })

  test('"Where to go next" navigates and closes', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.savings-rate').click()
    await page.getByTestId('explain-next').first().click()
    await expect(page.getByTestId('explain-panel')).toHaveCount(0)
    expect(page.url()).toContain('#/settings')
  })

  test('a chart card carries its own ?, in normal and full screen', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    await expect(page.getByTestId('explain-trends.year-projection').first()).toBeVisible()
    await page.getByTestId('trend-yearly-expand').click()
    await expect(page.getByTestId('trend-yearly-fullscreen')).toBeVisible()
    await expect(page.getByTestId('trend-yearly-fullscreen').getByTestId('explain-trends.year-projection')).toBeVisible()
  })

  test('the assistant handoff stays hidden until the chat is switched on', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('explain-dash.spend').click()
    await expect(page.getByTestId('explain-ask')).toHaveCount(0)
  })
})
