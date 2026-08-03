import { expect, test, type Page } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'

async function importF1(page: Page) {
  await setupVault(page, { demo: false })
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
  await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('txn-row').first()).toBeVisible()
}

test.describe('transactions', () => {
  test('search narrows the list', async ({ page }) => {
    await importF1(page)
    const before = await page.getByTestId('txn-row').count()
    await page.getByTestId('txn-search').fill('Bize')
    // Search input is debounced (150 ms) — wait for the narrowed list.
    await expect.poll(() => page.getByTestId('txn-row').count()).toBeLessThan(before)
    // every visible row matches the query
    for (const row of await page.getByTestId('txn-row').all()) {
      expect((await row.getAttribute('data-merchant'))?.toLowerCase()).toContain('bize')
    }
  })

  // Issue 11a: every other screen in the app is period-scoped; this one had no date filter at
  // all, so "what did I spend in May" meant scrolling 330 rows sorted newest-first.
  test('the date filter narrows to a range and clears back', async ({ page }) => {
    await importF1(page)
    // f1 spans 5 Feb – 11 Jun 2026: 67 rows in May, 21 in June.
    await expect(page.getByTestId('txn-showing')).toContainText('of 330')

    await page.getByTestId('filter-date').click()
    await page.getByTestId('date-from').fill('2026-05-01')
    await page.getByTestId('date-to').fill('2026-06-30')
    await expect(page.getByTestId('txn-showing')).toContainText('showing 88 of 88')
    // the chip reports the range it is holding, so a narrowed list is never a mystery
    await expect(page.getByTestId('filter-date')).toContainText('1 May → 30 Jun')

    // an open end is allowed: everything from June onwards
    await page.getByTestId('date-from').fill('2026-06-01')
    await page.getByTestId('date-to').fill('')
    await expect(page.getByTestId('txn-showing')).toContainText('showing 21 of 21')

    await page.getByTestId('date-clear').click()
    await expect(page.getByTestId('txn-showing')).toContainText('of 330')
    await expect(page.getByTestId('filter-date')).toContainText('Date')
  })

  test('status filter — Imported shows the freshly imported rows', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Imported"]').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
  })

  // Plan B: the column header sorts the list; the default stays newest-first until clicked.
  test('the amount header sorts descending then ascending', async ({ page }) => {
    await importF1(page)
    const money = () => page.getByTestId('txn-row').evaluateAll((els) => els.map((e) => Number((e.querySelector('[data-testid="txn-amount"]')?.textContent ?? '').replace(/[−–—]/g, '-').replace(/[^0-9.-]/g, ''))))

    await page.getByTestId('sort-amount').click() // descending
    const desc = await money()
    for (let i = 1; i < desc.length; i++) expect(desc[i]).toBeLessThanOrEqual(desc[i - 1]!)

    await page.getByTestId('sort-amount').click() // ascending
    const asc = await money()
    for (let i = 1; i < asc.length; i++) expect(asc[i]).toBeGreaterThanOrEqual(asc[i - 1]!)
  })

  test('the date header toggles newest- and oldest-first', async ({ page }) => {
    await importF1(page)
    const firstMerchant = () => page.getByTestId('txn-row').first().getAttribute('data-merchant')
    const newestFirst = await firstMerchant() // default is date-descending

    await page.getByTestId('sort-date').click() // → oldest first
    await expect.poll(firstMerchant).not.toBe(newestFirst)

    await page.getByTestId('sort-date').click() // → back to newest first
    await expect.poll(firstMerchant).toBe(newestFirst)
  })

  test('the By-rule status filter selects only rule-placed rows', async ({ page }) => {
    await importF1(page)
    // a fresh empty vault placed nothing by a rule, so By rule is empty…
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="By rule"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('of 0')
    // …and All brings the whole import back — every provenance is accounted for.
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="All"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('of 330')
  })

  test('bulk recategorize + undo', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('select-mode').click()
    const checks = page.getByTestId('txn-check')
    await checks.nth(0).check()
    await checks.nth(1).check()
    await expect(page.getByTestId('bulk-bar')).toBeVisible()
    await page.locator('[data-bulk-cat="Shopping"]').click()
    await expect(page.getByTestId('toast')).toContainText('recategorized')
    await page.getByTestId('toast-undo').click()
    // undone: no toast error, rows still present
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
  })

  test('detail panel opens and closes', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-row').first().click()
    await expect(page.getByTestId('txn-detail')).toBeVisible()
    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('txn-detail')).toHaveCount(0)
  })

  // The detail panel offers external "Search / Maps" lookups for the merchant.
  // Plain links the user clicks — the app itself never fetches.
  test('the detail panel offers Search / Maps lookup links', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-row').first().click()
    const detail = page.getByTestId('txn-detail')
    await expect(detail.getByTestId('lookup-web')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/search\?q=.+/)
    await expect(detail.getByTestId('lookup-web')).toHaveAttribute('target', '_blank')
    await expect(detail.getByTestId('lookup-maps')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/search\/.*query=.+/)
  })

  // Plan C.2 asked the panel for the "full raw"; only the ellipsed row subline ever had it,
  // so the bank's own string was unreadable wherever it was long.
  test('the detail panel shows the bank descriptor verbatim, not the cleaned merchant', async ({ page }) => {
    await importF1(page)
    const row = page.getByTestId('txn-row').first()
    const merchant = await row.getAttribute('data-merchant')
    await row.click()
    const raw = page.getByTestId('detail-raw')
    await expect(raw).toBeVisible()
    // whatever the adapter cleaned away, the descriptor still contains the name it produced
    expect((await raw.innerText()).toUpperCase()).toContain(merchant!.toUpperCase())
    // and it is not clipped — the panel wraps it instead of ellipsing
    await expect(raw).toHaveCSS('text-overflow', 'clip')
  })

  test('ciphertext probe: imported merchants never hit disk in plaintext', async ({ page }) => {
    await importF1(page)
    await page.waitForTimeout(1200)
    const probe = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => {
        const rq = indexedDB.open('ledger', 1)
        rq.onsuccess = () => res(rq.result)
      })
      const blob = await new Promise<ArrayBuffer>((res) => {
        const rq = db.transaction('kv').objectStore('kv').get('vault.blob')
        rq.onsuccess = () => res(rq.result as ArrayBuffer)
      })
      const bytes = new Uint8Array(blob)
      const text = new TextDecoder('latin1').decode(bytes)
      return { magic: String.fromCharCode(...bytes.slice(0, 4)), leaks: text.includes('VEB GISI') || text.includes('RipavAjudo') }
    })
    expect(probe.magic).toBe('LGR1')
    expect(probe.leaks).toBe(false)
  })

  test('empty state with no matches offers clear-filters', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('zzz-nothing-matches-zzz')
    await expect(page.getByTestId('txn-empty')).toBeVisible()
    await goTab(page, 'txns')
  })

  test('select-all covers the whole filtered set, not just the page', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('Bize')
    await expect(page.getByTestId('txn-showing')).toContainText('showing 36 of 36')
    await page.getByTestId('select-mode').click()
    await page.getByTestId('select-all').check()
    await expect(page.getByTestId('bulk-count')).toHaveText('36 selected · all matching')
    await page.locator('[data-bulk-cat="Transport"]').click()
    await expect(page.getByTestId('toast')).toContainText('36 transactions recategorized')
    // every Bize row now reads Transport
    await page.getByTestId('filter-cat').click()
    await page.locator('[data-menu-item="Transport"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('of 36')
  })

  // Issue 10b / §9.4: any row the pairing pass could not prove internal is still the
  // user's to call — forward direction, not just "Unlink pair".
  test('a row is marked a transfer by hand, then taken back', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('mark-transfer').click()
    await expect(page.getByTestId('toast')).toContainText('marked as a transfer')
    // the panel now reports the manual mark and offers the way back
    await expect(page.getByTestId('unmark-transfer')).toBeVisible()
    await page.getByTestId('detail-close').click()

    // out of cash-flow: the Transfers status filter finds exactly this row
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Transfers"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('showing 1 of 1')

    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('unmark-transfer').click()
    await expect(page.getByTestId('toast')).toContainText('back in cash-flow')
    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('txn-showing')).toContainText('showing 0 of 0')
  })

  test('bulk-marks a whole filtered set as transfers', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('Bize')
    await page.getByTestId('select-mode').click()
    await page.getByTestId('select-all').check()
    await page.getByTestId('bulk-transfer').click()
    await expect(page.getByTestId('toast')).toContainText('36 transactions marked as transfers')
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Transfers"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('showing 36 of 36')
  })

  test('bulk tag assigns a trip to the selection and undoes', async ({ page }) => {
    await setupVault(page) // demo seed → has trips
    await goTab(page, 'txns')
    await page.getByTestId('select-mode').click()
    const checks = page.getByTestId('txn-check')
    await checks.nth(0).check()
    await checks.nth(1).check()
    await page.getByTestId('bulk-tag').click()
    await page.locator('[data-bulk-tag]').first().click()
    await expect(page.getByTestId('toast')).toContainText('2 transactions tagged to')
    await page.getByTestId('toast-undo').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
  })

  // Issue 11b: recategorizing one row cost three steps (Select → tick → bulk bar), and
  // the detail panel could not do it at all. Plan C.2 asked for the review-screen picker.
  test('the row chip recategorizes, then teaches the rule and backfills the rest', async ({ page }) => {
    await importF1(page)
    const repeatMerchant = page.locator('[data-testid="txn-row"][data-merchant="MEGED Pidibivubi"]')
    await repeatMerchant.first().getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Transport"]').click()
    await expect(page.getByTestId('toast')).toContainText('MEGED Pidibivubi → Transport')

    // §10.3 on this screen: the pick offers to become a rule, keyed on the robust field —
    // and states its full consequence up front, so accepting is one click, not two.
    const offer = page.getByTestId('always-offer')
    await expect(offer).toContainText('matches merchant “MEGED PIDIBIVUBI”')
    await expect(offer).toContainText('already imported')
    const offered = Number(await page.getByTestId('backfill-count').innerText())
    expect(offered).toBeGreaterThan(0)
    await page.getByTestId('always-yes').click()
    await expect(page.getByTestId('toast')).toContainText(`${offered} transactions updated`)
    await expect(offer).toHaveCount(0)

    // every MEGED row now reads Transport — the one picked plus the ones swept up
    await page.getByTestId('txn-search').fill('MEGED')
    await expect(repeatMerchant).toHaveCount(offered + 1) // retries past the search debounce
    const rows = await repeatMerchant.all()
    for (const r of rows) await expect(r).toContainText('Transport')

    // the learned rule is a first-class rule, visible and editable in Settings
    await goTab(page, 'settings')
    const rule = page.locator('[data-testid="rule-row"][data-rule-value="MEGED PIDIBIVUBI"]')
    await expect(rule).toContainText('learned') // uppercased in CSS, not in the DOM
    await expect(rule).toContainText('Transport')
  })

  // #19: filing an OUTFLOW as Income is the user's call and stands. What must not follow is a
  // rule generalizing it — that is how a large transfer out taught "money to this person is
  // income" and re-asserted it on every later import.
  test('an outflow filed as Income keeps the pick but is never taught as a rule', async ({ page }) => {
    await importF1(page)
    // A negative row: the list is spend-heavy, and the amount cell carries the sign.
    const row = page.locator('[data-testid="txn-row"]').filter({ has: page.locator('[data-testid="txn-amount"]') }).first()
    await row.getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Income"]').click()

    await expect(page.getByTestId('toast')).toContainText('Income')
    const warn = page.getByTestId('polarity-warning')
    await expect(warn).toContainText('Income is money in')
    await expect(page.getByTestId('always-offer')).toHaveCount(0) // no rule offered, none minted

    // The alternative is named, not implied: an untracked internal move is a transfer (§9.4).
    await page.getByTestId('polarity-transfers').click()
    await expect(page.getByTestId('toast')).toContainText('marked as a transfer')
    await expect(warn).toHaveCount(0)

    // Nothing was learned from any of it.
    await goTab(page, 'settings')
    await expect(page.getByTestId('rule-row')).toHaveCount(0)
  })

  // Accepting *Always* is one gesture, so it has to be one undo — the two-prompt version
  // left UNDO able to reverse only whichever half committed last.
  test('undo after Always reverses both the rule and the rows it settled', async ({ page }) => {
    await importF1(page)
    const repeatMerchant = page.locator('[data-testid="txn-row"][data-merchant="MEGED Pidibivubi"]')
    await repeatMerchant.first().getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Transport"]').click()
    await page.getByTestId('always-yes').click()
    await expect(page.getByTestId('toast')).toContainText('transactions updated')

    await page.getByTestId('toast-undo').click()
    await page.getByTestId('txn-search').fill('MEGED')

    // Everything the *Always* gesture touched is back. The row picked first is not — that
    // was its own earlier gesture, with its own undo at the time.
    const rows = await repeatMerchant.all()
    const transport = []
    for (const r of rows) if ((await r.innerText()).includes('Transport')) transport.push(r)
    expect(transport).toHaveLength(1)

    // …and so is the rule, rather than surviving as an invisible leftover
    await goTab(page, 'settings')
    await expect(page.locator('[data-testid="rule-row"][data-rule-value="MEGED PIDIBIVUBI"]')).toHaveCount(0)
  })

  // Applying a bulk category spends the selection, so Select mode ends with it — "Done"
  // existed only to undo pressing "Select".
  test('a bulk action ends Select mode instead of leaving it on', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('Bize')
    await page.getByTestId('select-mode').click()
    await page.getByTestId('select-all').check()
    await page.locator('[data-bulk-cat="Transport"]').click()
    await expect(page.getByTestId('toast')).toContainText('recategorized')
    await expect(page.getByTestId('select-mode')).toHaveText('Select')
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0)
    await expect(page.getByTestId('txn-check')).toHaveCount(0)
  })

  test('the category picker on the last row opens fully inside the viewport', async ({ page }) => {
    await importF1(page)
    // The list section used to carry `overflow: hidden`, which clipped any popover
    // escaping the last row — and downward-only opening put it there every time.
    const last = page.getByTestId('txn-row').last()
    await last.getByTestId('recat-chip').click()
    const menu = last.getByTestId('cat-menu')
    await expect(menu).toBeVisible()
    // On a phone this is a bottom sheet that slides up from off-screen; measure it settled.
    await page.waitForTimeout(300)
    const box = (await menu.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    // and it is actually usable, not merely on screen
    await menu.locator('[data-cat="Shopping"]').click()
    await expect(page.getByTestId('toast')).toContainText('→ Shopping')
  })

  test('the detail panel changes the category, closing so the offer is reachable', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('detail-recat').click()
    await page.locator('[data-testid="txn-detail"] [data-cat="Groceries"]').click()
    // The panel sits on a dimming overlay; leaving it open would bury the Always strip.
    await expect(page.getByTestId('txn-detail')).toHaveCount(0)
    await expect(page.getByTestId('toast')).toContainText('→ Groceries')
    await expect(page.getByTestId('always-offer')).toBeVisible()
  })

  // Issue 11e: "show me the others like this one" had no answer outside the import screen.
  test('the similar link lands on a list the offered count agrees with', async ({ page }) => {
    await importF1(page)
    await page.locator('[data-testid="txn-row"][data-merchant="Ritekapis"]').first().click()
    const label = await page.getByTestId('detail-similar').innerText()
    const others = Number(label.match(/^(\d+)/)![1])
    await page.getByTestId('detail-similar').click()
    await expect(page.getByTestId('txn-detail')).toHaveCount(0)
    // the row itself plus the others it offered — the same predicate the search box runs
    await expect(page.getByTestId('txn-showing')).toContainText(`showing ${others + 1} of ${others + 1}`)
  })

  // Issue 11d: IMPORT §11 says the badge is "cleared at next unlock"; nothing ever cleared it,
  // so `Imported` drifted into meaning "everything I ever imported on this device".
  test('the IMPORTED badge does not survive a lock and unlock', async ({ page }) => {
    await importF1(page)
    await expect(page.getByTestId('imported-badge').first()).toBeVisible()

    await goTab(page, 'settings')
    await page.getByTestId('lock-now').click()
    await unlock(page)
    await goTab(page, 'txns')
    await expect(page.getByTestId('txn-row').first()).toBeVisible()
    await expect(page.getByTestId('imported-badge')).toHaveCount(0)

    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Imported"]').click()
    await expect(page.getByTestId('txn-showing')).toContainText('showing 0 of 0')
  })

  // Issue 11c: the list spans every year at once, newest first, with no year separators.
  test('the date column carries the year only when it is not the current one', async ({ page }) => {
    await importF1(page) // f1 is dated 2026, and the fixed clock is 2026 too
    await expect(page.getByTestId('txn-date').first()).toHaveText(/^\d{1,2} \w{3}$/)

    // Same rows, seen from 2027: the year is no longer implied and has to be stated.
    // Lock first — a bare reload can outrun the autosave debounce and lose the import.
    await goTab(page, 'settings')
    await page.getByTestId('lock-now').click()
    await page.goto('/?now=2027-03-01T10:00:00Z&kdf=test')
    await unlock(page)
    await goTab(page, 'txns')
    await expect(page.getByTestId('txn-date').first()).toHaveText(/^\d{1,2} \w{3} 26$/)
  })

  // Issue 11e: a grouped-by-merchant view that shows the recurring-merchant structure of
  // the vault — and lets you drop into the flat list for one merchant.
  test('Group collapses the list by merchant and a group drops into its rows', async ({ page }) => {
    await importF1(page)
    const flatRows = await page.getByTestId('txn-row').count()

    await page.getByTestId('group-toggle').click()
    const groups = page.getByTestId('merchant-group')
    await expect(groups.first()).toBeVisible()
    // Grouping collapses rows: fewer merchant groups than the 330 rows they came from.
    expect(await groups.count()).toBeLessThan(flatRows)
    await expect(page.getByTestId('txn-showing')).toContainText('merchant')

    // Tapping a group's name lands on the flat list filtered to that merchant.
    const merchant = await groups.first().getAttribute('data-merchant')
    await groups.first().getByTestId('group-open').click()
    await expect(page.getByTestId('group-toggle')).toHaveText('Group') // back to flat
    await expect(page.getByTestId('txn-search')).toHaveValue(merchant!)
    // The search box takes its value a render before the list re-filters, so snapshotting the
    // rows on the line above catches the tail of the unfiltered list. Wait for the list itself.
    const rows = page.getByTestId('txn-row')
    await expect(rows.first()).toHaveAttribute('data-merchant', new RegExp(merchant!, 'i'))
    for (const row of await rows.all()) {
      expect((await row.getAttribute('data-merchant'))?.toLowerCase()).toContain(merchant!.toLowerCase())
    }
  })

  // One merchant spelled two ways is two rows in this view and two subscriptions in Plan. The app
  // never merges spellings on its own — the user does, here, in one undoable commit.
  test('two spellings of one merchant can be merged by hand, and the merge undoes', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('group-toggle').click()
    const groups = page.getByTestId('merchant-group')
    const before = await groups.count()
    const source = (await groups.first().getAttribute('data-merchant'))!

    await groups.first().getByTestId('group-merge').click()
    const dialog = page.getByTestId('merge-merchant')
    await expect(dialog).toBeVisible()
    // Merge is unavailable until a spelling to keep is picked — the card cannot rename to nothing.
    await expect(page.getByTestId('merge-apply')).toBeDisabled()

    const target = (await page.getByTestId('merge-option').first().getAttribute('data-merchant'))!
    await page.getByTestId('merge-option').first().click()
    await page.getByTestId('merge-apply').click()
    await expect(dialog).toHaveCount(0)

    // One fewer merchant, and the source spelling is gone from the list.
    await expect(groups).toHaveCount(before - 1)
    await expect(page.locator(`[data-testid="merchant-group"][data-merchant="${source}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="merchant-group"][data-merchant="${target}"]`)).toHaveCount(1)

    // An ordinary undoable commit, like every other edit on this screen.
    await page.getByTestId('toast-undo').click()
    await expect(groups).toHaveCount(before)
  })

  // #12b: a declined subscription offer must stay declined — it used to live in React state
  // only, so every reload asked again.
  test('a dismissed recurring suggestion does not come back after a reload', async ({ page }) => {
    await importF1(page)
    const strips = page.getByTestId('recurring-suggest')
    await expect(strips.first()).toBeVisible()
    const dismissed = (await strips.first().textContent())!.trim()
    const shown = () => strips.allTextContents().then((ts) => ts.map((t) => t.trim()))

    await page.getByTestId('recurring-skip').first().click()
    expect(await shown()).not.toContain(dismissed)

    await page.waitForTimeout(1400) // let the save debounce flush before reloading
    await page.reload()
    await unlock(page)
    await goTab(page, 'txns')
    await expect(strips.first()).toBeVisible()
    expect(await shown()).not.toContain(dismissed)
  })
})

