import fs from 'node:fs'
import { expect, test as base, type Page } from '@playwright/test'
import { addAccount, addTx, PW, PW2, setupVault, unlock, watchErrors } from './helpers'

// One browser context for the whole serial flow so IndexedDB data carries from test to test (like a real user session).
let shared: Page
let pw = PW // the CURRENT vault password (changes when a test creates a new vault)
const test = base.extend<{ page: Page }>({ page: async ({ browser: _b }, use) => { await use(shared) } })
base.describe.configure({ mode: 'serial' })
base.beforeAll(async ({ browser }) => {
  shared = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()
  await setupVault(shared) // first run: create the encrypted vault
})
base.afterAll(async () => { await shared.context().close() })

test('income, expense, budget and persistence across reload', async ({ page }) => {
  const problems = watchErrors(page)
  await addAccount(page, 'Main Bank', '10000')

  // validation: empty amount is rejected with a clear message
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add transaction' })
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dlg.getByText('Enter an amount greater than zero, up to 2 decimals')).toBeVisible()
  await expect(dlg.getByText('Choose a category')).toBeVisible()
  await dlg.getByRole('button', { name: 'Cancel' }).click()

  await addTx(page, { type: 'income', amount: '50000', category: 'Salary', merchant: 'Acme Corp' })
  await addTx(page, { type: 'expense', amount: '1234.50', category: 'Groceries', merchant: 'Local Mart' })

  await page.goto('/#/income')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Acme Corp' })).toContainText('₹50,000.00')
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Local Mart' })).toContainText('₹1,234.50')

  await page.goto('/#/')
  await expect(page.getByText('₹58,765.50').first()).toBeVisible() // 10,000 + 50,000 - 1,234.50

  // budget
  await page.goto('/#/budgets')
  await page.getByRole('button', { name: 'Add budget' }).first().click()
  const b = page.getByRole('dialog', { name: 'Add budget' })
  await b.getByLabel('Category').selectOption({ label: 'Groceries' })
  await b.getByLabel(/Monthly budget/).fill('5000')
  await b.getByRole('button', { name: 'Create budget' }).click()
  const card = page.getByRole('article', { name: 'Groceries budget' })
  await expect(card).toContainText('₹1,234.50')
  await expect(card).toContainText('₹3,765.50 left')

  // overspend -> over-budget warning
  await addTx(page, { type: 'expense', amount: '4000', category: 'Groceries' })
  await expect(card).toContainText('Over by ₹234.50')
  await expect(card.getByRole('alert')).toContainText('Over budget')

  // records survive a refresh and navigation
  await page.reload()
  await unlock(page, pw) // a reload locks the vault: the key only ever lived in memory
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row')).toHaveCount(2)
  expect(problems).toEqual([])
})

test('edit and delete (with confirmation) an expense', async ({ page }) => {
  await page.goto('/#/expenses')
  await page.getByRole('button', { name: 'Edit Local Mart' }).click()
  const dlg = page.getByRole('dialog', { name: 'Edit transaction' })
  await dlg.getByLabel('Amount (₹)').fill('1000')
  await dlg.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Local Mart' })).toContainText('₹1,000.00')

  await page.getByRole('button', { name: 'Delete Local Mart' }).click()
  const c = page.getByRole('dialog', { name: 'Delete this expense?' })
  await c.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Local Mart' })).toHaveCount(1) // cancel keeps it
  await page.getByRole('button', { name: 'Delete Local Mart' }).click()
  await page.getByRole('dialog', { name: 'Delete this expense?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Local Mart' })).toHaveCount(0)
})

