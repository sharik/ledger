import { expect, test } from '@playwright/test'
import { appUrl, awaitPushed, expectStatus, goTab, nudgeUntilText, remoteName, setupVault, PASSWORD } from './helpers'

/**
 * Google Drive as the sync remote. `?drive=test:<slot>` swaps Google's API for
 * the devRemote plugin's double and the consent popup for a canned redirect —
 * everything else (PKCE, state check, token storage, the emulated CAS, the
 * engine) is the shipping code path. Real OAuth is the one manual test.
 */

test.describe('connecting Drive', () => {
  test('Settings connects, labels the remote, and syncs', async ({ page }) => {
    await setupVault(page, { drive: remoteName('connect') })
    await goTab(page, 'settings')
    await expect(page.getByTestId('remote-label')).toHaveText('None')

    await page.getByTestId('connect-gdrive').click()

    await expect(page.getByTestId('remote-label')).toHaveText(/Google Drive · ledger\.vault/)
    await expectStatus(page, /SYNCED/)
  })

  test('survives a reload — the file id and the grant both persist', async ({ page }) => {
    const drive = remoteName('persist')
    await setupVault(page, { drive })
    await goTab(page, 'settings')
    await page.getByTestId('connect-gdrive').click()
    await expectStatus(page, /SYNCED/)

    await page.goto(appUrl({ drive }))
    await page.getByTestId('password').fill(PASSWORD)
    await page.getByTestId('unlock-go').click()
    await expectStatus(page, /SYNCED/)
    await goTab(page, 'settings')
    await expect(page.getByTestId('remote-label')).toHaveText(/Google Drive · ledger\.vault/)
  })

  test('switches over from an already-connected remote without disconnecting first', async ({ page }) => {
    // The Drive button used to render only when nothing was connected, which left
    // every existing vault-file user with no route to Drive at all.
    const drive = remoteName('switch')
    await setupVault(page, { remote: remoteName('file'), drive })
    await goTab(page, 'settings')
    await expect(page.getByTestId('remote-label')).toHaveText(/test remote/)

    await page.getByTestId('connect-gdrive').click()

    await expect(page.getByTestId('remote-label')).toHaveText(/Google Drive · ledger\.vault/)
    await expectStatus(page, /SYNCED/)
  })

  test('disconnecting returns to local-only', async ({ page }) => {
    await setupVault(page, { drive: remoteName('disconnect') })
    await goTab(page, 'settings')
    await page.getByTestId('connect-gdrive').click()
    await expectStatus(page, /SYNCED/)

    await page.getByTestId('disconnect').click()
    await expect(page.getByTestId('remote-label')).toHaveText('None')
    await expectStatus(page, /LOCAL ONLY/)
  })
})

test.describe('a second device', () => {
  test('bootstraps from the boot screen with nothing stored locally', async ({ browser }) => {
    const drive = remoteName('boot')

    const ctxA = await browser.newContext()
    const A = await ctxA.newPage()
    await setupVault(A, { drive, demo: true })
    await goTab(A, 'settings')
    await A.getByTestId('connect-gdrive').click()
    await expectStatus(A, /SYNCED/)
    await A.getByTestId('param-srTarget-inc').click()
    await awaitPushed(A)

    // B has never held a vault: no L1, no File System Access API on a phone —
    // Drive is the only way it can ever reach this data.
    const ctxB = await browser.newContext()
    const B = await ctxB.newPage()
    await B.goto(appUrl({ drive }))
    await B.getByTestId('tab-open').click()
    await B.getByTestId('pick-gdrive').click()
    await expect(B.getByTestId('pick-file')).toHaveText(/ledger\.vault/)

    await B.getByTestId('password').fill(PASSWORD)
    await B.getByTestId('unlock-go').click()
    await expect(B.getByTestId('app-shell')).toBeVisible()
    await goTab(B, 'settings')
    await expect(B.getByTestId('param-srTarget')).toHaveText('21%') // A's edit came down
    await expect(B.getByTestId('remote-label')).toHaveText(/Google Drive · ledger\.vault/)

    // …and it is a peer, not a copy: an edit on B reaches A.
    await B.getByTestId('param-srTarget-inc').click()
    await awaitPushed(B)
    await nudgeUntilText(A, 'param-srTarget', '22%')

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('failure paths', () => {
  test('an empty Drive says so, instead of blaming the network', async ({ page }) => {
    // A first-time user signs in and there is nothing up there yet. This used to
    // create a placeholder file and then report "couldn't reach Google Drive".
    await page.goto(appUrl({ drive: remoteName('empty') }))
    await page.getByTestId('tab-open').click()
    await page.getByTestId('pick-gdrive').click()

    await expect(page.getByTestId('unlock-error')).toHaveText(/No Ledger vault in this Google Drive yet/)
    await expect(page.getByTestId('pick-file')).toHaveText(/Choose vault file/) // nothing was picked
  })

  test('a lapsed grant parks at RECONNECT DRIVE and the app stays usable', async ({ page }) => {
    const drive = remoteName('reauth')
    await setupVault(page, { drive })
    await goTab(page, 'settings')
    await page.getByTestId('connect-gdrive').click()
    await expectStatus(page, /SYNCED/)

    // What a revoked grant looks like on the next boot: the config is still there,
    // the token is not.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('ledger', 1)
          req.onsuccess = () => {
            const tx = req.result.transaction('kv', 'readwrite')
            tx.objectStore('kv').delete('sync.gdriveToken')
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          }
          req.onerror = () => reject(req.error)
        }),
    )
    await page.goto(appUrl({ drive }))
    await page.getByTestId('password').fill(PASSWORD)
    await page.getByTestId('unlock-go').click()

    await expectStatus(page, /RECONNECT DRIVE/)
    await goTab(page, 'settings')
    await expect(page.getByTestId('sync-detail')).toHaveText(/Google access has lapsed/)

    // The vault still works while disconnected, and Reconnect brings sync back.
    await page.getByTestId('param-srTarget-inc').click()
    await page.getByTestId('reconnect').click()
    await expectStatus(page, /SYNCED/)
  })

  test('an unreachable Drive backs off instead of losing the edit', async ({ page, request, baseURL }) => {
    const drive = remoteName('down')
    await setupVault(page, { drive })
    await goTab(page, 'settings')
    await page.getByTestId('connect-gdrive').click()
    await expectStatus(page, /SYNCED/)

    await request.post(`${baseURL}/__drive/${drive}/fail?n=40&status=503`)
    await page.getByTestId('param-srTarget-inc').click()
    await expect(page.getByTestId('sync-status')).toHaveText(/NOT SYNCED/, { timeout: 20_000 })
    await expect(page.getByTestId('param-srTarget')).toHaveText('21%') // held locally, not lost

    await nudgeUntilText(page, 'sync-status', /SYNCED/, 30)
  })
})