/**
 * A hidden account leaves the transaction list and the account filter — but only the READ
 * model narrows. The vault itself, and therefore any export, still holds everything.
 */
test.describe('hidden accounts', () => {
  test('rows and the filter entry disappear, and come back on unhide', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'txns')
    const total = (t: string) => Number(t.match(/of (\d+)/)![1])
    const before = total((await page.getByTestId('txn-showing').textContent())!)

    // Revolut · EUR, not Livret A — the savings account is snapshot-only and owns no rows.
    await page.getByTestId('filter-acct').click()
    await expect(page.locator('[data-menu-item="Revolut · EUR"]')).toBeVisible()
    await page.getByTestId('filter-acct').click()

    // Screens stay mounted across tabs, so the expanded panel survives a round trip —
    // clicking the row unconditionally would collapse it again.
    const hideToggle = async (which: 'account-hide' | 'account-unhide') => {
      await goTab(page, 'accounts')
      const btn = page.getByTestId(which)
      if ((await btn.count()) === 0) {
        await page.getByTestId('balance-Revolut · EUR').locator('xpath=ancestor::*[@aria-label="View snapshot history"]').click()
      }
      await btn.click()
      await goTab(page, 'txns')
    }

    await hideToggle('account-hide')
    expect(total((await page.getByTestId('txn-showing').textContent())!)).toBeLessThan(before)

    // …and it is no longer offered as a filter
    await page.getByTestId('filter-acct').click()
    await expect(page.locator('[data-menu-item="Revolut · EUR"]')).toHaveCount(0)
    await page.getByTestId('filter-acct').click()

    await hideToggle('account-unhide')
    await expect(page.getByTestId('txn-showing')).toContainText(`of ${before}`)
  })

  test('the export still carries the hidden account — only the read model narrowed', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'accounts')
    await page.getByTestId('balance-Livret A').locator('xpath=ancestor::*[@aria-label="View snapshot history"]').click()
    await page.getByTestId('account-hide').click()
    // all four rows are still listed; only the counts and charts narrowed
    await expect(page.locator('[aria-label="View snapshot history"]')).toHaveCount(4)

    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('3')
    await expect(page.getByTestId('hidden-count')).toContainText('1 hidden')

    const dl = page.waitForEvent('download')
    await page.getByTestId('export-json').click()
    const stream = await (await dl).createReadStream()
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    const vault = JSON.parse(Buffer.concat(chunks).toString())
    // the archive is complete: the account is present, flagged, with its data intact
    const livret = vault.accounts.find((a: { name: string }) => a.name === 'Livret A')
    expect(livret.hidden).toBe(true)
    expect(vault.accounts).toHaveLength(4)
    expect(vault.snapshots.some((s: { accountId: string }) => s.accountId === livret.id)).toBe(true)
  })
})

