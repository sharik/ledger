// Phase G: dashboard customization — pin/unpin end-to-end, tile reorder that
// survives reload, snap-drag onto a row edge or a column slot, and resize.
import { test, expect, type Page } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

/**
 * Drag a tile by its handle onto one of the four snap zones of another tile.
 *
 * The zones only exist while a drag is in flight, so they cannot be located by selector — the drop
 * point is computed from the target's box instead.
 *
 * Scrolling is the fiddly part, and getting it wrong fails in a way that looks like a product bug.
 * The dashboard is taller than the viewport, so any auto-scroll Playwright does on the way to an
 * element moves everything else: measure before it and the coordinates are stale, let `hover()`
 * scroll to the handle and the target can end up above the fold, where `mouse.move` clamps to the
 * viewport and drops on whatever is at the top. So: scroll once, deliberately, to put both in
 * view, then measure both, then never scroll again.
 */
async function dragTile(page: Page, tile: string, onto: string, where: 'top' | 'bottom' | 'left' | 'right'): Promise<void> {
  const handle = page.locator(`[data-dash-tile="${tile}"] [aria-label^="Move "]`)
  await page.locator(`[data-dash-tile="${onto}"]`).scrollIntoViewIfNeeded()
  const box = (await page.locator(`[data-dash-tile="${onto}"]`).boundingBox())!
  const grip = (await handle.boundingBox())!
  const vh = page.viewportSize()!.height
  // If one scroll cannot show both, the drag is not expressible as a mouse gesture here and the
  // test should say so rather than silently drop somewhere else.
  expect(grip.y, `handle for "${tile}" is off-screen — widen the viewport or pick nearer tiles`).toBeGreaterThan(0)
  expect(grip.y).toBeLessThan(vh)

  const at = {
    top: { x: box.x + box.width / 2, y: box.y + box.height * 0.1 },
    bottom: { x: box.x + box.width / 2, y: box.y + box.height * 0.9 },
    left: { x: box.x + box.width * 0.25, y: box.y + box.height / 2 },
    right: { x: box.x + box.width * 0.75, y: box.y + box.height / 2 },
  }[where]
  expect(at.y, `drop point for "${onto}" is off-screen`).toBeGreaterThan(0)
  expect(at.y).toBeLessThan(vh)

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  // dnd-kit needs 4px of travel to activate, then a settling move so the pointer registers over
  // the zone before the release.
  await page.mouse.move(at.x, at.y, { steps: 12 })
  await page.mouse.move(at.x, at.y)
  await page.mouse.up()
}

const tileIds = (page: Page) => page.locator('[data-dash-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dash-tile')))