test('transfer is not income or expense', async ({ page }) => {
  await addAccount(page, 'Wallet', '0')
  await page.getByRole('button', { name: 'Transfer' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add transaction' })
  await dlg.getByLabel('Amount (₹)').fill('2000')
  await dlg.getByLabel('From account').selectOption({ label: 'Main Bank' })
  await dlg.getByLabel('To account').selectOption({ label: 'Wallet' })
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('article', { name: 'Wallet' })).toContainText('₹2,000.00')
  await page.goto('/#/income')
  await expect(page.getByText('Nothing matches').or(page.getByText('Acme Corp'))).toBeVisible()
  await expect(page.getByTestId('tx-row')).toHaveCount(1) // only the salary
})

test('loan: record EMI reduces principal only, creates one expense', async ({ page }) => {
  await page.goto('/#/loans')
  await page.getByRole('button', { name: 'Add loan' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add loan' })
  await dlg.getByLabel('Loan name').fill('Car Loan')
  await dlg.getByLabel('Lender').fill('HDFC')
  await dlg.getByLabel('Original principal (₹)').fill('100000')
  await dlg.getByLabel('Annual interest rate (%)').fill('12')
  await dlg.getByLabel('Tenure (months)').fill('12')
  await dlg.getByRole('button', { name: 'Calc' }).click()
  await expect(dlg.getByLabel('EMI (₹)')).toHaveValue('8884.88')
  await dlg.getByRole('button', { name: 'Add loan' }).click()

  await page.getByRole('button', { name: 'Record EMI for Car Loan' }).click()
  const pay = page.getByRole('dialog', { name: /Record EMI payment/ })
  await expect(pay).toContainText('Interest ₹1,000.00') // 1% of 1,00,000
  await expect(pay).toContainText('Principal ₹7,884.88')
  await pay.getByLabel('Paid from account').selectOption({ label: 'Main Bank' })
  await pay.getByRole('button', { name: 'Record payment' }).click()
  const card = page.getByRole('article', { name: 'Car Loan' })
  await expect(card).toContainText('₹92,115.12') // 1,00,000 - 7,884.88

  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Loan payment' })).toHaveCount(1)
  await page.goto('/#/loans')
  await page.getByRole('link', { name: 'Details of Car Loan' }).click()
  await expect(page.getByText('Payment history (1)')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Estimated amortisation schedule' })).toBeVisible()
})

test('encrypted backup: export, wipe everything, new vault, restore (replace)', async ({ page }) => {
  const BPW = 'e2e backup passphrase long enough 55!'
  await page.goto('/#/settings')
  const form = page.getByRole('form', { name: 'Create encrypted backup' })

  // a weak or mismatched backup password is refused
  await form.getByLabel('Backup password', { exact: true }).fill('short')
  await form.getByLabel('Confirm backup password').fill('short')
  await form.getByRole('button', { name: /Download encrypted backup/ }).click()
  await expect(form.getByRole('alert')).toContainText('stronger')

  await form.getByLabel('Backup password', { exact: true }).fill(BPW)
  await form.getByLabel('Confirm backup password').fill(BPW)
  const [dl] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: /Download encrypted backup/ }).click()])
  const path = await dl.path()
  expect(dl.suggestedFilename()).toMatch(/^spendflow-backup-\d{4}-\d{2}-\d{2}\.sfbackup\.json$/)
  const content = fs.readFileSync(path, 'utf8')
  for (const secret of ['Acme Corp', 'Main Bank', 'Local Mart', 'Car Loan', 'HDFC', 'Groceries', 'Salary']) expect(content, `"${secret}" is readable in the backup file`).not.toContain(secret)
  expect(JSON.parse(content)).toMatchObject({ format: 'spendflow-encrypted-backup', formatVersion: 1, cipher: 'AES-256-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256' } })
  await expect(page.getByText(/Last backup:/)).not.toContainText('never')

  // wipe everything: the vault (and its password) is destroyed and the app returns to first-time setup
  await page.getByRole('button', { name: 'Delete all data…' }).click()
  const c = page.getByRole('dialog', { name: 'Delete ALL data?' })
  await expect(c.getByRole('button', { name: 'Delete everything' })).toBeDisabled()
  await c.getByLabel(/Type DELETE/).fill('DELETE')
  await c.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page.getByRole('heading', { name: 'Protect your data', level: 1 })).toBeVisible()
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain('spendflow')

  // "another device": brand-new vault with a DIFFERENT password
  pw = PW2
  await setupVault(page, PW2)
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row')).toHaveCount(0)
  await page.goto('/#/settings')

  // a damaged file is rejected before any password prompt can change anything
  await page.getByLabel('Backup file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":true}') })
  await expect(page.getByTestId('restore-preview')).toContainText('not a SpendFlow backup')

  // a tampered ciphertext fails authentication with a generic message
  const tampered = JSON.parse(content)
  const ct = Buffer.from(tampered.ciphertext, 'base64')
  ct[Math.floor(ct.length / 2)] ^= 1
  tampered.ciphertext = ct.toString('base64')
  await page.getByLabel('Backup file').setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) })
  const prev = page.getByTestId('restore-preview')
  await prev.getByLabel('Backup password').fill(BPW)
  await prev.getByRole('button', { name: 'Decrypt and preview' }).click()
  await expect(prev).toContainText('wrong, or the file was modified or corrupted')

  // the real file: header preview shows no financial details; wrong password fails; right password succeeds
  await page.getByLabel('Backup file').setInputFiles(path)
  await expect(prev).toContainText('Encrypted SpendFlow backup v1')
  await expect(prev).not.toContainText('Main Bank')
  await prev.getByLabel('Backup password').fill('not the right password 99!')
  await prev.getByRole('button', { name: 'Decrypt and preview' }).click()
  await expect(prev).toContainText('wrong, or the file was modified or corrupted')
  await prev.getByLabel('Backup password').fill(BPW)
  await prev.getByRole('button', { name: 'Decrypt and preview' }).click()
  await expect(prev).toContainText('Authenticated and validated')

  // replace requires explicit typed confirmation
  await prev.getByRole('radio', { name: /Replace/ }).check()
  await prev.getByRole('button', { name: 'Replace data…' }).click()
  const rc = page.getByRole('dialog', { name: 'Replace ALL current data?' })
  await expect(rc.getByRole('button', { name: 'Replace everything' })).toBeDisabled()
  await rc.getByLabel(/Type REPLACE/).fill('REPLACE')
  await rc.getByRole('button', { name: 'Replace everything' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Restore complete' })).toBeVisible()

  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row')).toHaveCount(2) // grocery + EMI
  await page.goto('/#/income')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Acme Corp' })).toContainText('₹50,000.00')
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: 'Main Bank' })).toBeVisible()
  await page.goto('/#/loans')
  await expect(page.getByRole('article', { name: 'Car Loan' })).toContainText('₹92,115.12')

  // the restored vault is still protected by the NEW password and nothing readable is stored
  await page.reload()
  await unlock(page, PW2)
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: 'Main Bank' })).toBeVisible()
})

