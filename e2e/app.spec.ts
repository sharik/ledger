import { expect, test } from '@playwright/test'
import { appUrl, goTab, setupVault, unlock, PASSWORD } from './helpers'

test.describe('setup, unlock & persistence', () => {
  test('setup with demo data boots the new shell with the imported data', async ({ page }) => {
    await setupVault(page)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('currency-badge')).toHaveText('EUR')
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('4')
  })

  test('short or mismatched passwords are rejected at setup', async ({ page }) => {
    await page.goto(appUrl())
    await page.getByTestId('password').fill('short')
    await page.getByTestId('password2').fill('short')
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('unlock-error')).toContainText('at least 8')
    await page.getByTestId('password').fill('long-enough-pw')
    await page.getByTestId('password2').fill('different-pw-123')
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('unlock-error')).toContainText('don’t match')
  })

  test('reload requires the password; wrong one is refused; the right one restores edits', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'settings')
    const target = page.getByTestId('param-srTarget')
    await expect(target).toHaveText('20%')
    await page.getByTestId('param-srTarget-inc').click()
    await expect(target).toHaveText('21%')
    // wait out the debounce so the save commits
    await page.waitForTimeout(1400)

    await page.goto(appUrl())
    await expect(page.getByTestId('password')).toBeVisible()
    await page.getByTestId('password').fill('totally-wrong-pw')
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('unlock-error')).toContainText('doesn’t decrypt')

    await unlock(page)
    await goTab(page, 'settings')
    await expect(page.getByTestId('param-srTarget')).toHaveText('21%')
  })

  test('IndexedDB holds only ciphertext (LGR1 magic, no plaintext merchants)', async ({ page }) => {
    await setupVault(page)
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
      return {
        magic: String.fromCharCode(...bytes.slice(0, 4)),
        leaksMerchant: text.includes('Blue Bottle') || text.includes('Trader Joe'),
        leaksBalance: text.includes('19660'),
      }
    })
    expect(probe.magic).toBe('LGR1')
    expect(probe.leaksMerchant).toBe(false)
    expect(probe.leaksBalance).toBe(false)
  })

  test('lock returns to the unlock screen; unlock resumes', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'settings')
    await page.getByTestId('lock-now').click()
    await expect(page.getByTestId('password')).toBeVisible()
    await unlock(page)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test('empty vault boots to a usable, quiet shell', async ({ page }) => {
    await setupVault(page, { demo: false })
    await goTab(page, 'settings')
    await expect(page.getByTestId('account-count')).toHaveText('0')
  })

  // Issue 5: the taxonomy is editable, and a category in use can't be deleted.
  test('categories can be added and renamed; in-use ones refuse deletion', async ({ page }) => {
    await setupVault(page) // demo seed → Groceries has transactions
    await goTab(page, 'settings')
    await page.getByTestId('cat-new').click()
    await page.getByTestId('cat-name').fill('Pets')
    await page.getByTestId('cat-add').click()

    const pets = page.locator('[data-testid="cat-row"][data-cat-name="Pets"]')
    await expect(pets).toBeVisible()
    // unused → deletable
    await expect(pets.getByTestId('cat-delete')).toBeEnabled()
    // in use → not
    await expect(
      page.locator('[data-testid="cat-row"][data-cat-name="Groceries"]').getByTestId('cat-delete'),
    ).toBeDisabled()

    // rename, then delete the renamed (still unused) category
    await pets.getByTestId('cat-name-btn').click()
    await page.getByTestId('cat-rename').fill('Pet care')
    await page.getByTestId('cat-rename').press('Enter')
    const renamed = page.locator('[data-testid="cat-row"][data-cat-name="Pet care"]')
    await expect(renamed).toBeVisible()
    await renamed.getByTestId('cat-delete').click()
    await expect(renamed).toHaveCount(0)
  })

  test('erase & start fresh wipes the vault after typed confirmation', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'settings')
    await page.getByTestId('erase-confirm').fill('erase')
    await page.getByTestId('erase-go').click()
    // page reloads into setup mode
    await expect(page.getByTestId('password2')).toBeVisible()
  })

  test('change password re-keys: old password stops working', async ({ page }) => {
    await setupVault(page)
    await goTab(page, 'settings')
    await page.getByTestId('change-password').click()
    await page.getByTestId('newpw-1').fill('brand-new-password-1')
    await page.getByTestId('newpw-2').fill('brand-new-password-1')
    await page.getByTestId('newpw-go').click()
    await expect(page.getByTestId('toast')).toContainText('re-keyed')
    await page.waitForTimeout(500)

    await page.goto(appUrl())
    await page.getByTestId('password').fill(PASSWORD)
    await page.getByTestId('unlock-go').click()
    await expect(page.getByTestId('unlock-error')).toBeVisible()
    await unlock(page, 'brand-new-password-1')
  })
})
