import { expect, test } from '@playwright/test'
import { appUrl, goTab, setupVault, unlock } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'
const PW = 'hunter22hunter22'

test.describe('first run', () => {
  test('fresh vault → first import populates transactions', async ({ page }) => {
    await page.goto(appUrl())
    // step ①: create the encrypted vault, empty
    await page.getByTestId('password').fill(PW)
    await page.getByTestId('password2').fill(PW)
    await page.getByTestId('start-empty').click()
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('app-shell')).toBeVisible()

    // step ③: drop the first statement
    await page.getByTestId('import-btn').click()
    await page.getByTestId('import-file').setInputFiles(F1)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('confirm-import').click()

    await goTab(page, 'txns')
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('1')
  })

  // Issue 2: an empty vault has nothing to compare against — say that, don't claim a match.
  test('empty vault dashboard does not claim a comparison it never made', async ({ page }) => {
    await page.goto(appUrl())
    await page.getByTestId('password').fill(PW)
    await page.getByTestId('password2').fill(PW)
    await page.getByTestId('start-empty').click()
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('app-shell')).toBeVisible()

    const empty = page.getByTestId('insights-empty')
    await expect(empty).toHaveAttribute('data-basis', 'empty')
    await expect(empty).toContainText('No transactions yet')
  })

  // Issue 1: best-effort storage is surfaced as a nudge, not left silent.
  test('non-persistent storage is surfaced in Settings → Sync', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { persist: async () => false, persisted: async () => false, estimate: async () => ({}) },
      })
    })
    await page.goto(appUrl())
    await page.getByTestId('password').fill(PW)
    await page.getByTestId('password2').fill(PW)
    await page.getByTestId('start-empty').click()
    await page.getByTestId('unlock-go').click()
    await goTab(page, 'settings')
    await expect(page.getByTestId('storage-durability')).toContainText('best-effort')
  })

  test('granted persistent storage says nothing', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { persist: async () => true, persisted: async () => true, estimate: async () => ({}) },
      })
    })
    await page.goto(appUrl())
    await page.getByTestId('password').fill(PW)
    await page.getByTestId('password2').fill(PW)
    await page.getByTestId('start-empty').click()
    await page.getByTestId('unlock-go').click()
    await goTab(page, 'settings')
    await expect(page.getByTestId('remote-label')).toBeVisible()
    await expect(page.getByTestId('storage-durability')).toHaveCount(0)
  })

  test('sample-data path still boots a populated shell', async ({ page }) => {
    await page.goto(appUrl())
    await page.getByTestId('password').fill(PW)
    await page.getByTestId('password2').fill(PW)
    await page.getByTestId('start-demo').click()
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await goTab(page, 'settings')
    // the demo seed has accounts and transactions
    await expect(page.getByTestId('account-count')).not.toHaveText('0')
  })
})

test.describe('guidance', () => {
  // The checklist ticks itself from the vault rather than being dismissed, so it can never
  // claim progress the data does not support — and it is the only entry point to Import,
  // which is not in the tab strip.
  test('an empty vault shows the checklist at 0 done, and it links to Import', async ({ page }) => {
    await setupVault(page, { demo: false })
    const card = page.getByTestId('start-here')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-done', '0')
    await page.getByTestId('start-step-import').click()
    await expect(page).toHaveURL(/#\/import/)
  })

  test('importing a statement ticks the first step without any user acknowledgement', async ({ page }) => {
    await setupVault(page, { demo: false })
    await page.goto(appUrl() + '#/import')
    await page.setInputFiles('input[type=file]', F1)
    await page.getByTestId('confirm-import').click()
    await page.locator('[data-tab="dash"]').click()
    await expect(page.getByTestId('start-step-import')).toHaveAttribute('data-done', '1')
  })

  test('a dismissed screen intro stays dismissed across a reload, and Settings restores it', async ({ page }) => {
    await setupVault(page)
    await expect(page.getByTestId('screen-intro-dash')).toBeVisible()
    await page.getByTestId('screen-intro-dismiss-dash').click()
    await expect(page.getByTestId('screen-intro-dash')).toHaveCount(0)

    await page.reload()
    await unlock(page)
    await expect(page.getByTestId('screen-intro-dash')).toHaveCount(0)

    await page.locator('[data-tab="settings"]').click()
    await page.getByTestId('help-reset').click()
    await page.locator('[data-tab="dash"]').click()
    await expect(page.getByTestId('screen-intro-dash')).toBeVisible()
  })

  test('the glossary is generated from the same registry the ? panels use', async ({ page }) => {
    await setupVault(page)
    await page.locator('[data-tab="settings"]').click()
    await page.getByTestId('glossary-dash.spend').click()
    await expect(page.getByTestId('help-card')).toContainText('Transfers between your own accounts')
  })

  // known_issues #2, applied to the headline row: an empty vault must not report that a plan
  // it never had is being met, nor quote a percentage against a month with no data.
  test('an empty vault states what is missing instead of reporting success', async ({ page }) => {
    await setupVault(page, { demo: false })

    await expect(page.getByTestId('dash-spend-nobasis')).toBeVisible()
    await expect(page.getByTestId('metric-spend')).not.toContainText('%')

    await expect(page.getByTestId('dash-savings-noincome')).toBeVisible()

    const plan = page.getByTestId('metric-plan')
    await expect(plan).toContainText('No budgets yet')
    await expect(plan).toContainText('No goals yet')
    await expect(plan).not.toContainText('on schedule')
  })
})
