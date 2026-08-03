import { expect, test, type Page } from '@playwright/test'
import { goTab, setupVault } from './helpers'

const F1 = 'tests/fixtures/revolut/f1.xlsx'
const PROVIDER = 'https://openrouter.ai/api/v1/chat/completions'

/** Configure the assist against OpenRouter. Every request is intercepted — none leave the machine. */
async function enableAssist(page: Page) {
  await goTab(page, 'settings')
  await page.getByTestId('assist-toggle').click()
  await page.getByTestId('assist-provider').selectOption('openrouter')
  await page.getByTestId('assist-model').fill('test/model')
  await page.getByTestId('assist-key').fill('sk-test')
  await page.getByTestId('assist-key').blur()
}

async function importF1(page: Page) {
  await page.getByTestId('import-btn').click()
  await page.getByTestId('import-file').setInputFiles(F1)
}

test.describe('smart categorization on import (§10.6)', () => {
  test('the review list renders before any request, and the model is asked only on approval', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    let calls = 0
    await page.route(PROVIDER, async (route) => {
      calls++
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '{"predictions":[]}' } }] }),
      })
    })

    await importF1(page)

    // The regression that mattered: the assist used to be awaited before the plan was ever set, so
    // an import with it enabled showed an empty screen for as long as the provider took.
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    expect(calls).toBe(0)

    // The offer states the cost — in distinct merchants, not rows — before anything is sent.
    const strip = page.getByTestId('assist-strip')
    await expect(strip).toContainText('distinct')
    await expect(strip).toContainText('no amounts or dates')
    expect(calls).toBe(0)

    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-outcome')).toBeVisible({ timeout: 30_000 })
    expect(calls).toBeGreaterThan(0)
  })

  test('a provider that never answers reports it, and offers a smaller-batch retry', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    let attempts = 0
    await page.route(PROVIDER, async (route) => {
      attempts++
      await route.abort('timedout')
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('assist-run').click()
    // Issue 9: a dead provider must not be indistinguishable from a model with no opinion.
    await expect(page.getByTestId('assist-outcome')).toContainText('failed on', { timeout: 30_000 })
    await expect(page.getByTestId('assist-outcome')).toContainText('showing rule results only')

    // …and it must not be a dead end. The retry re-asks in smaller batches, so it makes more
    // requests than the run that just failed.
    const first = attempts
    await expect(page.getByTestId('assist-retry')).toContainText('smaller batches')
    await page.getByTestId('assist-retry').click()
    await expect(page.getByTestId('assist-outcome')).toContainText('failed on', { timeout: 60_000 })
    expect(attempts - first).toBeGreaterThan(first)
  })

  // Issue 11f: the model's verdict was visible during review and then dropped at commit, so a
  // committed vault could not answer "which of these did the AI guess at?".
  test('a row the model categorized stays findable after the commit, until a hand pick replaces it', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    // One answer per request — the first descriptor of each batch — keyed off the prompt so no
    // category id is hardcoded. The run is batched, so this collects several merchants.
    const answered: string[] = []
    await page.route(PROVIDER, async (route) => {
      const body = route.request().postDataJSON() as { messages: { content: string }[] }
      const prompt = body.messages.map((m) => m.content).join('\n')
      const transport = prompt.match(/^(\S+) = Transport$/m)?.[1]
      const first = prompt.match(/- descriptor="([^"]+)" merchant="([^"]+)"/)
      if (first && transport) answered.push(first[2]!)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ predictions: first && transport ? [{ descriptor: first[1], categoryId: transport, confidence: 0.95 }] : [] }) } }],
        }),
      })
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-outcome')).toContainText('categorized by AI', { timeout: 30_000 })
    expect(answered.length).toBeGreaterThan(0)

    await page.getByTestId('confirm-import').click()
    await expect(page.getByTestId('txn-row').first()).toBeVisible()

    // The filter Plan C.2 specced and 11f recorded as unbuildable: it finds exactly the rows
    // the model placed, and nothing else.
    await page.getByTestId('filter-status').click()
    await page.locator('[data-menu-item="AI"]').click()
    const aiRows = page.getByTestId('txn-row')
    await expect(aiRows.first()).toBeVisible()
    const guessed = await aiRows.count()
    for (const row of await aiRows.all()) expect(answered).toContain(await row.getAttribute('data-merchant'))

    // …and a single row can say so for itself, not just the filtered list.
    await aiRows.first().click()
    await expect(page.getByTestId('detail-provenance')).toHaveText('AI')
    await page.getByTestId('detail-close').click()

    // Correcting one by hand takes it out: otherwise the filter decays into "rows the model
    // ever touched", the same rot that made the IMPORTED badge meaningless (11d).
    await aiRows.first().getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Groceries"]').click()
    await expect(page.getByTestId('toast')).toContainText('Groceries')
    await expect(page.getByTestId('txn-showing')).toContainText(`of ${guessed - 1}`)
  })

  // Changing the account re-plans the whole file (the account sets the dedup scope). The costly AI
  // work is merchant-keyed and account-independent, so it must survive the re-plan, not vanish.
  test('the AI categorization survives an account rename (re-plan does not discard it)', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)
    await page.route(PROVIDER, async (route) => {
      const body = route.request().postDataJSON() as { messages: { content: string }[] }
      const prompt = body.messages.map((m) => m.content).join('\n')
      const transport = prompt.match(/^(\S+) = Transport$/m)?.[1]
      const first = prompt.match(/- descriptor="([^"]+)" merchant="([^"]+)"/)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ predictions: first && transport ? [{ descriptor: first[1], categoryId: transport, confidence: 0.95 }] : [] }) } }] }),
      })
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-outcome')).toContainText('categorized by AI', { timeout: 30_000 })

    const before = await page.getByTestId('review-row').filter({ hasText: 'AI ·' }).count()
    expect(before).toBeGreaterThan(0)

    // Rename the account — this re-plans the file from scratch.
    await page.getByTestId('mapping-change').click()
    await page.getByTestId('new-account-name').fill('Renamed Account')
    await page.getByTestId('create-account').click()

    // The AI rows and the outcome line are still there — not reset to a fresh, un-categorized plan.
    await expect(page.getByTestId('review-list')).toBeVisible()
    await expect(page.getByTestId('assist-outcome')).toContainText('categorized by AI')
    await expect(page.getByTestId('review-row').filter({ hasText: 'AI ·' })).toHaveCount(before)
  })

  // Renaming/switching the account re-plans the file, but a manual category pick (a decision) and a
  // trip assignment are separate, hash-keyed state the re-plan never touches — they must persist.
  test('a manual category and a trip assignment survive an account rename', async ({ page }) => {
    await setupVault(page, { demo: false })
    await importF1(page) // no assist needed — this is about hand edits, not the model
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })

    const row0 = page.getByTestId('review-row').first()
    // Manual category.
    await row0.getByTestId('recat-chip').click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Groceries"]').click()
    await expect(row0.getByTestId('recat-chip')).toHaveText(/Groceries/)
    // Trip on the same row.
    await row0.getByTestId('trip-picker-open').click()
    await page.getByTestId('trip-picker-new').click()
    await page.getByTestId('trip-picker-new-name').fill('Test Trip')
    await page.getByTestId('trip-picker-new-name').press('Enter')
    await expect(row0.locator('[data-testid="review-trip-chip"][data-on="1"]')).toBeVisible()

    // Rename the account → the whole file re-plans.
    await page.getByTestId('mapping-change').click()
    await page.getByTestId('new-account-name').fill('Renamed Account')
    await page.getByTestId('create-account').click()

    // First review row is the same source-order row; both edits survived the re-plan.
    const after = page.getByTestId('review-row').first()
    await expect(after.getByTestId('recat-chip')).toHaveText(/Groceries/)
    await expect(after.locator('[data-testid="review-trip-chip"][data-on="1"]')).toBeVisible()
  })

  // A category chosen by hand while the model is still thinking must survive the model's reply —
  // the user's decision outranks a suggestion, never the other way round.
  test('a hand pick made while the model runs is not overwritten when it returns', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    let release!: () => void
    const parked = new Promise<void>((r) => { release = r })
    let first = true
    await page.route(PROVIDER, async (route) => {
      const prompt = (route.request().postDataJSON() as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n')
      const dining = prompt.match(/^(\S+) = Dining out$/m)?.[1]
      const descs = [...prompt.matchAll(/- descriptor="([^"]+)"/g)].map((m) => m[1])
      // The model wants Dining out for everything — including the row picked by hand below.
      const predictions = descs.map((d) => ({ descriptor: d, categoryId: dining, confidence: 0.95 }))
      if (first) { first = false; await parked }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ predictions }) } }] }) })
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-progress')).toBeVisible()

    // Hand-categorize the first row while the request is held open.
    const chip = page.getByTestId('review-row').first().getByTestId('recat-chip')
    await chip.click()
    await page.locator('[data-testid="cat-menu"] [data-cat="Shopping"]').click()
    await expect(chip).toContainText('Shopping')

    release()
    await expect(page.getByTestId('assist-outcome')).toBeVisible({ timeout: 30_000 })

    // The model's Dining out landed on the other rows, but not on the one already decided.
    await expect(chip).toContainText('Shopping')
  })

  // Issue 15: a run in progress can be stopped. The in-flight batch aborts, no further batches
  // fire, and the outcome says so — partial results (none here) are kept, not discarded.
  test('a running assist can be stopped, and no further batches fire', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    let release!: () => void
    const parked = new Promise<void>((r) => { release = r })
    let calls = 0
    await page.route(PROVIDER, async (route) => {
      calls++
      await parked
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"predictions":[]}' } }] }) })
      } catch { /* the request was aborted by Stop — nothing to fulfil */ }
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-progress')).toBeVisible()

    await page.getByTestId('assist-stop').click()
    await expect(page.getByTestId('assist-outcome')).toContainText('Stopped', { timeout: 15_000 })
    // The first batch was in flight and every later batch is sequential, so a Stop leaves the
    // provider having been called exactly once — nothing new is issued after the abort.
    expect(calls).toBe(1)
    release()
  })

  // Issue 14: after the assist runs, correcting one row with "Always" must harmonize the same
  // merchant's other rows — the ones the model already guessed (`provenance: 'ai'`) — not just
  // untouched fallback rows. A this-session hand decision still wins.
  test('a rule minted after the assist harmonizes the merchant’s AI-guessed siblings', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    // The model confidently wants Dining out for every descriptor, so every row becomes AI-placed.
    await page.route(PROVIDER, async (route) => {
      const prompt = (route.request().postDataJSON() as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n')
      const dining = prompt.match(/^(\S+) = Dining out$/m)?.[1]
      const descs = [...prompt.matchAll(/- descriptor="([^"]+)"/g)].map((m) => m[1])
      const predictions = descs.map((d) => ({ descriptor: d, categoryId: dining, confidence: 0.95 }))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ predictions }) } }] }) })
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-outcome')).toContainText('categorized by AI', { timeout: 30_000 })

    // A merchant appearing on more than one row — all its rows are AI/Dining out now.
    const merchants = await page.getByTestId('review-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-merchant')))
    const repeated = merchants.find((m, i) => m && !m.includes('"') && merchants.indexOf(m) !== i)!
    expect(repeated).toBeTruthy()
    const repeatedRows = page.locator(`[data-testid="review-row"][data-merchant="${repeated}"]`)
    expect(await repeatedRows.count()).toBeGreaterThan(1)

    // Correct the first sibling to Shopping and answer Always → mints a merchant rule.
    const firstRepeat = repeatedRows.first()
    await firstRepeat.getByTestId('recat-chip').click()
    await firstRepeat.locator('[data-testid="cat-menu"] [data-cat="Shopping"]').click()
    await firstRepeat.getByTestId('always-yes').click()

    // Every row of that merchant now reads Shopping — including the siblings the model placed.
    for (const r of await repeatedRows.all()) await expect(r.getByTestId('recat-chip')).toContainText('Shopping')

    // A different merchant the model guessed is untouched — the rule is merchant-scoped.
    const other = merchants.find((m) => m && m !== repeated)!
    await expect(page.locator(`[data-testid="review-row"][data-merchant="${other}"]`).first().getByTestId('recat-chip')).toContainText('Dining out')
  })

  // "Other" is the fallback bucket — a model returning it is saying it has no idea, which is
  // exactly the state the row is already in. Applying it as a confident answer is noise.
  test('a model answer of the fallback category is treated as no suggestion', async ({ page }) => {
    await setupVault(page, { demo: false })
    await enableAssist(page)

    await page.route(PROVIDER, async (route) => {
      const prompt = (route.request().postDataJSON() as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n')
      const other = prompt.match(/^(\S+) = Other$/m)?.[1]
      const descs = [...prompt.matchAll(/- descriptor="([^"]+)"/g)].map((m) => m[1])
      const predictions = descs.map((d) => ({ descriptor: d, categoryId: other, confidence: 0.95 }))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ predictions }) } }] }) })
    })

    await importF1(page)
    await expect(page.getByTestId('review-list')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('assist-run').click()
    await expect(page.getByTestId('assist-outcome')).toBeVisible({ timeout: 30_000 })

    // No row was moved: the outcome reports nothing confident, and the rows stay needs-review
    // rather than reading as an AI-placed "Other".
    await expect(page.getByTestId('assist-outcome')).toContainText('no confident suggestion')
    await expect(page.getByTestId('review-row').first()).toContainText('needs review')
  })
})
