import { expect, type Page } from '@playwright/test'

export const PW = 'e2e correct horse battery staple 42!'
export const PW2 = 'e2e another long passphrase for tests 77?'

/** Collects console errors, page errors and failed requests so tests can assert the app is clean. */
export function watchErrors(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`)
  })
  return problems
}

/** First run: create the encrypted vault. Leaves the app unlocked on the dashboard. */
export async function setupVault(page: Page, password = PW, path = '/') {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Protect your data', level: 1 })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByLabel(/no password recovery/).check()
  await page.getByRole('button', { name: 'Create encrypted vault' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 30_000 })
}

/** After a full reload the vault is locked again: unlock it. */
export async function unlock(page: Page, password = PW) {
  await expect(page.getByRole('heading', { name: 'Unlock SpendFlow', level: 1 })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('navigation', { name: /Main|Mobile/ }).first()).toBeVisible({ timeout: 30_000 })
}

export async function addAccount(page: Page, name: string, opening: string) {
  await page.goto('/#/accounts')
  await page.getByRole('button', { name: 'Add account' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add account' })
  await dlg.getByLabel('Account name').fill(name)
  await dlg.getByLabel('Opening balance (₹)').fill(opening)
  await dlg.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('article', { name })).toBeVisible()
}

export async function addTx(page: Page, o: { type: 'income' | 'expense'; amount: string; category: string; merchant?: string }) {
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add transaction' })
  await dlg.getByRole('radio', { name: o.type }).check({ force: true })
  await dlg.getByLabel('Amount (₹)').fill(o.amount)
  await dlg.getByLabel('Category').selectOption({ label: o.category })
  if (o.merchant) await dlg.getByLabel(/Merchant|Source/).fill(o.merchant)
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dlg).toBeHidden()
}
