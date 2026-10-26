import { expect, test as base, type Page } from '@playwright/test'
import { addAccount, addTx, watchErrors } from './helpers'

// One browser context for the whole serial flow so IndexedDB data carries from test to test (like a real user session).
let shared: Page
const test = base.extend<{ page: Page }>({ page: async ({ browser: _b }, use) => { await use(shared) } })
base.describe.configure({ mode: 'serial' })
base.beforeAll(async ({ browser }) => {
  shared = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })).newPage()
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

test('backup export, wipe, restore', async ({ page }) => {
  await page.goto('/#/settings')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download full backup/ }).click()])
  const path = await dl.path()
  expect(dl.suggestedFilename()).toMatch(/^spendflow-backup-\d{4}-\d{2}-\d{2}\.json$/)
  await expect(page.getByText(/Last backup:/)).not.toContainText('never')

  // wipe with strong confirmation
  await page.getByRole('button', { name: 'Delete all data…' }).click()
  const c = page.getByRole('dialog', { name: 'Delete ALL data?' })
  await expect(c.getByRole('button', { name: 'Delete everything' })).toBeDisabled()
  await c.getByLabel(/Type DELETE/).fill('DELETE')
  await c.getByRole('button', { name: 'Delete everything' }).click()
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row')).toHaveCount(0)

  // invalid file -> clear errors, nothing changes
  await page.goto('/#/settings')
  await page.getByLabel('Backup file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":true}') })
  await expect(page.getByTestId('restore-preview')).toContainText('not a SpendFlow backup')

  // valid file -> preview -> merge
  await page.getByLabel('Backup file').setInputFiles(path)
  const prev = page.getByTestId('restore-preview')
  await expect(prev).toContainText('Valid SpendFlow backup')
  await prev.getByRole('button', { name: 'Merge backup…' }).click()
  await page.getByRole('dialog', { name: 'Merge backup into current data?' }).getByRole('button', { name: 'Merge' }).click()
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row')).toHaveCount(2) // grocery + EMI
  await page.goto('/#/income')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Acme Corp' })).toContainText('₹50,000.00')
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: 'Main Bank' })).toBeVisible()
  await page.goto('/#/loans')
  await expect(page.getByRole('article', { name: 'Car Loan' })).toContainText('₹92,115.12')
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
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('sample data loads, every page renders without errors, sample can be removed', async ({ page }) => {
  const problems = watchErrors(page)
  await page.goto('/#/settings')
  await page.getByRole('button', { name: 'Load sample data' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Load sample data' }).click()
  await expect(page.getByText('Sample data loaded')).toBeVisible()
  for (const [route, heading] of [['/', 'Dashboard'], ['/income', 'Income'], ['/expenses', 'Expenses'], ['/accounts', 'Accounts'], ['/budgets', 'Budgets'], ['/loans', 'Loans & EMI'], ['/goals', 'Savings & goals'], ['/reports', 'Reports'], ['/settings', 'Settings']] as const) {
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
