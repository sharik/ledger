import { expect, test, type Page } from '@playwright/test'
import { goTab, setupVault } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'

async function importF1(page: Page) {
  await setupVault(page, { demo: false })
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
  await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('txn-row').first()).toBeVisible()
}

test.describe('duplicate audit', () => {
  test('a clean vault reports no overlapping statements', async ({ page }) => {
    await importF1(page)
    await goTab(page, 'settings')
    await expect(page.getByTestId('duplicates-card')).toBeVisible()
    await expect(page.getByTestId('dup-total')).toHaveText('CLEAN')
    await expect(page.getByTestId('dup-empty')).toBeVisible()
    await expect(page.getByTestId('dup-finding')).toHaveCount(0)
  })

  test('the Transactions status filter offers Possible duplicates and finds none here', async ({ page }) => {
    await importF1(page)
    await goTab(page, 'txns')
    await page.getByTestId('filter-status').click()
    await page.getByText('Possible duplicates', { exact: true }).click()
    await expect(page.getByTestId('txn-empty')).toBeVisible()
    await expect(page.getByTestId('dup-badge')).toHaveCount(0)
  })
})

// The overlap note itself (a statement restating a period under different hashes) is covered by
// `tests/import/pipeline.test.ts` — it needs two files whose rows collide but whose identities do
// not, which no pair of checked-in fixtures produces. Re-importing the same bytes is a different
// path, already covered by `import.spec.ts` → 're-importing the same file short-circuits'.
