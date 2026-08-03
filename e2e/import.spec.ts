import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { appUrl, goTab, setupVault } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'
const F2 = 'tests/fixtures/revolut/f2.xlsx'
const MIXED = 'tests/fixtures/revolut/multi-currency.csv'
const PRIVAT = 'tests/fixtures/privat/p2.csv'
const PUMB = 'tests/fixtures/pumb/p1.pdf'
const MONO = 'tests/fixtures/monobank/m1.csv'
const BNP_PDF = 'docs/examples/pariba/releve_ZZ1KNGXG64KMFYEIV_260709_153132.pdf'
const BNP_XLS = 'docs/examples/pariba/export_24_07_2026_22_07_45.xls'
const EXPECTATIONS = 'docs/examples/expectations.json'
// The masked tail this account prints is the holder's real account number. It lives beside the
// statements in gitignored `docs/examples/`, never in the repo.
const realExpect = (): { mask: string } | null =>
  fs.existsSync(EXPECTATIONS) ? JSON.parse(fs.readFileSync(EXPECTATIONS, 'utf8')) : null
const haveBnp = fs.existsSync(BNP_PDF) && fs.existsSync(BNP_XLS) && realExpect() !== null

async function openImport(page: import('@playwright/test').Page) {
  await page.getByTestId('import-btn').click()
  await expect(page.getByTestId('dropzone')).toBeVisible()
}

async function drop(page: import('@playwright/test').Page, file: string) {
  await page.getByTestId('import-file').setInputFiles(file)
  await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
}