test('CSV import shows preview, errors and duplicates', async ({ page }) => {
  await page.goto('/#/settings')
  const csv = ['date,type,amount,category,account,merchant', '2025-01-05,expense,250,Groceries,Main Bank,Shop A', '2025-01-05,expense,250,Groceries,Main Bank,Shop A', '2025-02-30,expense,9,Groceries,Main Bank,bad', '2025-01-06,expense,75.5,Fuel,Main Bank,Pump'].join('\n')
  await page.getByLabel('CSV file').setInputFiles({ name: 'tx.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  const prev = page.getByTestId('csv-preview')
  await expect(prev).toContainText('2 ready')
  await expect(prev).toContainText('1 duplicate')
  await expect(prev).toContainText('1 errors')
  await expect(prev).toContainText('Invalid date')
  await prev.getByRole('button', { name: /Import 2 transaction/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click()
  await page.goto('/#/expenses')
  await page.getByRole('button', { name: 'This year' }).click()
  await page.getByRole('button', { name: 'Custom' }).click()
  await page.getByLabel('From date').fill('2025-01-01')
  await page.getByLabel('To date').fill('2025-01-31')
  await expect(page.getByTestId('tx-row')).toHaveCount(2)
})

test('theme toggle persists and routes survive refresh', async ({ page }) => {
  await page.goto('/#/reports')
  await page.reload()
  await unlock(page, pw)
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark') // theme applies even on the lock screen
  await unlock(page, pw)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('sample data loads, every page renders without errors, sample can be removed', async ({ page }) => {
  const problems = watchErrors(page)
  await page.goto('/#/settings')
  await page.getByRole('button', { name: 'Load sample data' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Load sample data' }).click()
  await expect(page.getByText('Sample data loaded')).toBeVisible()
  for (const [route, heading] of [['/', 'Dashboard'], ['/income', 'Income'], ['/expenses', 'Expenses'], ['/accounts', 'Accounts'], ['/budgets', 'Budgets'], ['/recurring', 'Recurring'], ['/loans', 'Loans & EMI'], ['/goals', 'Savings & goals'], ['/reports', 'Reports'], ['/settings', 'Settings']] as const) {
    await page.goto(`/#${route}`)
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await page.waitForTimeout(250)
  }
  await page.goto('/#/settings')
  await page.getByRole('button', { name: 'Remove sample data' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove sample data' }).click()
  await expect(page.getByText('Sample data removed')).toBeVisible()
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: 'Main Bank' })).toBeVisible()
  await expect(page.getByRole('article', { name: /Sample/ })).toHaveCount(0)
  expect(problems).toEqual([])
})

test('recurring: overdue item is recorded with one click, then stopped', async ({ page }) => {
  const problems = watchErrors(page)
  const d = new Date()
  const twoBack = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 15))
  const date = twoBack.toISOString().slice(0, 10)

  await page.goto('/#/expenses')
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add transaction' })
  await dlg.getByLabel('Amount (₹)').fill('799')
  await dlg.getByLabel('Date').fill(date)
  await dlg.getByLabel('Category').selectOption({ label: 'Subscriptions' })
  await dlg.getByLabel('Merchant').fill('Gym Club')
  await dlg.getByLabel('Repeats').selectOption('monthly')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dlg).toBeHidden()

  await page.goto('/#/recurring')
  const row = page.getByTestId('recurring-row').filter({ hasText: 'Gym Club' })
  await expect(row).toContainText('overdue')
  await expect(row).toContainText('1 recorded')
  await expect(row).toContainText('₹799.00')

  await row.getByRole('button', { name: /^Record Gym Club/ }).click()
  await expect(page.getByText(/Expense recorded: Gym Club/)).toBeVisible()
  await expect(row).toContainText('2 recorded')

  // survives a reload (it is stored data, not UI state)
  await page.reload()
  await unlock(page, pw)
  await expect(page.getByTestId('recurring-row').filter({ hasText: 'Gym Club' })).toContainText('2 recorded')

  // stopping needs confirmation; Cancel keeps it
  await row.getByRole('button', { name: 'Stop recurring Gym Club' }).click()
  const c = page.getByRole('dialog', { name: 'Stop this recurring item?' })
  await c.getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Stop recurring Gym Club' }).click()
  await page.getByRole('dialog', { name: 'Stop this recurring item?' }).getByRole('button', { name: 'Stop recurring' }).click()
  await expect(page.getByTestId('recurring-row').filter({ hasText: 'Gym Club' })).toHaveCount(0)

  // the two recorded transactions remain
  await page.goto('/#/expenses')
  await page.getByLabel('Search Expenses').fill('Gym Club')
  await page.getByRole('button', { name: 'Custom' }).click()
  await page.getByLabel('From date').fill('2000-01-01')
  await page.getByLabel('To date').fill('2100-01-01')
  await expect(page.getByTestId('tx-row')).toHaveCount(2)
  expect(problems).toEqual([])
})
