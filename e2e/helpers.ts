import { expect, type Page } from '@playwright/test'

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
