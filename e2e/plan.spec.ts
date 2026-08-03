// Phase G: proportional bullet budget bars + goal edit/archive.
import { test, expect } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

test.describe('plan', () => {
  test('an overspent budget reports its real percentage, proportional to others', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')

    // Add a deliberately tiny budget for a category with existing spend.
    await page.getByRole('button', { name: '+ Budget' }).click()
    await page.getByPlaceholder('Amount').fill('10')
    await page.getByTestId('budget-save').click()

    const over = page.locator('[data-screen="plan"] [data-over="true"]').first()
    await expect(over).toBeVisible()
    const pct = Number(await over.getAttribute('data-pct'))
    expect(pct).toBeGreaterThan(100)

    // Percentages differ across rows — the bars are proportional, not clamped.
    const pcts = await page
      .locator('[data-screen="plan"] [data-pct]')
      .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.pct)))
    expect(new Set(pcts).size).toBeGreaterThan(1)
  })

  // Freshness is a statement fact or it is nothing. Plan used to print TODAY'S DATE in a caption
  // identical to the Dashboard's statement-derived one, so budget bars looked safe when the last
  // statement was weeks old. The demo seed hides this — it always imports through today — so these
  // two tests force the divergence instead.
  test('an empty vault says so, instead of claiming data through today', async ({ page }) => {
    await setupVault(page, { demo: false })
    await goTab(page, 'plan')
    await expect(page.getByTestId('plan-freshness')).toHaveText('no imported data')
    // The old bug rendered "data through 12 Jul" here with zero statements imported.
    await expect(page.getByTestId('plan-freshness')).not.toContainText('data through')
  })

  test('Plan and Dashboard report the same freshness, from the same source', async ({ page }) => {
    await setupVault(page)
    const dash = await page.getByTestId('dash-freshness').innerText()
    expect(dash).toMatch(/^data through /)
    await goTab(page, 'plan')
    await expect(page.getByTestId('plan-freshness')).toHaveText(dash)
  })

  test('goals can be edited and archived (and come back)', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')

    await page.getByRole('button', { name: '+ Goal' }).click()
    await page.getByTestId('goal-name').fill('Bike fund')
    // A target is now required: without one there is no fraction and no ETA, so the row could
    // never say anything. The dialog refuses rather than making a goal that cannot move.
    await page.getByPlaceholder('Target').fill('2000')
    await page.getByTestId('goal-save').click()
    await expect(page.locator('[data-screen="plan"]')).toContainText('Bike fund')

    // Edit via the row menu.
    const plan = page.locator('[data-screen="plan"]')
    // Scoped to Plan: the Dashboard keeps its own (hidden) copy of the goal rows mounted, so an
    // unscoped [data-goal-row] matches twice.
    await plan.locator('[data-goal-row="Bike fund"]').getByRole('button', { name: 'Goal options' }).click()
    await page.getByRole('button', { name: 'Edit goal…' }).click()
    await page.getByTestId('goal-name').fill('Bike fund II')
    await page.getByTestId('goal-save').click()
    await expect(page.locator('[data-screen="plan"]')).toContainText('Bike fund II')

    // Archive hides it; the archived list restores it.
    await plan.locator('[data-goal-row="Bike fund II"]').getByRole('button', { name: 'Goal options' }).click()
    await page.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByTestId('goals-archived-toggle')).toContainText('1 archived')

    await page.getByTestId('goals-archived-toggle').click()
    await page.getByRole('button', { name: 'Unarchive' }).click()
    await expect(page.getByTestId('goals-archived-toggle')).not.toBeVisible()
    await expect(page.locator('[data-screen="plan"]')).toContainText('Bike fund II')
  })
})

