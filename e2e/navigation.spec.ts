// Phase G: hash routing — browser Back/Forward navigate tabs, reload restores
// the tab after unlock, and each tab remembers its scroll position.
import { test, expect } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

const screen = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-screen="${id}"]`)

test.describe('hash routing', () => {
  test('tab clicks write the hash; Back and Forward walk the history', async ({ page }) => {
    await setupVault(page)
    await expect(screen(page, 'dash')).toBeVisible()

    await goTab(page, 'trends')
    await expect(screen(page, 'trends')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/trends')

    await goTab(page, 'plan')
    await expect(screen(page, 'plan')).toBeVisible()

    await page.goBack()
    await expect(screen(page, 'trends')).toBeVisible()
    await expect(screen(page, 'plan')).not.toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/trends')

    await page.goBack()
    await expect(screen(page, 'dash')).toBeVisible()

    await page.goForward()
    await expect(screen(page, 'trends')).toBeVisible()
  })

  test('reload + unlock restores the tab from the hash', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')
    await expect(screen(page, 'accounts')).toBeVisible()

    await page.reload()
    await unlock(page)
    await expect(screen(page, 'accounts')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/accounts')
  })

  test('each tab remembers its scroll position across Back', async ({ page }) => {
    await setupVault(page)
    const scroller = page.locator('[data-main-scroll]')

    await scroller.evaluate((el) => el.scrollTo(0, 500))
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(500)

    await goTab(page, 'txns')
    // A fresh tab starts at the top, not at the dashboard's offset.
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0)

    await page.goBack()
    await expect(screen(page, 'dash')).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(500)
  })

  test('nav tabs are real buttons, keyboard-activatable', async ({ page }) => {
    await setupVault(page)
    const trends = page.locator('[data-tab="trends"]')
    await expect(trends).toHaveRole('button')
    await trends.focus()
    await page.keyboard.press('Enter')
    await expect(screen(page, 'trends')).toBeVisible()
  })
})
