import { expect, test } from '@playwright/test'
import { addAccount, addTx, setupVault, unlock, watchErrors } from './helpers'

test('narrow mobile: no horizontal scroll, bottom nav and add button work', async ({ page }) => {
  const problems = watchErrors(page)
  await setupVault(page)
  await addAccount(page, 'Phone Wallet', '500')
  await addTx(page, { type: 'expense', amount: '120', category: 'Food & Dining', merchant: 'Chai' })

  for (const route of ['/', '/income', '/expenses', '/accounts', '/budgets', '/loans', '/goals', '/reports', '/settings']) {
    await page.goto(`/#${route}`)
    await page.waitForTimeout(300)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(1)
  }
  await page.goto('/#/')
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Mobile' }).getByRole('button', { name: 'More' }).click()
  await page.getByRole('dialog', { name: 'More navigation' }).getByRole('link', { name: 'Loans & EMI' }).click()
  await expect(page.getByRole('heading', { name: 'Loans & EMI', level: 1 })).toBeVisible()
  expect(problems).toEqual([])
})

test('app works offline after first load (service worker); data stays encrypted and unlockable offline', async ({ page, context }) => {
  await setupVault(page)
  await addAccount(page, 'Phone Wallet', '500')
  await addTx(page, { type: 'expense', amount: '120', category: 'Food & Dining', merchant: 'Chai' })
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload() // ensure the SW controls the page and caches are filled
  await page.waitForTimeout(500)
  await context.setOffline(true)
  await page.reload()
  await unlock(page) // offline reload shows the lock screen first
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
  await page.goto('/#/expenses')
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Chai' })).toBeVisible() // data persisted locally
  await context.setOffline(false)
})
