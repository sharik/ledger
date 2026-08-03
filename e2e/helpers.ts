import { expect, type Page } from '@playwright/test'

export const PASSWORD = 'hunter22hunter22'
export const FIXED_NOW = '2026-07-12T14:32:00Z'

export function appUrl(opts?: { remote?: string; drive?: string; extra?: string }): string {
  let url = `/?now=${encodeURIComponent(FIXED_NOW)}&kdf=test`
  if (opts?.remote) url += `&remote=test:${opts.remote}`
  if (opts?.drive) url += `&drive=test:${opts.drive}`
  if (opts?.extra) url += opts.extra
  return url
}

/** First-run: create a vault through the real setup screen. */
export async function setupVault(page: Page, opts?: { remote?: string; drive?: string; demo?: boolean }): Promise<void> {
  await page.goto(appUrl(opts))
  await page.getByTestId('password').fill(PASSWORD)
  await page.getByTestId('password2').fill(PASSWORD)
  await page.getByTestId(opts?.demo === false ? 'start-empty' : 'start-demo').click()
  await page.getByTestId('unlock-go').click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

export async function unlock(page: Page, password = PASSWORD): Promise<void> {
  await page.getByTestId('password').fill(password)
  await page.getByTestId('unlock-go').click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

/**
 * Switch tabs.
 *
 * On a phone the nav is a five-slot bottom bar, so four destinations plus More lead and the rest
 * live in a sheet. Every one of them still carries `data-tab`, so the only difference is that
 * some are behind one tap — which is what this fallback absorbs. That is what lets the existing
 * specs run unchanged at 390px.
 */
export async function goTab(page: Page, tab: string): Promise<void> {
  const direct = page.locator(`[data-tab="${tab}"]`).first()
  if (await direct.isVisible()) {
    await direct.click()
    return
  }
  const more = page.getByTestId('nav-more')
  if (await more.isVisible()) {
    await more.click()
    await page.locator(`[data-tab="${tab}"]`).last().click()
    return
  }
  await direct.click()
}

export async function expectStatus(page: Page, re: RegExp): Promise<void> {
  await expect(page.getByTestId('sync-status')).toHaveText(re)
}

/** Unique remote slot name per test run. */
export function remoteName(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Fire the SYNC §3.1 focus trigger (headless pages don't refire real focus events). */
export async function nudgeSync(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

/** Wait out the save debounce, then for the push to land. */
export async function awaitPushed(page: Page): Promise<void> {
  await page.waitForTimeout(1400)
  await expect(page.getByTestId('sync-status')).toHaveText(/SYNCED/, { timeout: 10_000 })
}

/** Repeatedly fire the focus pull-trigger until the element shows the expected text. */
export async function nudgeUntilText(page: Page, testId: string, re: RegExp | string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await nudgeSync(page)
    try {
      await expect(page.getByTestId(testId).first()).toHaveText(re, { timeout: 700 })
      return
    } catch {
      /* keep nudging */
    }
  }
  await expect(page.getByTestId(testId).first()).toHaveText(re, { timeout: 1000 })
}