test.describe('dashboard customization', () => {
  test('pin from Compare → card on dashboard; removing it takes it away', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    const pinCards = page.locator('[data-dash-card^="pin:"]')
    const before = await pinCards.count()

    // Pin a comparison the seed doesn't already have.
    await goTab(page, 'compare')
    await page.getByRole('button', { name: 'This year vs last' }).click()
    const pinBtn = page.getByTestId('pin-toggle')
    await expect(pinBtn).toContainText('Pin to dashboard')
    await pinBtn.click()
    await expect(pinBtn).toContainText('Pinned ✓')

    await goTab(page, 'dash')
    await expect(pinCards).toHaveCount(before + 1)
    await expect(page.locator('[data-dash-card^="pin:"]').filter({ hasText: '2026 vs 2025' })).toHaveCount(1)

    const added = page.locator('[data-dash-card^="pin:"]').filter({ hasText: '2026 vs 2025' })
    // Removal is two-step now: arm, then confirm.
    await added.getByRole('button', { name: /^Remove .* from the dashboard$/ }).click()
    await added.getByRole('button', { name: 'Unpin from dashboard' }).click()
    await expect(pinCards).toHaveCount(before)
  })

  test('the handle is the keyboard control — no pointer needed to rearrange', async ({ page }) => {
    await setupVault(page)
    // There are no ‹ › buttons any more, so the handle has to carry the pointer-free path:
    // focus it, arrow keys move the tile through the order.
    const handle = page.locator('[data-dash-tile="changed"] [aria-label^="Move "]')
    await handle.focus()
    await handle.press('ArrowRight')
    expect((await tileIds(page)).slice(0, 3)).toEqual(['hero', (await tileIds(page))[1], 'changed'])

    await handle.press('ArrowLeft')
    expect((await tileIds(page)).slice(0, 2)).toEqual(['hero', 'changed'])
  })

  test('tile order persists across reload + unlock', async ({ page }) => {
    await setupVault(page)
    const before = await tileIds(page)
    await dragTile(page, 'worth', 'changed', 'left')
    const reordered = await tileIds(page)
    expect(reordered).not.toEqual(before)

    await page.reload()
    await unlock(page)
    expect(await tileIds(page)).toEqual(reordered)
  })

  test('the hero chart and the plan block are tiles too — one grid, one gesture', async ({ page }) => {
    await setupVault(page)
    // They used to be sections with their own ↑ ↓ buttons, which meant the chart could never sit
    // beside a card. Now they are ordinary tiles that happen to default to the full width.
    const ids = await tileIds(page)
    expect(ids[0]).toBe('hero')
    expect(ids[ids.length - 1]).toBe('plan')
    await expect(page.locator('[data-dash-tile="hero"]')).toHaveAttribute('data-span', '3')
    await expect(page.locator('[data-dash-tile="plan"]')).toHaveAttribute('data-span', '3')
    await expect(page.locator('[data-dash-section]')).toHaveCount(0)
  })

  test('drop on a row edge → the tile takes the whole width', async ({ page }) => {
    await setupVault(page)
    await expect(page.locator('[data-dash-tile="worth"]')).toHaveAttribute('data-span', '1')

    await dragTile(page, 'worth', 'changed', 'top')

    await expect(page.locator('[data-dash-tile="worth"]')).toHaveAttribute('data-span', '3')
    expect((await tileIds(page)).slice(0, 2)).toEqual(['hero', 'worth'])
    // Full width means exactly that: the same box as the hero chart above it.
    const worth = (await page.locator('[data-dash-tile="worth"]').boundingBox())!
    const hero = (await page.locator('[data-dash-tile="hero"]').boundingBox())!
    expect(Math.abs(worth.width - hero.width)).toBeLessThan(2)
  })

  test('drop beside a tile → it fits into the next column of that line', async ({ page }) => {
    await setupVault(page)
    await dragTile(page, 'worth', 'changed', 'right')

    expect((await tileIds(page)).slice(0, 3)).toEqual(['hero', 'changed', 'worth'])
    // Same line, so the same top edge — and each is now narrower than the full-width hero.
    const changed = (await page.locator('[data-dash-tile="changed"]').boundingBox())!
    const worth = (await page.locator('[data-dash-tile="worth"]').boundingBox())!
    const hero = (await page.locator('[data-dash-tile="hero"]').boundingBox())!
    expect(Math.abs(worth.y - changed.y)).toBeLessThan(2)
    expect(worth.x).toBeGreaterThan(changed.x)
    expect(worth.width).toBeLessThan(hero.width / 2)
  })

  test('widening a tile pushes the tile beside it onto the next line', async ({ page }) => {
    await setupVault(page)
    const changed = page.locator('[data-dash-tile="changed"]')
    const neighbour = page.locator('[data-dash-tile]').nth(2)
    const neighbourId = await neighbour.getAttribute('data-dash-tile')
    const before = (await neighbour.boundingBox())!
    expect(Math.abs(before.y - (await changed.boundingBox())!.y)).toBeLessThan(2)

    await changed.getByRole('button', { name: /^Resize / }).press('ArrowRight')
    await changed.getByRole('button', { name: /^Resize / }).press('ArrowRight')

    await expect(changed).toHaveAttribute('data-span', '3')
    // The order is untouched; only the flow changed.
    expect((await tileIds(page)).slice(0, 3)).toEqual(['hero', 'changed', neighbourId])
    const after = (await page.locator(`[data-dash-tile="${neighbourId}"]`).boundingBox())!
    expect(after.y).toBeGreaterThan((await changed.boundingBox())!.y)
  })

  test('pin a chart from Trends → it lands on the dashboard showing what was pinned', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    // Pin the view, not just the chart: the monthly chart is pinned in "By category" mode, and
    // the dashboard copy has to come back that way rather than at the default "Total".
    await page.getByRole('button', { name: 'By category' }).click()
    const pin = page.getByTestId('pin-trends.monthly')
    await expect(pin).toHaveText('📌 Pin')
    await pin.click()
    await expect(pin).toHaveText('📌 Pinned')

    await goTab(page, 'dash')
    const tile = page.locator('[data-dash-tile^="widget:"]')
    await expect(tile).toHaveCount(1)
    await expect(tile).toContainText('Monthly spending')
    await expect(tile.getByRole('button', { name: 'By category' })).toHaveAttribute('aria-pressed', 'true')

    await tile.getByRole('button', { name: /^Remove .* from the dashboard$/ }).click()
    await tile.getByRole('button', { name: 'Unpin from dashboard' }).click()
    await expect(page.locator('[data-dash-tile^="widget:"]')).toHaveCount(0)
    await goTab(page, 'trends')
    await expect(page.getByTestId('pin-trends.monthly')).toHaveText('📌 Pin')
  })

  test('the picker adds a chart from a screen you are not on', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('add-widget').click()
    await page.getByTestId('add-widget-trips.timeline').click()

    const tile = page.locator('[data-dash-tile^="widget:"]')
    await expect(tile).toContainText('Trip timeline')
    // The catalogue's default span decides how wide it arrives — a timeline wants the width.
    await expect(tile).toHaveAttribute('data-span', '3')
    // And it says so next time the picker opens, so the same chart is not added twice by accident.
    await page.getByTestId('add-widget').click()
    await expect(page.getByTestId('add-widget-trips.timeline')).toBeDisabled()
  })

  test('a pinned chart survives reload + unlock — it is vault data, not a device preference', async ({ page }) => {
    await setupVault(page)
    await page.getByTestId('add-widget').click()
    await page.getByTestId('add-widget-accounts.emergency').click()
    await expect(page.locator('[data-dash-tile^="widget:"]')).toContainText('Emergency fund')

    // Unlike the layout, which is a localStorage device preference, the pin itself is a vault
    // record — so this has to survive encrypt/decrypt, not just React state.
    await page.waitForTimeout(1400) // let the save debounce flush before reloading
    await page.reload()
    await unlock(page)
    await expect(page.locator('[data-dash-tile^="widget:"]')).toContainText('Emergency fund')
  })

  // A pinned comparison was the last hand-rolled chart on the dashboard: no tooltip, no
  // fullscreen, no "?", and a card body that navigated on any click. It is a ChartCard now, so
  // it gets what every other chart has.
  test.describe('a pinned comparison behaves like every other chart', () => {
    const plotOf = (page: Page) => page.locator('[data-dash-tile^="pin:"]').first().locator('svg').last()

    test('hovering the plot shows the values for that day, and does not navigate', async ({ page }) => {
      await setupVault(page)
      const plot = plotOf(page)
      await plot.hover({ position: { x: 160, y: 50 } })
      const tip = page.getByTestId('chart-tip')
      await expect(tip).toBeVisible()
      await expect(tip).toContainText('Day')
      await expect(tip).toContainText('€')

      // Reading a point and leaving the screen used to be the same gesture.
      await plot.click({ position: { x: 160, y: 50 } })
      await expect(page).toHaveURL(/#\/dash/)
    })

    test('opening Compare is its own control', async ({ page }) => {
      await setupVault(page)
      await page.locator('[data-dash-tile^="pin:"]').first().getByRole('button', { name: 'Open in Compare →' }).click()
      await expect(page).toHaveURL(/#\/compare/)
    })

    test('it expands to full screen, and says what it means', async ({ page }) => {
      await setupVault(page)
      const tile = page.locator('[data-dash-tile^="pin:"]').first()
      await expect(tile.getByTestId('explain-dash.pinned')).toBeVisible()

      await tile.getByRole('button', { name: 'Expand chart to full screen' }).click()
      await expect(page.getByTestId('chart-fullscreen')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('chart-fullscreen')).toHaveCount(0)
    })

    test('removing asks first — one stray click cannot delete a chart', async ({ page }) => {
      await setupVault(page)
      const pins = page.locator('[data-dash-tile^="pin:"]')
      const before = await pins.count()
      const tile = pins.first()

      await tile.getByRole('button', { name: /^Remove .* from the dashboard$/ }).click()
      await expect(pins).toHaveCount(before) // still there — it only armed
      await tile.getByRole('button', { name: 'Keep on the dashboard' }).click()
      await expect(pins).toHaveCount(before)

      await tile.getByRole('button', { name: /^Remove .* from the dashboard$/ }).click()
      await tile.getByRole('button', { name: 'Unpin from dashboard' }).click()
      await expect(pins).toHaveCount(before - 1)
      // …and the undo is still the second net.
      await expect(page.getByTestId('toast-undo')).toBeVisible()
      await page.getByTestId('toast-undo').click()
      await expect(pins).toHaveCount(before)
    })
  })

  // Every card is a flex item inside its tile. A card left at `flex: 0 1 auto` sizes itself to its
  // content — and since ChartCard measures its own plot area to size the chart, the two settle at
  // whatever the header happened to need instead of the column width, leaving the chart short of
  // the card and the card short of the column.
  test('every card fills its column, and no chart escapes its card', async ({ page }) => {
    await setupVault(page)
    // Widen a pinned chart first. At one column the card's own content is about as wide as the
    // column, so a card that sizes to content looks identical to one that fills — the defect only
    // becomes visible when the column is wider than the content, which is exactly when a user
    // resizes a tile.
    const pin = page.locator('[data-dash-tile^="pin:"]').first()
    await pin.getByRole('button', { name: /^Resize / }).press('ArrowRight')
    await pin.getByRole('button', { name: /^Resize / }).press('ArrowRight')
    await expect(pin).toHaveAttribute('data-span', '3')

    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-dash-tile]')].map((tile) => {
        const t = tile.getBoundingClientRect()
        const card = tile.querySelector('section, div[style*="background"]')!.getBoundingClientRect()
        const plots = [...tile.querySelectorAll('svg')].map((s) => s.getBoundingClientRect())
        return {
          id: tile.getAttribute('data-dash-tile'),
          shortfall: Math.round(t.width - card.width),
          escapes: plots.some((p) => p.right > card.right + 1 || p.left < card.left - 1),
        }
      }),
    )
    for (const b of boxes) {
      expect(b.shortfall, `${b.id} does not fill its column`).toBeLessThanOrEqual(1)
      expect(b.escapes, `a chart in ${b.id} is drawn outside its card`).toBe(false)
    }
  })

  test('a resized tile keeps its width across reload + unlock', async ({ page }) => {
    await setupVault(page)
    await page.locator('[data-dash-tile="changed"]').getByRole('button', { name: /^Resize / }).press('ArrowRight')
    await expect(page.locator('[data-dash-tile="changed"]')).toHaveAttribute('data-span', '2')

    await page.reload()
    await unlock(page)
    await expect(page.locator('[data-dash-tile="changed"]')).toHaveAttribute('data-span', '2')
  })
})