test.describe('budget roll-up', () => {
  test('adds up the monthly budgets and says how many are over', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await expect(page.getByTestId('budget-rollup')).toBeVisible()
    await expect(page.getByTestId('rollup-summary')).toContainText('over')
  })

  // The exclusion rule is the feature: an annual budget is not this month's money.
  test('an annual budget does not inflate the monthly total — it becomes a memo line', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    const before = await page.getByTestId('budget-rollup').locator('[data-pct]').first().getAttribute('data-pct')

    await page.getByRole('button', { name: '+ Budget' }).click()
    await page.getByTestId('budget-scope').selectOption('annual')
    await page.getByPlaceholder('Amount').fill('2400')
    await page.getByTestId('budget-save').click()

    await expect(page.getByTestId('rollup-memo')).toContainText('annual')
    const after = await page.getByTestId('budget-rollup').locator('[data-pct]').first().getAttribute('data-pct')
    expect(after).toBe(before)
  })

  // The rule the user asked for: budgets may overlap, and a transaction two of them cover is
  // counted once. So a group over an already-budgeted category does not inflate the total by its
  // own amount — it REPLACES the narrower budget's contribution to the plan.
  test('a group over an already-budgeted category does not double-count', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    const rollup = page.getByTestId('budget-rollup')
    const spentBefore = await rollup.locator('[data-pct]').first().getAttribute('data-pct')

    await page.getByRole('button', { name: '+ Budget' }).click()
    await page.getByTestId('budget-scope').selectOption('group-m')
    const opts = page.getByTestId('budget-cat-option')
    await opts.filter({ hasText: 'Dining out' }).click() // already has its own budget
    await opts.filter({ hasText: 'Entertainment' }).click()
    await expect(page.getByTestId('budget-overlap')).toContainText('Dining out')
    await page.getByTestId('budget-name').fill('Fun')
    await page.getByPlaceholder('Amount').fill('600')
    await page.getByTestId('budget-save').click()

    await expect(page.locator('[data-screen="plan"]')).toContainText('Fun')
    // The screen states the rule where the figure is.
    await expect(page.getByTestId('rollup-dedup')).toContainText('counted once')
    // Dining out became a sub-limit, so the plan grew by (600 − 320), not by 600.
    const pctAfter = Number(await rollup.locator('[data-pct]').first().getAttribute('data-pct'))
    expect(pctAfter).toBeLessThan(Number(spentBefore))
  })
})