test.describe('empty states name their reason', () => {
  // "No transactions match." used to mean both "your vault is empty" and "six filters are
  // active" — two different problems, one message, no way out of either.
  test('an empty vault says so and offers Import', async ({ page }) => {
    await setupVault(page, { demo: false })
    await goTab(page, 'txns')
    const empty = page.getByTestId('txn-empty')
    await expect(empty).toHaveAttribute('data-basis', 'no-data')
    await expect(empty).toContainText('No transactions yet')
    await expect(page.getByTestId('txn-empty-action')).toContainText('Import a statement')
  })

  test('a filtered-to-nothing list says which filters did it, and clears all of them', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'txns')
    await page.getByTestId('txn-search').fill('zzzzzznomatchzzzzzz')
    const empty = page.getByTestId('txn-empty')
    await expect(empty).toHaveAttribute('data-basis', 'filtered')
    await expect(empty).toContainText('filter')
    await page.getByTestId('txn-empty-action').click()
    await expect(page.getByTestId('txn-empty')).toHaveCount(0)
  })
})

// The screen answered "which rows" and never "how much": narrowing to a category, an account or
// a date range gave a list and a count, and left the arithmetic to the reader.
test.describe('the filtered set totals itself', () => {
  test('in, out, net and the row count follow the filters', async ({ page }) => {
    await importF1(page)
    const bar = page.getByTestId('txn-totals')
    await expect(bar).toBeVisible()

    const allNet = await page.getByTestId('totals-net').innerText()
    const allCount = await page.getByTestId('totals-count').innerText()

    // f1 spans 5 Feb – 11 Jun 2026. Narrowing to June must move both the figure and the basis.
    await page.getByTestId('filter-date').click()
    await page.getByTestId('date-from').fill('2026-06-01')
    await page.getByTestId('date-to').fill('2026-06-30')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('totals-count')).toHaveText('over 21 matching rows')
    await expect(page.getByTestId('totals-net')).not.toHaveText(allNet)

    // NET is IN − OUT, on screen, in one row — the subtraction the reader would otherwise do.
    const money = async (id: string) => Number((await page.getByTestId(id).innerText()).replace(/[^0-9.]/g, ''))
    const sign = async (id: string) => ((await page.getByTestId(id).innerText()).startsWith('−') ? -1 : 1)
    const inflow = await money('totals-in')
    const outflow = await money('totals-out')
    const net = (await money('totals-net')) * (await sign('totals-net'))
    // Each figure is rounded to whole euros for display, so the on-screen subtraction can differ
    // from the exact one by at most a euro. What must never happen is the reader doing IN − OUT
    // and landing somewhere else entirely.
    expect(Math.abs(net - (inflow - outflow))).toBeLessThanOrEqual(1)

    await page.getByTestId('date-clear').click()
    await expect(page.getByTestId('totals-count')).toHaveText(allCount)
  })

  // The bar totals the whole matching set; the list stops at 200 rows. Those are different
  // questions, and the copy has to say which one it answered.
  test('the total spans the whole filtered set, not the loaded page', async ({ page }) => {
    await importF1(page)
    const shown = await page.getByTestId('txn-showing').innerText()
    const total = Number(shown.match(/of (\d+)/)![1])
    await expect(page.getByTestId('totals-count')).toHaveText(`over ${total} matching rows`)
  })

  test('selecting rows totals the selection, and select-all agrees with the bar', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('Bize')
    // Wait for the debounced filter to actually land: the row count alone is satisfied by the
    // unfiltered list, so snapshotting the net here would capture all 330 rows.
    await expect(page.getByTestId('totals-count')).toHaveText('over 36 matching rows')
    const filteredNet = await page.getByTestId('totals-net').innerText()

    await page.getByTestId('select-mode').click()
    await expect(page.getByTestId('totals-selected')).toHaveCount(0) // nothing selected yet

    await page.getByTestId('txn-check').first().check()
    await expect(page.getByTestId('totals-selected')).toContainText('1 SELECTED')

    // Select-all spans the whole filtered set, so its total must be the bar's own net.
    await page.getByTestId('select-all').check()
    await expect(page.getByTestId('totals-selected')).toContainText(filteredNet)
  })

  test('a transfer leg is counted and disclosed, never silently dropped', async ({ page }) => {
    await importF1(page)
    // Mark one row a transfer by hand (§9.4), then look at it through the transfers filter.
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('mark-transfer').click()
    await page.getByTestId('detail-close').click()

    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="Transfers"]').click()
    // The rows are on screen, so the arithmetic is about them: a bar reading "€0 in · €0 out"
    // over a visible transfer leg would be a total for a set nobody asked for.
    await expect(page.getByTestId('totals-transfers')).toContainText('includes 1 transfer leg')
    await expect(page.getByTestId('totals-net')).not.toHaveText('+€0')

    // The breakdown line answers the other question about the same row: a transfer is neither
    // earned nor spent, so it must leave INCOME/EXPENSES entirely and show up as a leg.
    await expect(page.getByTestId('totals-income')).toHaveText('€0')
    await expect(page.getByTestId('totals-expenses')).toHaveText('€0')
    const legIn = await page.getByTestId('totals-transfer-in').innerText()
    const legOut = await page.getByTestId('totals-transfer-out').innerText()
    expect(legIn + legOut).not.toBe('€0€0') // one of the two legs carries the row's amount
  })

  // The bar carries two readings of one set of rows: IN/OUT totals what moved through them,
  // INCOME/EXPENSES/TRANSFERS says what it meant. Same money, so they have to reconcile — a
  // breakdown that cannot be added back up to the net above it is two unrelated figures sharing
  // a box, and the reader has no way to tell which one is lying.
  test('the breakdown reconciles with the net above it, and reads the same rows differently', async ({ page }) => {
    await importF1(page)
    // Every figure in the bar can be signed: `fmt` prefixes '−', `netLbl` prefixes '+' or '−'.
    // EXPENSES in particular goes negative when refunds outweigh spend, which is exactly the
    // case below — reading it unsigned would hide the sign flip and pass on the wrong number.
    const signed = async (id: string) => {
      const txt = await page.getByTestId(id).innerText()
      return Number(txt.replace(/[^0-9.]/g, '')) * (txt.startsWith('−') ? -1 : 1)
    }
    // Every row lands in exactly one bucket, so the buckets sum back to the net above them. Five
    // figures rounded to whole euros for display ⇒ a few euros of drift, never a real gap.
    const reconciles = async () => {
      const cash = (await signed('totals-income')) - (await signed('totals-expenses'))
      const legs = (await signed('totals-transfer-in')) - (await signed('totals-transfer-out'))
      expect(Math.abs((await signed('totals-net')) - (cash + legs))).toBeLessThanOrEqual(3)
    }

    // Mark a transfer first, so all three buckets carry something and the identity is exercised
    // on three terms rather than two and a zero.
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('mark-transfer').click()
    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('totals-transfers')).toContainText('includes 1 transfer leg')
    await reconciles()

    // f1 files nothing as Income: its inflows are card top-ups and refunds. So IN is thousands
    // while INCOME is €0 — which is the whole reason for the second line. `in` is not income.
    expect(await signed('totals-in')).toBeGreaterThan(0)
    expect(await signed('totals-income')).toBe(0)

    // File the largest inflow as Income and it must change buckets: out of EXPENSES, where a
    // positive is a refund netting spend down, and into INCOME. IN must not move — same row,
    // same sign, and the first line only ever asked about sign.
    const inBefore = await signed('totals-in')
    const expensesBefore = await signed('totals-expenses')
    await page.getByTestId('sort-amount').click() // amount desc ⇒ the biggest inflow leads
    await page.getByTestId('txn-row').first().getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Income"]').click()
    await expect(page.getByTestId('toast')).toContainText('Income')

    const moved = await signed('totals-income')
    expect(moved).toBeGreaterThan(0)
    expect(Math.abs((await signed('totals-expenses')) - (expensesBefore + moved))).toBeLessThanOrEqual(2)
    expect(await signed('totals-in')).toBe(inBefore)
    await reconciles()
  })

  // Pressing a figure must open the rows that figure was computed FROM. The test of that is that
  // the figure does not move when pressed: if it did, the number and the list it opened were about
  // different sets, which is the one thing this bar must never do.
  test('pressing a figure opens exactly the rows it counted, and pressing it again gives them back', async ({ page }) => {
    await importF1(page)
    // Give every bucket something to hold: f1 arrives with no transfers and nothing filed as
    // Income, so a drill on either would land on an empty list and prove nothing.
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('mark-transfer').click()
    await page.getByTestId('detail-close').click()
    await page.getByTestId('sort-amount').click() // amount desc ⇒ the biggest inflow leads
    await page.getByTestId('txn-row').first().getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Income"]').click()
    await expect(page.getByTestId('toast')).toContainText('Income')

    const allCount = await page.getByTestId('totals-count').innerText()
    for (const [button, figure] of [
      ['flow-in', 'totals-in'],
      ['flow-out', 'totals-out'],
      ['flow-income', 'totals-income'],
      ['flow-expenses', 'totals-expenses'],
      ['flow-transfer-out', 'totals-transfer-out'],
    ] as const) {
      const before = await page.getByTestId(figure).innerText()
      await page.getByTestId(button).click()
      await expect(page.getByTestId(figure)).toHaveText(before)
      await expect(page.getByTestId('totals-count')).not.toHaveText(allCount)
      // A filter like any other: it appears in the receipt row and survives in the hash, so the
      // drilled view can be shared and reloaded like every other drill.
      await expect(page.getByTestId('txn-filter-chips')).toBeVisible()
      expect(page.url()).toContain(`flow=${button.replace('flow-', '')}`)

      await page.getByTestId(button).click() // the active figure is the way back
      await expect(page.getByTestId('totals-count')).toHaveText(allCount)
    }
  })

  // A bucket can legitimately be empty — one transfer leg marked and no partner for it yet. The
  // drill still has to be escapable, and the bar it was pressed from is gone with the rows.
  test('drilling into an empty bucket says which filter did it, and the chip clears it', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-row').first().click()
    await page.getByTestId('mark-transfer').click()
    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('totals-transfer-in')).toHaveText('€0') // the leg with no partner

    await page.getByTestId('flow-transfer-in').click()
    await expect(page.getByTestId('txn-totals')).toHaveCount(0) // no rows, so no total either
    await expect(page.getByTestId('txn-empty')).toContainText('transfers in')
    await page.getByTestId('txn-filters-clear').click()
    await expect(page.getByTestId('txn-totals')).toBeVisible()
  })

  test('grouped totals add up to the same net the bar reports', async ({ page }) => {
    await importF1(page)
    await page.getByTestId('txn-search').fill('Bize')
    await expect(page.getByTestId('totals-count')).toHaveText('over 36 matching rows')
    const barNet = Number((await page.getByTestId('totals-net').innerText()).replace(/[^0-9.]/g, ''))

    await page.getByTestId('group-toggle').click()
    await expect(page.getByTestId('merchant-group').first()).toBeVisible()
    const totals = await page.locator('[data-group-total]').evaluateAll((els) =>
      els.reduce((s, el) => s + Number(el.getAttribute('data-group-total')), 0),
    )
    // The group totals used to sum `t.amount` raw, with no FX — so a foreign row entered a base
    // figure at face value and the two totals on this screen disagreed. One conversion feeds both.
    // Rounded to whole euros, because that is how the bar prints the figure being compared.
    expect(Math.round(Math.abs(totals))).toBe(barNet)
  })
})