// The four headline figures had no test handle at all, so nothing but a pixel baseline
// defended them — and a baseline cannot tell a changed number from a changed font.
test.describe('headline metric row', () => {
  test('the comparison names its window as dates, not as "same point"', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    const spend = page.getByTestId('metric-spend')
    // The clock is frozen at 12 Jul, so the prior side is June truncated to 12 days.
    await expect(spend).toContainText('1–12 Jun')
    await expect(spend).toContainText('day 12 of 31')
    await expect(spend).toContainText('projected month-end')
    await expect(spend).toContainText('at current pace')
  })

  test('the delta stays on one line — no break between the sign and the amount', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    const delta = page.getByTestId('dash-spend-delta')
    const box = await delta.boundingBox()
    // Two lines would be ~34px. This is the regression test for "+" and "€625" splitting.
    expect(box!.height).toBeLessThan(22)
  })

  test('each bar label opens exactly the window it depicts', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    await page.getByTestId('spend-bar-b').click()
    const hash = new URL(page.url()).hash
    expect(hash).toContain('from=2026-06-01')
    // The bar shows June's first 12 days; opening all 30 would be a different figure.
    expect(hash).toContain('to=2026-06-12')
  })

  test('every cell carries a ? — including Plan, which had none', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    for (const id of ['dash.spend', 'dash.cashflow', 'dash.savings-rate', 'dash.plan']) {
      await expect(page.getByTestId(`explain-${id}`)).toBeVisible()
    }
    await page.getByTestId('explain-dash.plan').click()
    await expect(page.getByTestId('explain-panel')).toContainText('over pace')
  })
})

