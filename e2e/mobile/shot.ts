import { expect, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ShotMode } from './surfaces'

/**
 * Screenshotting a phone screen in this app needs a trick, and it is worth stating why.
 *
 * `toHaveScreenshot()` on a page captures the VIEWPORT, not the document (audit finding C11a).
 * `fullPage: true` does not rescue it here either: the shell is `height:100vh; overflow:hidden`
 * and the real scrolling happens inside `[data-main-scroll]`, so the document is always exactly
 * one viewport tall — "full page" and "viewport" are the same picture. Screenshotting the
 * scroller as an element has the same problem: its box is one viewport too.
 *
 * So instead of trying to capture past the fold, we remove the fold: grow the VIEWPORT HEIGHT
 * to the pane's scrollHeight, capture, then restore. The shell is height-driven, so it grows
 * with the viewport and reveals the whole pane.
 *
 * Width is deliberately left alone. `ChartCard` re-renders every chart from a `ResizeObserver`
 * on its measured width, so changing the width mid-capture would reflow the charts and we would
 * be photographing a layout the user never sees.
 */

const MAX_TALL = 4000

/** Force the web fonts to settle. `fonts.ready` alone can resolve mid-swap on text-heavy panes. */
async function settle(page: Page): Promise<void> {
  // The faces come from fonts.googleapis.com, so a transient network error is possible — and a
  // screenshot rendered in the fallback face is a far better outcome than a failed gate.
  await page.evaluate(async () => {
    try {
      await Promise.all([
        document.fonts.load("400 14px 'IBM Plex Sans'"),
        document.fonts.load("600 14px 'IBM Plex Sans'"),
        document.fonts.load("700 20px 'IBM Plex Sans'"),
        document.fonts.load("400 11px 'IBM Plex Mono'"),
      ])
      await document.fonts.ready
    } catch {
      /* fall back to whatever is loaded */
    }
  })
  await page.waitForTimeout(200)
}

/** Grow the viewport to fit the whole pane, run `fn`, then put the viewport back. */
async function tall<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const before = page.viewportSize()
  if (!before) throw new Error('tall(): no viewport size')
  const needed = await page.evaluate(() => {
    const sc = document.querySelector('[data-main-scroll]')
    if (!sc) return 0
    // The pane wrapper, not the scroller: the scroller itself is clipped to the viewport by flex.
    const inner = sc.firstElementChild
    return (inner?.scrollHeight ?? sc.scrollHeight) + (window.innerHeight - sc.clientHeight)
  })
  const height = Math.min(Math.max(needed + 40, before.height), MAX_TALL)
  try {
    await page.setViewportSize({ width: before.width, height })
    await settle(page)
    return await fn()
  } finally {
    await page.setViewportSize(before)
  }
}

/**
 * Compare against a committed baseline.
 *
 * `maxDiffPixelRatio` is set explicitly rather than inherited: the global 0.02 is
 * boundary-inclusive (Playwright fails only on *strictly greater*), and a real regression once
 * measured exactly 0.02 and passed — see audit finding C11b. Note also that
 * `--update-snapshots` only rewrites a baseline on FAILURE, so to force a new one you must
 * delete the PNG first.
 */
export async function mobileShot(page: Page, name: string, mode: ShotMode, target?: string): Promise<void> {
  if (mode === 'none') return
  const opts = { maxDiffPixelRatio: 0.005 } as const

  if (mode === 'element') {
    if (!target) throw new Error(`mobileShot('${name}'): mode 'element' needs a shotTarget`)
    await settle(page)
    await expect(page.locator(target).first()).toHaveScreenshot(`${name}.png`, opts)
    return
  }
  if (mode === 'viewport') {
    await settle(page)
    await expect(page).toHaveScreenshot(`${name}.png`, opts)
    return
  }
  await tall(page, async () => {
    await expect(page).toHaveScreenshot(`${name}.png`, opts)
  })
}

/**
 * Where the audit's evidence gallery lands. Git-ignored, and deliberately NOT under
 * `test-results/` — Playwright empties that directory at the start of every run, so any
 * unrelated `playwright test` invocation would delete the audit data the report is built from.
 */
export const GALLERY = '.mobile-audit/shots'

/**
 * Capture a PNG as evidence, without creating a baseline.
 *
 * This is what the audit uses. A baseline is a *comparison target*: committing one for a layout
 * that the next ten phases are going to replace means rebaselining it ten times and reviewing
 * churn instead of change. Real baselines start per surface, in the phase that reshapes it.
 *
 * The picture still has to be lookable-at, though. Attaching alone is not enough — the `list`
 * reporter discards attachments, so the evidence would exist only inside a passing test. So the
 * bytes are also written to `.mobile-audit/shots/<project>/<surface>.png`, which is git-ignored
 * but browsable.
 */
export async function attachShot(
  page: Page,
  info: TestInfo,
  name: string,
  mode: ShotMode,
  target?: string,
): Promise<void> {
  if (mode === 'none') return
  const dir = `${GALLERY}/${info.project.name}`
  const attach = async (body: Buffer): Promise<void> => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${name}.png`, body)
    await info.attach(`${name}.png`, { body, contentType: 'image/png' })
  }
  if (mode === 'element') {
    if (!target) return
    await settle(page)
    const el = page.locator(target).first()
    if ((await el.count()) === 0) return
    await attach(await el.screenshot())
    return
  }
  if (mode === 'viewport') {
    await settle(page)
    await attach(await page.screenshot())
    return
  }
  await tall(page, async () => {
    await attach(await page.screenshot())
  })
}
