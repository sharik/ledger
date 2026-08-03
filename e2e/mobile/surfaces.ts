import type { Page } from '@playwright/test'
import { setupVault, goTab } from '../helpers'

/**
 * The surface catalogue — every screen, sub-state, overlay and popup the audit visits.
 *
 * One source of truth, deliberately: the audit sweep, the mobile visual baselines and the
 * post-fix regression gate all iterate this list, so a surface can never be covered by one
 * and silently missed by the others.
 *
 * Every surface is reached by driving the real UI. Injecting state is not an option — the
 * vault is an AES-GCM blob in IndexedDB keyed off the master password, so there is no
 * plaintext to write. `setupVault()` pays for that once per test and gives back a populated,
 * deterministic app (fixed `?now=`, fast KDF).
 */

export type ShotMode = 'tall' | 'viewport' | 'element' | 'none'

export interface Surface {
  id: string
  group: 'boot' | 'tab' | 'substate' | 'overlay' | 'popover' | 'transient' | 'empty'
  /** How this surface should be captured. `element` needs `shotTarget`. */
  shot: ShotMode
  shotTarget?: string
  /** Drive the app to this surface. Throwing marks the surface unreachable, not the run failed. */
  open: (page: Page) => Promise<void>
}

const F1 = 'tests/fixtures/revolut/f1.xlsx'

/** A populated vault on the dashboard. */
async function demo(page: Page): Promise<void> {
  await setupVault(page)
}

/** An empty vault — the cold-start surfaces. */
async function empty(page: Page): Promise<void> {
  await setupVault(page, { demo: false })
}

/** Land on a tab of the populated vault. */
function tab(id: string): (page: Page) => Promise<void> {
  return async (page) => {
    await demo(page)
    await goTab(page, id)
  }
}

/** The active pane's root — scoping to it avoids matching the eight hidden panes. */
export const ACTIVE = '[data-pane][data-active]'

/**
 * Press a header action.
 *
 * The phone header collapses Save now / notes / assistant / theme into a `⋯` sheet, so on a
 * narrow viewport these live one tap deeper. Mirrors what `goTab` does for the nav.
 */
async function headerAction(page: Page, testid: string): Promise<void> {
  const direct = page.getByTestId(testid)
  if (await direct.isVisible().catch(() => false)) {
    await direct.click()
    return
  }
  await page.getByTestId('header-more').click()
  await page.getByTestId(testid).click()
}

/** Click a button by its visible label inside the active pane. */
async function clickIn(page: Page, name: string): Promise<void> {
  await page.locator(ACTIVE).getByRole('button', { name, exact: true }).first().click()
}

/**
 * Get the assistant drawer unlocked.
 *
 * The chat sits behind a real gate — a configured provider that has *proved* it can call tools
 * (ASSISTANT §4) — so there is no shortcut to the panel. The provider is stubbed to answer the
 * probe; nothing leaves the machine.
 */
async function enableAssistant(page: Page): Promise<void> {
  await goTab(page, 'settings')
  await page.getByTestId('assist-toggle').click()
  await page.getByTestId('assist-provider').selectOption('openrouter')
  await page.getByTestId('assist-model').fill('test/model')
  await page.getByTestId('assist-key').fill('sk-test')
  await page.getByTestId('assist-key').blur()
  await page.route('https://openrouter.ai/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'report_ready', arguments: JSON.stringify({ ready: true }) },
                },
              ],
            },
          },
        ],
      }),
    }),
  )
  await page.getByTestId('assistant-probe').click()
  await page.getByTestId('assistant-chat-toggle').click({ timeout: 15_000 })
  await page.unroute('https://openrouter.ai/**')
}

/** Drive the import screen as far as the review list, using the committed Revolut fixture. */
async function toReview(page: Page): Promise<void> {
  await empty(page)
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
  await page.getByTestId('review-list').waitFor({ timeout: 20_000 })
}