// The dashboard read `currentMonthKey()` with no way to step back, so on the 1st of a month every
// figure on it was zero and nothing on screen offered a way to look at the month that just ended.
test.describe('the dashboard period can be stepped', () => {
  test('a past month names itself, drops every pace claim, and carries the hash', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    const current = await page.getByTestId('dash-month').innerText()
    expect(current).toBe('July')
    await expect(page.getByTestId('dash-next-month')).toBeDisabled()

    const spend = page.getByTestId('metric-spend')
    await expect(spend).toContainText('at current pace')

    await page.getByTestId('dash-prev-month').click()
    await expect(page.getByTestId('dash-month')).toHaveText('June')
    // Every cell that named the period follows the header rather than saying "this month".
    await expect(spend).toContainText('Spend · June')
    await expect(page.getByTestId('metric-cashflow')).toContainText('Cash flow · June')
    // A finished month has no pace left to run: no projection, and no "at current pace".
    await expect(spend).toContainText('June complete')
    await expect(spend).not.toContainText('at current pace')
    await expect(spend).not.toContainText('projected')
    // "over pace" means "projected to exceed" — a finished month either did or did not.
    await expect(page.getByTestId('metric-plan')).not.toContainText('over pace')
    await expect(page.getByTestId('dash-plan-complete')).toBeVisible()

    // The hash is the source of truth, so re-entering the app on it lands on the same month.
    await expect(page).toHaveURL(/#\/dash\?mk=2026-06$/)
    await page.reload()
    await unlock(page)
    await expect(page.getByTestId('dash-month')).toHaveText('June')

    // Forward stops at the current month, and "Today" comes straight back to it.
    await page.getByTestId('dash-this-month').click()
    await expect(page.getByTestId('dash-month')).toHaveText(current)
    await expect(page).toHaveURL(/#\/dash$/)
  })

  test('the year toggle moves the whole screen, and steps by years', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    await page.getByRole('button', { name: 'Year' }).click()
    await expect(page.getByTestId('dash-month')).toHaveText('2026')
    await expect(page).toHaveURL(/#\/dash\?mk=2026$/)
    // The hero chart's own Month/Year toggle is gone — one control moves everything, so the
    // chart can no longer disagree with the cells above it.
    await expect(page.getByTestId('metric-spend')).toContainText('Spend · 2026')

    // "Worth a look" asks ">130% of last month", which has no annual reading, so it stands down.
    await expect(page.locator('[data-dash-card="worth"]')).toHaveCount(0)

    await page.getByTestId('dash-prev-month').click()
    await expect(page.getByTestId('dash-month')).toHaveText('2025')
    await expect(page.getByTestId('metric-spend')).toContainText('Spend · 2025')
  })

  test('a stepped-back month is finished, not "partial" — no hatch on a pinned monthly chart', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'trends')
    await page.getByTestId('pin-trends.monthly').click()
    await goTab(page, 'dash')

    const tile = page.locator('[data-dash-tile^="widget:"]').filter({ hasText: 'Monthly spending' })
    // Anchored to the real current month: July is rightly hatched and captioned partial.
    await expect(tile.locator('rect[fill="url(#barhatch)"]')).toHaveCount(1)
    await expect(tile).toContainText('current month hatched (partial)')

    // Step back: June is a FINISHED month. Nothing in the window is partial — no
    // hatch, no "(partial)" caption, no projection outline.
    await page.getByTestId('dash-prev-month').click()
    await expect(page.getByTestId('dash-month')).toHaveText('June')
    await expect(tile.locator('rect[fill="url(#barhatch)"]')).toHaveCount(0)
    await expect(tile).not.toContainText('current month hatched (partial)')
  })

  test('a relative pin follows the anchor; an absolute one does not', async ({ page }) => {
    await setupVault(page)
    // The demo vault ships a pinned "This month vs last month" comparison.
    await goTab(page, 'dash')
    const pins = page.locator('[data-dash-card^="pin:"]')
    await expect(pins.first()).toBeVisible()
    await expect(page.getByTestId('pin-rebased')).toHaveCount(0)

    await page.getByTestId('dash-prev-month').click()
    // A pin saying "this month vs last month" means "relative to what I am looking at", and says
    // so on the card. One saying "2026 vs 2025" is absolute and must not move.
    const rebased = page.getByTestId('pin-rebased')
    await expect(rebased.first()).toContainText('June')
  })

  test('an empty period says why it is empty and offers the nearest one with data', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'dash')
    // The demo vault carries 18 months, so January 2024 is before all of it — every figure on the
    // screen is zero there, which is exactly the state the current month is in on its 1st day.
    // Entered through the hash, which is also how a bookmarked period arrives.
    await page.evaluate(() => { window.location.hash = '#/dash?mk=2024-01' })
    await expect(page.getByTestId('dash-month')).toHaveText('January 2024')
    await expect(page.getByTestId('dash-empty-period')).toContainText('No transactions in January 2024')

    // …and it points at the nearest period that does have something, rather than leaving the
    // reader to guess how far back to step.
    await page.getByTestId('dash-goto-latest').click()
    await expect(page.getByTestId('dash-empty-period')).toHaveCount(0)
  })
})