test.describe('import UX', () => {
  test('drop f1 → map → create → review → confirm → IMPORTED rows', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    // mapping card suggests a Revolut EUR account on first import
    await expect(page.getByTestId('maps-to')).toHaveText('Revolut EUR')
    // review counts: 330 to add, 0 duplicates
    await expect(page.getByTestId('review-counts')).toContainText('330 to add')
    await expect(page.getByTestId('dup-count')).toHaveText('0 duplicates skipped')

    await page.getByTestId('confirm-import').click()
    // lands on transactions, rows present with IMPORTED badges
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
    await expect(page.getByTestId('imported-badge').first()).toBeVisible()
  })

  test('undo right after import empties the vault', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
    // undo via the toast
    await page.getByTestId('toast-undo').click()
    await goTab(page, 'txns')
    await expect(page.getByTestId('txn-row')).toHaveCount(0)
    // account gone → settings account-count 0
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('0')
  })

  test('re-importing the same file short-circuits, then skips everything', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    // drop f1 again → already-imported refusal
    await openImport(page)
    await page.getByTestId('import-file').setInputFiles(F1)
    await expect(page.getByTestId('refusal')).toHaveAttribute('data-kind', 'already-imported')
    await page.getByTestId('reimport').click()
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('review-counts')).toContainText('0 to add')
    await expect(page.getByTestId('dup-count')).toContainText('330')
  })

  test('f2 after f1 shows duplicates skipped and imports the extras', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    await openImport(page)
    await drop(page, F2)
    // overlap deduped (88), extras added (107)
    await expect(page.getByTestId('dup-count')).toContainText('88')
    await expect(page.getByTestId('review-counts')).toContainText('107 to add')
    await page.getByTestId('confirm-import').click()
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
  })

  // Skipped rows are auditable: expand the count, open a row, and see the incoming row next to
  // the transaction already in the vault it matched.
  test('duplicates skipped can be inspected against the existing transaction', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    await openImport(page)
    await drop(page, F2)
    await expect(page.getByTestId('dup-count')).toContainText('88')

    // the panel is collapsed until the count is clicked
    await expect(page.getByTestId('dup-panel')).toHaveCount(0)
    await page.getByTestId('dup-count').click()
    await expect(page.getByTestId('dup-panel')).toBeVisible()

    // open a skipped row → both the incoming row and the existing vault transaction are shown
    await page.getByTestId('dup-row').first().click()
    const detail = page.getByTestId('dup-detail').first()
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('INCOMING')
    await expect(detail).toContainText('ALREADY IN YOUR VAULT')
  })

  // A BNP .xls matches an existing account only by last-4 (a signal, not proof), so a later import
  // must ASK before binding and stay blocked until confirmed. Gated on the real file; the
  // confirm→dedup mechanics are covered by unit tests (this asserts the guardrail in the UI).
  ;(haveBnp ? test : test.skip)('BNP xls asks to confirm the account on a last-4 match (signal, not proof)', async ({ page }) => {
    test.setTimeout(60_000)
    await setupVault(page, { demo: false })
    // First import creates the BNP account.
    await openImport(page)
    await page.getByTestId('import-file').setInputFiles(BNP_XLS)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    // A second file with the same last-4 must be confirmed, not silently bound.
    await openImport(page)
    await page.getByTestId('import-file').setInputFiles(BNP_XLS)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('confirm-account')).toBeVisible()
    await expect(page.getByTestId('confirm-account')).toContainText(`····${realExpect()!.mask}`)
    await expect(page.getByTestId('confirm-import')).toBeDisabled()
  })

  test('recategorize a row → Always → the learned rule appears in Settings', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    // open the first row's category menu and pick a category
    await page.getByTestId('recat-chip').first().click()
    await expect(page.getByTestId('cat-menu').first()).toBeVisible()
    await page.locator('[data-cat="Shopping"]').first().click()
    // Always offer appears → accept
    await expect(page.getByTestId('always-offer')).toBeVisible()
    await page.getByTestId('always-yes').click()
    await page.getByTestId('confirm-import').click()

    // the learned rule is now visible in Settings → rules
    await goTab(page, 'settings')
    await expect(page.getByTestId('rules-card')).toBeVisible()
    await expect(page.getByTestId('rule-row').first()).toBeVisible()
  })
  // Phase E: rows falling inside a trip window show live trip chips in review.
  test('review rows inside a trip window offer live trip chips', async ({ page }) => {
    await setupVault(page) // demo seed → includes the "Poland · Jun 2026" trip (10–18 Jun)
    await openImport(page)
    await drop(page, F1) // F1 spans Feb–11 Jun 2026, overlapping the trip window
    await expect(page.getByTestId('review-trip-chip').first()).toBeVisible()
    // In-window rows are members by default; one tap excludes, another re-includes.
    const chip = page.getByTestId('review-trip-chip').first()
    await expect(chip).toHaveAttribute('data-on', '1')
    await chip.click()
    await expect(chip).toHaveAttribute('data-on', '0')
    await chip.click()
    await expect(chip).toHaveAttribute('data-on', '1')
  })

  // Issue 4a: a rule minted by "Always" re-reads the rows still on screen.
  test('Always recategorizes the identical rows in the same batch', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    const repeatRows = page.locator('[data-testid="review-row"][data-merchant="Bize"]')
    await expect(repeatRows.first()).toBeVisible()
    const total = await repeatRows.count()
    expect(total).toBeGreaterThan(1)

    await repeatRows.first().getByTestId('recat-chip').click()
    await page.locator('[data-cat="Transport"]').first().click()
    await page.getByTestId('always-yes').click()

    // every Bize row now carries the category, and the counts reflect it
    await expect(repeatRows.first().getByTestId('recat-chip')).toContainText('Transport')
    await expect(repeatRows.last().getByTestId('recat-chip')).toContainText('Transport')
    await expect(page.getByTestId('review-counts')).toContainText('to add')
  })

  // Issue 4b: the same rule also speaks for rows already committed.
  test('Always offers to backfill matching transactions already in the vault', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    // second file repeats a merchant F1 already committed → Always has something to backfill
    await openImport(page)
    await drop(page, F2)
    const row = page.locator('[data-testid="review-row"][data-merchant="MEGED Pidibivubi"]').first()
    await row.getByTestId('recat-chip').click()
    await page.locator('[data-cat="Transport"]').first().click()
    await page.getByTestId('always-yes').click()

    await expect(page.getByTestId('backfill-offer')).toBeVisible()
    await expect(page.getByTestId('backfill-count')).toHaveText('12') // the F1 rows, still Other
    await page.getByTestId('backfill-apply').click()
    await expect(page.getByTestId('toast')).toContainText('12 existing transactions moved to Transport')
    await expect(page.getByTestId('backfill-offer')).toHaveCount(0)
  })

  // Issue 5: the picker can mint a category instead of bottoming out.
  test('review picker creates a new category inline', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    const row = page.getByTestId('review-row').first()
    await row.getByTestId('recat-chip').click()
    await page.getByTestId('cat-menu-new').first().click()
    await page.getByTestId('cat-menu-new-name').first().fill('Pets')
    await page.getByTestId('cat-menu-new-name').first().press('Enter')
    await expect(row.getByTestId('recat-chip')).toContainText('Pets')

    await page.getByTestId('import-cancel').click()
    await goTab(page, 'settings')
    await expect(page.locator('[data-testid="cat-row"][data-cat-name="Pets"]')).toBeVisible()
  })

  // Issue 8: a multi-currency export is two accounts, reviewed one after the other.
  test('multi-currency export reviews each account in turn', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, MIXED)

    await expect(page.getByTestId('group-progress')).toHaveText('Current · EUR · account 1 of 2')
    await expect(page.getByTestId('maps-to')).toHaveText('Revolut EUR')
    await expect(page.getByTestId('review-counts')).toContainText('2 to add')
    await page.getByTestId('confirm-import').click()

    // still on the import screen — the USD ledger of the same file is next
    await expect(page.getByTestId('group-progress')).toHaveText('Current · USD · account 2 of 2')
    await expect(page.getByTestId('maps-to')).toHaveText('Revolut USD')
    await expect(page.getByTestId('review-counts')).toContainText('2 to add')
    await page.getByTestId('confirm-import').click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-row')).toHaveCount(4)
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('2')
  })

  // A PrivatBank export is TAB-delimited despite its `.csv` name and carries one ledger per CARD,
  // so it exercises the same one-account-at-a-time review — and it is the only format that states
  // its own category per row, which must arrive applied rather than as another row to triage.
  test('privat export reviews each card in turn and pre-fills the bank category', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, PRIVAT)

    await expect(page.getByTestId('group-progress')).toHaveText('····9489 · UAH · account 1 of 2')
    await expect(page.getByTestId('maps-to')).toHaveText('Privat UAH ····9489')
    await expect(page.getByTestId('review-counts')).toContainText('11 to add')
    // 8 of the 11 carry a Privat category that maps onto a category the vault has
    await expect(page.getByText('from bank')).toHaveCount(8)
    await expect(page.getByTestId('review-counts')).toContainText('3 need review')
    await page.getByTestId('confirm-import').click()

    // the second card of the same file is next, with its own name and its own rows
    await expect(page.getByTestId('group-progress')).toHaveText('····1705 · UAH · account 2 of 2')
    await expect(page.getByTestId('maps-to')).toHaveText('Privat UAH ····1705')
    await expect(page.getByTestId('review-counts')).toContainText('3 to add')
    await page.getByTestId('confirm-import').click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-row')).toHaveCount(14)
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('2')
  })

  // The one PDF that reaches CI, and the fourth bank — so it is also what proves the facts line
  // reads the registry rather than the two-bank ternary it used to be, which would have labelled
  // this "Revolut". One IBAN, two cards, one ledger: a single account, unlike the Privat export.
  test('pumb pdf imports as one IBAN-keyed account and names its own bank', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, PUMB)

    await expect(page.getByText('PUMB · UAH')).toBeVisible()
    await expect(page.getByTestId('maps-to')).toHaveText('PUMB Кюфякобеш')
    await expect(page.getByTestId('group-progress')).toHaveCount(0) // one account, not one per card
    await expect(page.getByTestId('review-counts')).toContainText('11 to add')
    await page.getByTestId('confirm-import').click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-row')).toHaveCount(11)
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('1')
  })

  // The fifth bank, and the only format that states NO account key at all — so it is what proves
  // the mustName gate in the real UI: the import cannot proceed until the user names the account,
  // and no ghost is minted meanwhile. Its categories come from MCC, not a text label.
  test('monobank export blocks on naming the account, then imports with MCC categories', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, MONO)

    await expect(page.getByText('Monobank · UAH')).toBeVisible()
    // No fingerprint, no last-4, no holder: the mapping menu is forced open and blocks the import.
    await expect(page.getByTestId('must-name')).toBeVisible()
    await expect(page.getByTestId('mapping-menu')).toBeVisible()
    await expect(page.getByTestId('new-account-name')).toHaveValue('Monobank UAH')
    await page.getByTestId('create-account').click()

    await expect(page.getByTestId('review-counts')).toContainText('23 to add')
    // 10 of the 23 carry an MCC that maps onto a category the vault has; the 13 transfers do not.
    await expect(page.getByText('from bank')).toHaveCount(10)
    await page.getByTestId('confirm-import').click()

    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await expect(page.getByTestId('txn-row')).toHaveCount(23)
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('1')
  })

  // Issue 6: trips are creatable from the same screen that assigns them.
  test('review row creates a trip inline and tags itself', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    const row = page.getByTestId('review-row').first()
    await row.getByTestId('trip-picker-open').click()
    await row.getByTestId('trip-picker-new').click()
    await row.getByTestId('trip-picker-new-name').fill('Roadtrip')
    await row.getByTestId('trip-picker-new-name').press('Enter')
    const chip = row.getByTestId('review-trip-chip').first()
    await expect(chip).toHaveText(/Roadtrip/)
    await expect(chip).toHaveAttribute('data-on', '1')
  })

  // A trip created on one row is then pickable on another — no retyping the name (the reported gap).
  test('a trip created on one row is selectable on the next', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    const pickers = page.getByTestId('trip-picker-open')
    // create "Iceland" from the first row's picker
    await pickers.first().click()
    await page.getByTestId('trip-picker-new').click()
    await page.getByTestId('trip-picker-new-name').fill('Iceland')
    await page.getByTestId('trip-picker-new-name').press('Enter')
    // a different row's picker now offers that same trip — select it, no retyping
    // a different row's picker now offers that same trip — no retyping (the reported gap)
    await pickers.nth(1).click()
    const item = page.getByTestId('trip-picker-item').filter({ hasText: 'Iceland' })
    await expect(item).toBeVisible()
    const before = await item.getAttribute('data-on')
    await item.click()
    await expect(item).not.toHaveAttribute('data-on', before ?? '0') // selecting it toggles membership
  })

  // Trip detection: the Iceland trip in the BNP export is spotted from its foreign-currency rows.
  ;(haveBnp ? test : test.skip)('detects the Iceland trip on import and creates it', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, BNP_XLS)
    const strip = page.getByTestId('trip-suggest')
    await expect(strip).toBeVisible()
    await expect(strip.getByTestId('trip-suggest-name')).toHaveValue('Iceland')
    // the name is editable — override it before marking
    await strip.getByTestId('trip-suggest-name').fill('Iceland road trip')
    await strip.getByTestId('trip-mark').click()
    // detected ISK rows are marked (on); other in-window spend is left off — not swept in
    await expect(page.locator('[data-testid="review-trip-chip"][data-on="1"]').first()).toBeVisible()
    await page.getByTestId('confirm-import').click()
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    // the trip exists on the Trips page, and marks foreign (ISK) spend
    await goTab(page, 'trips')
    const card = page.getByTestId('trip-card').filter({ hasText: 'Iceland road trip' })
    await expect(card).toBeVisible()
    // only the 13 detected rows are members — the rest of the window was NOT swept in
    await expect(card).toContainText('13 rows')
  })

  // Issue 10b: the review picker offers Transfers, and "Always" makes the call stick
  // for every later statement — the general answer for FX legs and any other internal move.
  test('review picker marks a row as a transfer and learns it', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)
    const repeatRows = page.locator('[data-testid="review-row"][data-merchant="Bize"]')
    await repeatRows.first().getByTestId('recat-chip').click()
    await page.getByTestId('cat-menu-transfer').first().click()
    await expect(repeatRows.first().getByTestId('recat-chip')).toContainText('Transfers')
    await page.getByTestId('always-yes').click()
    // the learned rule speaks for the rest of the batch too
    await expect(repeatRows.last().getByTestId('recat-chip')).toContainText('Transfers')

    await page.getByTestId('confirm-import').click()
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Transfers"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('of 36')
  })

  // The picker used to open downward into a section with `overflow: hidden`, so on the last row
  // most of the categories were clipped away with nowhere left to scroll.
  test('the category picker on the last row opens fully inside the viewport', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    const last = page.getByTestId('review-row').last()
    await last.scrollIntoViewIfNeeded()
    await last.getByTestId('recat-chip').click()

    const menu = page.getByTestId('cat-menu')
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)

    // …and every option is reachable, not merely rendered somewhere off-screen.
    await menu.locator('button', { hasText: 'Housing' }).click()
    await expect(last.getByTestId('recat-chip')).toContainText('Housing')
  })

  // A review row offers external "Search / Maps" lookups so an unfamiliar merchant
  // can be checked before categorizing. Plain links — the app never fetches.
  test('review rows offer Search / Maps lookup links', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    const row = page.getByTestId('review-row').first()
    const web = row.getByTestId('lookup-web')
    const maps = row.getByTestId('lookup-maps')
    await expect(web).toBeVisible()
    await expect(web).toHaveAttribute('href', /^https:\/\/www\.google\.com\/search\?q=.+/)
    await expect(web).toHaveAttribute('target', '_blank')
    await expect(maps).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/search\/.*query=.+/)
  })
})

