import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { appUrl, awaitPushed, expectStatus, goTab, nudgeSync, nudgeUntilText, remoteName, setupVault, unlock } from './helpers'

// Phase A vehicle: the interim Settings pane's Params steppers stand in for the
// (removed) budget UI. `srTarget` is a field-LWW singleton field — exactly the
// merge shape the old budget-amount edits exercised.

async function newDevice(context: BrowserContext, remote: string, demo: boolean): Promise<Page> {
  const page = await context.newPage()
  await setupVault(page, { remote, demo })
  return page
}

test.describe('multi-tab (one device, shared L1)', () => {
  test('an edit in tab A appears in tab B via BroadcastChannel', async ({ page, context }) => {
    await setupVault(page)
    await goTab(page, 'settings')

    const tabB = await context.newPage()
    await tabB.goto(appUrl())
    await unlock(tabB)
    await goTab(tabB, 'settings')
    await expect(tabB.getByTestId('param-srTarget')).toHaveText('20%')

    await page.getByTestId('param-srTarget-inc').click()
    await expect(page.getByTestId('param-srTarget')).toHaveText('21%')
    // debounce (1s) → save → broadcast → sibling reloads from L1
    await expect(tabB.getByTestId('param-srTarget')).toHaveText('21%', { timeout: 5000 })
  })
})

test.describe('cross-device sync over a shared remote', () => {
  test('status transitions and edit propagation on focus', async ({ browser }) => {
    const remote = remoteName('prop')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const A = await newDevice(ctxA, remote, true)
    await expectStatus(A, /SYNCED/)

    // B bootstraps into the shared remote: empty vault → rekey/adopt flow
    const B = await newDevice(ctxB, remote, false)
    await expect(B.getByTestId('sync-status')).toHaveText(/NEW PASSWORD NEEDED/, { timeout: 10_000 })
    await B.getByTestId('password').fill('hunter22hunter22')
    await B.getByTestId('unlock-go').click()
    await expectStatus(B, /SYNCED/)
    await goTab(B, 'settings')
    await expect(B.getByTestId('account-count')).toHaveText('4') // adopted A's data

    // A edits; B picks it up on focus
    await goTab(A, 'settings')
    await A.getByTestId('param-srTarget-inc').click()
    await awaitPushed(A)
    await nudgeUntilText(B, 'param-srTarget', '21%')

    await ctxA.close()
    await ctxB.close()
  })

  test('concurrent same-field edits produce exactly one sync note; “use other value” converges', async ({ browser }) => {
    const remote = remoteName('conflict')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    // Empty vault: the demo seed ships its own notes, which would pollute the
    // "exactly one note" assertion — this test only needs the srTarget param.
    const A = await newDevice(ctxA, remote, false)
    await expectStatus(A, /SYNCED/)
    const B = await newDevice(ctxB, remote, false)
    await expect(B.getByTestId('sync-status')).toHaveText(/NEW PASSWORD NEEDED/, { timeout: 10_000 })
    await B.getByTestId('password').fill('hunter22hunter22')
    await B.getByTestId('unlock-go').click()
    await expectStatus(B, /SYNCED/)

    await goTab(A, 'settings')
    await goTab(B, 'settings')
    // take B offline; it edits srTarget 20 → 21 (its push will queue)
    await ctxB.setOffline(true)
    await B.getByTestId('param-srTarget-inc').click()
    await B.waitForTimeout(1400)
    // A edits the SAME field differently (20 → 22) and syncs first
    await A.getByTestId('param-srTarget-inc').click()
    await A.getByTestId('param-srTarget-inc').click()
    await awaitPushed(A)

    // B reconnects → race lost → pull, merge → same-field conflict → note
    await ctxB.setOffline(false)
    await B.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(B.getByTestId('notes-count')).toHaveText(/NOTE/, { timeout: 15_000 })

    // A picks up the note too
    await nudgeUntilText(A, 'notes-count', /NOTE/)

    // resolve on B: "use other value" swaps to the loser and syncs everywhere
    await B.getByTestId('notes-count').click()
    await expect(B.getByTestId('sync-notes-panel')).toBeVisible()
    const kept = await B.getByTestId('sync-notes-panel').locator('[data-testid^="note-"]').count()
    expect(kept).toBe(1) // exactly one note
    await B.getByTestId('use-other').click()
    await expect(B.getByTestId('toast')).toContainText('switched to')

    // both devices converge on the chosen value
    await awaitPushed(B)
    const bVal = await B.getByTestId('param-srTarget').textContent()
    await nudgeUntilText(A, 'param-srTarget', bVal!)

    await ctxA.close()
    await ctxB.close()
  })

  test('offline edits queue and flush on reconnect', async ({ browser }) => {
    const remote = remoteName('offline')
    const ctxA = await browser.newContext()
    const A = await newDevice(ctxA, remote, true)
    await expectStatus(A, /SYNCED/)

    await ctxA.setOffline(true)
    await goTab(A, 'settings')
    await A.getByTestId('param-srTarget-inc').click()
    await A.waitForTimeout(1400) // saved locally
    await A.evaluate(() => window.dispatchEvent(new Event('offline')))
    // trigger a sync attempt → offline pending
    await nudgeSync(A)
    await expect(A.getByTestId('sync-status')).toHaveText(/OFFLINE|SAVED|NOT SYNCED|SYNCING/, { timeout: 10_000 })

    await ctxA.setOffline(false)
    await A.evaluate(() => window.dispatchEvent(new Event('online')))
    await expectStatus(A, /SYNCED/)
    await ctxA.close()
  })
})
