import { writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { appUrl, expectStatus, goTab, PASSWORD, remoteName, setupVault } from './helpers'

/**
 * "Open vault file" from the boot screens. E2E uses the input-fallback picker
 * (?nofsa) because Playwright can intercept <input type=file> but not the
 * native File System Access picker; the unlock/adopt pipeline is identical.
 */

async function makeVaultFile(page: Page, testInfoPath: string, remote: string): Promise<string> {
  await setupVault(page, { remote })
  await expectStatus(page, /SYNCED/)
  const res = await page.request.get(`/__remote/${remote}`)
  expect(res.status()).toBe(200)
  const path = testInfoPath
  await writeFile(path, Buffer.from(await res.body()))
  return path
}

test('setup screen offers "Open vault file": picks, asks the password once, opens', async ({ browser, page }, testInfo) => {
  const remote = remoteName('openfile')
  const vaultPath = await makeVaultFile(page, testInfo.outputPath('ledger.vault'), remote)

  // a fresh "device"
  const ctxB = await browser.newContext()
  const B = await ctxB.newPage()
  await B.goto(appUrl({ extra: '&nofsa' }))
  await expect(B.getByTestId('tab-open')).toBeVisible()
  await B.getByTestId('tab-open').click()

  const chooser = B.waitForEvent('filechooser')
  await B.getByTestId('pick-file').click()
  await (await chooser).setFiles(vaultPath)
  await expect(B.getByTestId('pick-file')).toContainText('ledger.vault')

  // wrong password is refused, right one opens — asked exactly once
  await B.getByTestId('password').fill('wrong-password-xx')
  await B.getByTestId('unlock-go').click()
  await expect(B.getByTestId('unlock-error')).toContainText('doesn’t decrypt')
  await B.getByTestId('password').fill(PASSWORD)
  await B.getByTestId('unlock-go').click()
  await expect(B.getByTestId('app-shell')).toBeVisible()

  // input fallback has no writable handle → local-only, remote label None
  await goTab(B, 'settings')
  await expect(B.getByTestId('account-count')).toHaveText('4')
  await expect(B.getByTestId('remote-label')).toHaveText('None')
  await ctxB.close()
})

test('unlock screen can switch to opening a different vault file (replaces local vault)', async ({ browser, page }, testInfo) => {
  const remote = remoteName('openfile2')
  const vaultPath = await makeVaultFile(page, testInfo.outputPath('ledger2.vault'), remote)

  const ctxB = await browser.newContext()
  const B = await ctxB.newPage()
  // B has its own local vault (different password) …
  await B.goto(appUrl({ extra: '&nofsa' }))
  await B.getByTestId('password').fill('completely-other-pw')
  await B.getByTestId('password2').fill('completely-other-pw')
  await B.getByTestId('start-empty').click()
  await B.getByTestId('unlock-go').click()
  await expect(B.getByTestId('app-shell')).toBeVisible()
  await goTab(B, 'settings')
  await expect(B.getByTestId('account-count')).toHaveText('0')

  // … reload lands on unlock, which now offers the open-file escape hatch
  await B.goto(appUrl({ extra: '&nofsa' }))
  await expect(B.getByTestId('switch-open')).toBeVisible()
  await B.getByTestId('switch-open').click()
  await expect(B.locator('text=replaces the vault currently on this device')).toBeVisible()

  const chooser = B.waitForEvent('filechooser')
  await B.getByTestId('pick-file').click()
  await (await chooser).setFiles(vaultPath)
  await B.getByTestId('password').fill(PASSWORD)
  await B.getByTestId('unlock-go').click()
  await expect(B.getByTestId('app-shell')).toBeVisible()
  await goTab(B, 'settings')
  await expect(B.getByTestId('account-count')).toHaveText('4')

  // the adopted vault persists: reload unlocks with the FILE's password now
  await B.goto(appUrl({ extra: '&nofsa' }))
  await B.getByTestId('password').fill(PASSWORD)
  await B.getByTestId('unlock-go').click()
  await expect(B.getByTestId('app-shell')).toBeVisible()
  await goTab(B, 'settings')
  await expect(B.getByTestId('account-count')).toHaveText('4')
  await ctxB.close()
})

test('back link returns from open-file view to unlock', async ({ page }) => {
  await setupVault(page)
  await page.goto(appUrl())
  await page.getByTestId('switch-open').click()
  await expect(page.getByTestId('pick-file')).toBeVisible()
  await page.getByTestId('switch-unlock').click()
  await expect(page.getByTestId('pick-file')).toHaveCount(0)
  await expect(page.getByTestId('password')).toBeVisible()
})