export const SURFACES: Surface[] = [
  // ── boot ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'boot-setup',
    group: 'boot',
    shot: 'viewport',
    open: async (page) => {
      const { appUrl } = await import('../helpers')
      await page.goto(appUrl())
      await page.getByTestId('password').waitFor()
    },
  },
  {
    id: 'boot-unlock',
    group: 'boot',
    shot: 'viewport',
    open: async (page) => {
      await demo(page)
      await goTab(page, 'settings')
      await page.getByTestId('lock-now').click()
      await page.getByTestId('password').waitFor()
    },
  },

  // ── the nine tabs ───────────────────────────────────────────────────────────────────────
  { id: 'tab-dash', group: 'tab', shot: 'tall', open: tab('dash') },
  { id: 'tab-compare', group: 'tab', shot: 'tall', open: tab('compare') },
  { id: 'tab-trends', group: 'tab', shot: 'tall', open: tab('trends') },
  { id: 'tab-trips', group: 'tab', shot: 'tall', open: tab('trips') },
  // The trip detail is a screen now, not the old fixed-inset "trip mode" overlay.
  {
    id: 'screen-trip-detail',
    group: 'tab',
    shot: 'tall',
    open: async (page) => {
      await tab('trips')(page)
      await page.getByTestId('open-current-trip').click()
      await page.getByTestId('trip-detail').waitFor()
    },
  },
  { id: 'tab-plan', group: 'tab', shot: 'tall', open: tab('plan') },
  { id: 'tab-accounts', group: 'tab', shot: 'tall', open: tab('accounts') },
  { id: 'tab-txns', group: 'tab', shot: 'tall', open: tab('txns') },
  { id: 'tab-settings', group: 'tab', shot: 'tall', open: tab('settings') },
  {
    id: 'tab-import',
    group: 'tab',
    shot: 'tall',
    open: async (page) => {
      await demo(page)
      await page.getByTestId('import-btn').click()
      await page.getByTestId('dropzone').waitFor()
    },
  },

  // ── sub-states with no URL of their own ─────────────────────────────────────────────────
  {
    id: 'dash-year',
    group: 'substate',
    shot: 'tall',
    open: async (page) => {
      await tab('dash')(page)
      await clickIn(page, 'Year')
    },
  },
  {
    id: 'trends-by-category',
    group: 'substate',
    shot: 'tall',
    open: async (page) => {
      await tab('trends')(page)
      await clickIn(page, 'By category')
    },
  },
  {
    id: 'trends-all-months',
    group: 'substate',
    shot: 'none',
    open: async (page) => {
      await tab('trends')(page)
      await clickIn(page, 'All')
    },
  },
  {
    id: 'compare-per-day',
    group: 'substate',
    shot: 'tall',
    open: async (page) => {
      await tab('compare')(page)
      await clickIn(page, 'Per day')
    },
  },
  {
    id: 'compare-full-period',
    group: 'substate',
    shot: 'none',
    open: async (page) => {
      await tab('compare')(page)
      await clickIn(page, 'Full period')
    },
  },
  {
    id: 'txns-select-mode',
    group: 'substate',
    shot: 'tall',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('select-mode').click()
      await page.getByTestId('txn-check').first().click()
    },
  },
  {
    id: 'txns-searched',
    group: 'substate',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('txn-search').fill('a')
      await page.getByTestId('txn-showing').waitFor()
    },
  },
  {
    id: 'txns-grouped',
    group: 'substate',
    shot: 'tall',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('group-toggle').click()
    },
  },
  {
    // Stepping BACK, not forward: the seeded vault sits on the current month, where
    // `plan-next-month` is correctly disabled.
    id: 'plan-prev-month',
    group: 'substate',
    shot: 'none',
    open: async (page) => {
      await tab('plan')(page)
      await page.getByTestId('plan-prev-month').click()
      await page.getByTestId('plan-this-month').waitFor()
    },
  },
  { id: 'import-review', group: 'substate', shot: 'tall', open: toReview },
  {
    id: 'import-mapping',
    group: 'substate',
    shot: 'element',
    shotTarget: '[data-testid="mapping-menu"]',
    open: async (page) => {
      await toReview(page)
      await page.getByTestId('mapping-change').click()
      await page.getByTestId('mapping-menu').waitFor()
    },
  },

  // ── overlays ────────────────────────────────────────────────────────────────────────────
  {
    id: 'overlay-year-in-review',
    group: 'overlay',
    shot: 'viewport',
    open: async (page) => {
      await tab('trends')(page)
      await page.getByTestId('year-in-review-btn').click()
      await page.getByTestId('year-in-review').waitFor()
    },
  },
  {
    id: 'overlay-chart-fullscreen',
    group: 'overlay',
    shot: 'viewport',
    open: async (page) => {
      await tab('dash')(page)
      await page.getByTestId('hero-chart-expand').click()
      await page.getByTestId('hero-chart-fullscreen').waitFor()
    },
  },
  {
    id: 'overlay-txn-detail',
    group: 'overlay',
    shot: 'viewport',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('txn-row').first().click()
      await page.getByTestId('txn-detail').waitFor()
    },
  },
  {
    id: 'overlay-sync-notes',
    group: 'overlay',
    shot: 'viewport',
    open: async (page) => {
      await demo(page)
      await headerAction(page, 'notes-count')
      await page.getByTestId('sync-notes-panel').waitFor()
    },
  },
  {
    id: 'overlay-assistant',
    group: 'overlay',
    shot: 'viewport',
    open: async (page) => {
      await demo(page)
      await enableAssistant(page)
      await goTab(page, 'dash')
      await headerAction(page, 'assistant-toggle')
      await page.getByTestId('assistant-panel').waitFor()
    },
  },

  // ── popovers and menus ──────────────────────────────────────────────────────────────────
  {
    id: 'popover-txn-cat-menu',
    group: 'popover',
    shot: 'element',
    shotTarget: '[data-testid="cat-menu"]',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('recat-chip').first().click()
      await page.getByTestId('cat-menu').waitFor()
    },
  },
  {
    id: 'popover-txn-filter-status',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('filter-status').click()
    },
  },
  {
    id: 'popover-txn-filter-date',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('filter-date').click()
    },
  },
  {
    id: 'popover-txn-bulk-more',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('select-mode').click()
      await page.getByTestId('txn-check').first().click()
      await page.getByTestId('bulk-more').click()
    },
  },
  {
    id: 'popover-txn-bulk-tag',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('select-mode').click()
      await page.getByTestId('txn-check').first().click()
      await page.getByTestId('bulk-tag').click()
    },
  },
  {
    id: 'popover-import-cat-menu',
    group: 'popover',
    shot: 'element',
    shotTarget: '[data-testid="cat-menu"]',
    open: async (page) => {
      await toReview(page)
      await page.getByTestId('recat-chip').first().click()
      await page.getByTestId('cat-menu').waitFor()
    },
  },
  {
    id: 'popover-trip-picker',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('txn-row').first().click()
      await page.getByTestId('trip-picker-open').click()
    },
  },
  {
    id: 'popover-budget-menu',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('plan')(page)
      await page.getByTestId('budget-menu').first().click()
    },
  },
  {
    id: 'popover-cat-swatch',
    group: 'popover',
    shot: 'none',
    open: async (page) => {
      await tab('settings')(page)
      await page.getByTestId('cat-name-btn').first().click()
    },
  },

  // ── transients ──────────────────────────────────────────────────────────────────────────
  {
    id: 'transient-explain',
    group: 'transient',
    shot: 'element',
    shotTarget: '[data-testid="explain-panel"]',
    open: async (page) => {
      await tab('dash')(page)
      await page.getByTestId('explain-dash.spend').click()
      await page.getByTestId('explain-panel').waitFor()
    },
  },
  {
    id: 'transient-chart-tip',
    group: 'transient',
    shot: 'none',
    open: async (page) => {
      // The dashboard hero is a LineChart, whose overlay takes `onPointerDown` — so a tap raises
      // the crosshair. The trends bar chart only listens to `pointermove`, i.e. hover, which does
      // not exist on the device this project emulates.
      await tab('dash')(page)
      // `role="application"` is LineChart's own interaction rect — the element that carries
      // onPointerDown — rather than whichever <svg> happens to come first in the pane.
      const hit = page.locator('[data-pane="dash"] [role="application"]').first()
      await hit.waitFor()
      // Retry the tap: the crosshair only has something to snap to once the chart has measured
      // itself and laid out its points, and under a loaded worker the first press can land
      // before that. Three tries beats one long sleep.
      // Scoped to the visible pane: every LineChart renders its own `chart-tip`, and the eight
      // hidden panes each hold one too.
      const tip = page.locator('[data-pane="dash"] [data-testid="chart-tip"]').first()
      for (let i = 0; i < 3; i++) {
        const box = await hit.boundingBox()
        if (!box) throw new Error('chart has no box')
        await page.mouse.move(box.x + box.width * (0.5 + i * 0.1), box.y + box.height * 0.5)
        await page.mouse.down()
        await page.mouse.up()
        if (await tip.isVisible().catch(() => false)) return
        await page.waitForTimeout(400)
      }
      await tip.waitFor({ timeout: 5_000 })
    },
  },
  {
    id: 'transient-toast',
    group: 'transient',
    shot: 'none',
    open: async (page) => {
      await tab('txns')(page)
      await page.getByTestId('recat-chip').first().click()
      await page.locator('[data-cat="Transport"]').first().click()
      await page.getByTestId('toast').waitFor()
    },
  },

  // ── empty vault (cold start) ────────────────────────────────────────────────────────────
  {
    id: 'empty-dash',
    group: 'empty',
    shot: 'tall',
    open: async (page) => {
      await empty(page)
    },
  },
  {
    id: 'empty-txns',
    group: 'empty',
    shot: 'tall',
    open: async (page) => {
      await empty(page)
      await goTab(page, 'txns')
    },
  },
  {
    id: 'empty-trends',
    group: 'empty',
    shot: 'none',
    open: async (page) => {
      await empty(page)
      await goTab(page, 'trends')
    },
  },
]