// Plan B: the review list gains search / filter / sort — all display-only, so the import itself
// (what commits, and the counts describing it) is never affected.
test.describe('import review list controls', () => {
  test('search narrows the shown rows but not the import', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    await expect(page.getByTestId('review-showing')).toContainText('showing 330 of 330')
    const merchant = (await page.getByTestId('review-row').first().getAttribute('data-merchant'))!
    await page.getByTestId('review-search').fill(merchant)

    // fewer rows shown, but the plan is untouched: the denominator and "to add" both stay 330
    await expect(page.getByTestId('review-showing')).not.toContainText('showing 330 of 330')
    await expect(page.getByTestId('review-showing')).toContainText('of 330')
    await expect(page.getByTestId('review-counts')).toContainText('330 to add')
  })

  test('the header sorts by amount and date, and a third click restores source order', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    const source = await page.getByTestId('review-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-merchant')))
    const money = () => page.getByTestId('review-row').evaluateAll((els) => els.map((e) => Number((e.querySelector('[data-testid="review-amount"]')?.textContent ?? '').replace(/[−–—]/g, '-').replace(/[^0-9.-]/g, ''))))

    await page.getByTestId('review-sort-amount').click() // descending
    const desc = await money()
    for (let i = 1; i < desc.length; i++) expect(desc[i]).toBeLessThanOrEqual(desc[i - 1]!)

    await page.getByTestId('review-sort-amount').click() // ascending
    const asc = await money()
    for (let i = 1; i < asc.length; i++) expect(asc[i]).toBeGreaterThanOrEqual(asc[i - 1]!)

    await page.getByTestId('review-sort-amount').click() // back to statement order
    const back = await page.getByTestId('review-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-merchant')))
    expect(back).toEqual(source)
  })

  test('a provenance filter narrows the list while the import stays whole', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    const confirmLabel = await page.getByTestId('confirm-import').textContent()
    // a fresh empty vault matched no rules, so "By rule" empties the on-screen list…
    await page.getByTestId('review-filter').click()
    await page.locator('[data-menu-item="By rule"]').click()
    await expect(page.getByTestId('review-empty')).toBeVisible()
    await expect(page.getByTestId('review-showing')).toContainText('showing 0 of 330')
    // …but the import is unchanged: counts and the confirm button still describe all 330 rows
    await expect(page.getByTestId('review-counts')).toContainText('330 to add')
    expect(await page.getByTestId('confirm-import').textContent()).toBe(confirmLabel)
  })

  test('confirm imports the full plan even with a filter hiding almost everything', async ({ page }) => {
    await setupVault(page, { demo: false })
    await openImport(page)
    await drop(page, F1)

    await page.getByTestId('review-search').fill('zzz-nothing-matches')
    await expect(page.getByTestId('review-empty')).toBeVisible()
    await expect(page.getByTestId('confirm-import')).toContainText('330') // still adds all of them

    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
    await expect(page.getByTestId('txn-showing')).toContainText('of 330') // the whole file landed
  })
})

test('appUrl helper stays valid', () => {
  expect(appUrl()).toContain('kdf=test')
})
