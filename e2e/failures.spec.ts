import { expect, test } from '@playwright/test'
import { expectStatus, goTab, nudgeSync, nudgeUntilText, remoteName, setupVault } from './helpers'

// Phase A vehicle: Params steppers in the interim Settings pane replace the
// removed budget UI as the durable-edit trigger for sync round-trips.

test.describe('failure paths', () => {
  test('corrupted remote raises the damage banner, never overwrites blind, restore recovers', async ({ page, request }) => {
    const remote = remoteName('corrupt')
    await setupVault(page, { remote })
    await expectStatus(page, /SYNCED/)

    // damage the remote bytes (header intact, ciphertext flipped)
    await request.post(`/__remote/${remote}/corrupt`)

    // any local change → sync → pull → corrupt classification
    await goTab(page, 'settings')
    await page.getByTestId('param-srTarget-inc').click()
    await expect(page.getByTestId('banner')).toContainText('damaged', { timeout: 15_000 })
    await expect(page.getByTestId('banner')).toContainText('local copy is intact')

    // recovery: restore local over remote (keeps forensics server-side)
    await page.getByRole('button', { name: 'Restore my copy over it' }).click()
    await expectStatus(page, /SYNCED/)
    const bak = await request.get(`/__remote/${encodeURIComponent(`${remote}.vault.corrupt.bak`)}`)
    expect(bak.status()).toBe(200)
  })

  test('a 503 remote degrades to NOT SYNCED and recovers on the next success', async ({ page, request }) => {
    const remote = remoteName('flaky')
    await setupVault(page, { remote })
    await expectStatus(page, /SYNCED/)

    await request.post(`/__remote/${remote}/fail?n=40`) // enough to exhaust all 8 retries
    await goTab(page, 'settings')
    await page.getByTestId('param-srTarget-inc').click()
    await expect(page.getByTestId('sync-status')).toHaveText(/NOT SYNCED SINCE \d\d:\d\d/, { timeout: 30_000 })

    await request.post(`/__remote/${remote}/fail?n=0`)
    await nudgeSync(page) // focus trigger retries
    await expectStatus(page, /SYNCED/)
    // the queued edit made it out
    const head = await request.fetch(`/__remote/${remote}`, { method: 'HEAD' })
    expect(head.status()).toBe(200)
  })

  test('password changed on another device: re-key prompt, local edits survive', async ({ browser }) => {
    const remote = remoteName('rekey')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const A = await ctxA.newPage()
    await setupVault(A, { remote })
    await expectStatus(A, /SYNCED/)

    // B joins the vault
    const B = await ctxB.newPage()
    await setupVault(B, { remote, demo: false })
    await expect(B.getByTestId('sync-status')).toHaveText(/NEW PASSWORD NEEDED/, { timeout: 10_000 })
    await B.getByTestId('password').fill('hunter22hunter22')
    await B.getByTestId('unlock-go').click()
    await expectStatus(B, /SYNCED/)

    // A makes a local edit that hasn't synced yet when the re-key lands
    await goTab(A, 'settings')

    // B changes the password and pushes
    await goTab(B, 'settings')
    await B.getByTestId('change-password').click()
    await B.getByTestId('newpw-1').fill('rotated-password-9')
    await B.getByTestId('newpw-2').fill('rotated-password-9')
    await B.getByTestId('newpw-go').click()
    await expectStatus(B, /SYNCED/)

    // A edits locally, then its push meets the re-keyed remote
    await A.getByTestId('param-srTarget-inc').click()
    await expect(A.getByTestId('sync-status')).toHaveText(/NEW PASSWORD NEEDED/, { timeout: 15_000 })
    await A.getByTestId('password').fill('rotated-password-9')
    await A.getByTestId('unlock-go').click()
    await expectStatus(A, /SYNCED/)

    // A's local edit survived the re-key and reached B
    await nudgeUntilText(B, 'param-srTarget', '21%')

    await ctxA.close()
    await ctxB.close()
  })
})