// Plan read `currentMonthKey()` with no way to step back, so QUESTIONARY Q121 ("did I stay in
// budget last month?") had no answer on the screen that owns budgets.
test.describe('the plan month can be stepped', () => {
  test('a past month drops the pace figures, carries the hash, and survives reload', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await expect(page.getByTestId('plan-freshness')).toBeVisible()
    const current = await page.getByTestId('plan-month').innerText()

    await page.getByTestId('plan-prev-month').click()
    await expect(page.getByTestId('plan-month')).not.toHaveText(current)
    // Inside this year the year says nothing, so the label is the month alone.
    await expect(page.getByTestId('plan-month')).toHaveText('June')
    // A finished month has no pace and no "time elapsed" — those describe a month in progress.
    await expect(page.getByTestId('plan-month-complete')).toBeVisible()
    await expect(page.getByTestId('plan-freshness')).toHaveCount(0)
    await expect(page).toHaveURL(/#\/plan\?mk=\d{4}-\d{2}/)

    // The hash is the source of truth, so re-entering the app on it lands on the same month —
    // the reason the month lives in the route rather than in component state alone.
    const past = await page.getByTestId('plan-month').innerText()
    await page.reload()
    await unlock(page)
    await expect(page.getByTestId('plan-month')).toHaveText(past)

    // …and it appears as soon as the month is not in this year.
    for (let i = 0; i < 6; i++) await page.getByTestId('plan-prev-month').click()
    await expect(page.getByTestId('plan-month')).toHaveText('December 2025')

    // Forward stops at the current month, and "Today" comes straight back to it.
    await page.getByTestId('plan-this-month').click()
    await expect(page.getByTestId('plan-month')).toHaveText(current)
    await expect(page.getByTestId('plan-next-month')).toBeDisabled()
    await expect(page).toHaveURL(/#\/plan$/)
  })
})

test.describe('a budget explains itself', () => {
  test('the name drills to the transactions the bar was measured from', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByTestId('budget-open').first().click()
    await expect(page).toHaveURL(/#\/txns\?.*cat=/)
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-01/)
  })

  test('expanding a row charts the periods, and a bar drills to one', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByTestId('budget-menu').first().click()
    await page.getByTestId('budget-expand').click()
    const detail = page.getByTestId('budget-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('LAST 12 MONTHS')
    // Q120: what this actually cost, from complete months only.
    await expect(detail).toContainText('average')

    await detail.locator('[data-group]').first().click()
    await expect(page).toHaveURL(/#\/txns/)
  })

  // A "group" budget had no single-filter equivalent, so its history bar routed to a query with
  // only from/to on it — clicking a "Fun" bar opened every transaction in the month.
  test('a group budget drills to its own categories, not to the whole month', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByRole('button', { name: '+ Budget' }).click()
    await page.getByTestId('budget-scope').selectOption('group-m')
    const opts = page.getByTestId('budget-cat-option')
    await opts.filter({ hasText: 'Dining out' }).click()
    await opts.filter({ hasText: 'Entertainment' }).click()
    await page.getByTestId('budget-name').fill('Fun')
    await page.getByPlaceholder('Amount').fill('600')
    await page.getByTestId('budget-save').click()

    const fun = page.locator('[data-screen="plan"]').locator('div', { hasText: /^Fun/ }).first()
    await expect(fun).toBeVisible()
    // The name drills, and it carries the member set rather than a bare date range.
    await page.getByTestId('budget-open').filter({ hasText: 'Fun' }).click()
    await expect(page).toHaveURL(/#\/txns\?.*cats=[^&]+%2C[^&]+/)
    // The screen says which categories it is holding, so the narrowed list is not a mystery.
    await expect(page.getByTestId('txn-filter-chips')).toContainText('Categories:')
    await expect(page.getByTestId('filter-cat')).toContainText('Dining out + Entertainment')
  })

  test('exactly one "?" sits on the BUDGETS label', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    // Both plan.rollup and plan.budget-bar used to hang here as two identical glyphs.
    await expect(page.getByTestId('budgets-kicker').locator('button[aria-label^="What is"]')).toHaveCount(1)
    // plan.rollup now sits on the figure it describes.
    await expect(page.getByTestId('budget-rollup').getByTestId('explain-plan.rollup')).toBeVisible()
  })

  test('the off-plan block says what its figures are', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    const off = page.getByTestId('budget-offplan')
    await expect(off).toContainText('How far each budget is from its own limit')
    // Every figure carries its direction as a word, so it cannot read as spend.
    for (const t of await off.locator('[data-bar-row]').allInnerTexts()) {
      expect(t).toMatch(/over|left/)
    }
  })
})

test.describe('goals can be set up', () => {
  test('a balance-linked goal is creatable and shows a real bar', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByRole('button', { name: '+ Goal' }).click()
    await page.locator('[data-testid="goal-kind"][data-kind="save-up"]').click()
    await page.getByTestId('goal-name').fill('House deposit')
    await page.getByPlaceholder('Target').fill('50000')
    await page.getByTestId('goal-save').click()

    const row = page.locator('[data-screen="plan"] [data-goal-row="House deposit"]')
    await expect(row).toContainText('balance-linked')
    // The middle column has a bar, not the blank the old form always produced.
    expect(await row.locator('div[style*="position: absolute"]').count()).toBeGreaterThan(0)
  })

  test('a hand-tracked goal takes a starting amount, so it is not frozen at zero', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByRole('button', { name: '+ Goal' }).click()
    await page.locator('[data-testid="goal-kind"][data-kind="manual"]').click()
    await page.getByTestId('goal-name').fill('New bike')
    await page.getByPlaceholder('Target').fill('1000')
    await page.getByTestId('goal-saved').fill('250')
    await page.getByPlaceholder('Monthly').fill('100')
    await page.getByTestId('goal-save').click()

    const row = page.locator('[data-screen="plan"] [data-goal-row="New bike"]')
    // 250 of 1000 with 100/month lands in 8 months — a real ETA, not "behind" forever.
    await expect(row).toContainText('ETA')
    await expect(row).not.toContainText('not enough history')
  })

  test('a goal dialog is a real dialog: Escape closes it', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'plan')
    await page.getByRole('button', { name: '+ Goal' }).click()
    await expect(page.getByTestId('goal-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('goal-dialog')).toHaveCount(0)
  })
})
