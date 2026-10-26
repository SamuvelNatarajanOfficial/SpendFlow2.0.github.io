import { expect, test } from '@playwright/test'
import { addAccount, addTx, PW, PW2, setupVault, unlock, watchErrors } from './helpers'

test('setup: weak, mismatched or unacknowledged passwords are refused; strength guidance is shown', async ({ page }) => {
  const problems = watchErrors(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Protect your data', level: 1 })).toBeVisible()
  const pw = page.getByLabel('Password', { exact: true })
  const pw2 = page.getByLabel('Confirm password')
  const create = page.getByRole('button', { name: 'Create encrypted vault' })

  await pw.fill('password1234')
  await expect(page.getByText(/Strength: Too weak/)).toBeVisible()
  await expect(page.getByText('This is a very common password.')).toBeVisible()
  await pw2.fill('password1234')
  await page.getByLabel(/no password recovery/).check()
  await create.click()
  await expect(page.getByRole('alert').filter({ hasText: 'stronger password' })).toBeVisible()

  await pw.fill(PW)
  await expect(page.getByText(/Strength: (Good|Strong)/)).toBeVisible()
  await pw2.fill(PW + 'x')
  await expect(page.getByText('Passwords do not match')).toBeVisible()
  await create.click()
  await expect(page.getByRole('alert').filter({ hasText: 'do not match' }).first()).toBeVisible()

  await pw2.fill(PW)
  await page.getByLabel(/no password recovery/).uncheck()
  await create.click()
  await expect(page.getByRole('alert').filter({ hasText: 'no password recovery' })).toBeVisible()

  await page.getByLabel(/no password recovery/).check()
  await create.click()
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 30_000 })
  expect(problems).toEqual([])
})

test('lock hides everything; wrong password is generic; unlock restores; nothing secret is stored in the browser', async ({ page }) => {
  const problems = watchErrors(page)
  await setupVault(page)
  await addAccount(page, 'Hidden Savings Account', '4321')
  await page.goto('/#/income')
  await addTx(page, { type: 'income', amount: '98765', category: 'Salary', merchant: 'Secret Employer Pvt Ltd' })
  await expect(page.getByText('Secret Employer Pvt Ltd')).toBeVisible()

  await page.getByRole('button', { name: 'Lock SpendFlow' }).first().click()
  await expect(page.getByRole('heading', { name: 'Unlock SpendFlow', level: 1 })).toBeVisible()
  const html = await page.content()
  for (const secret of ['Secret Employer', 'Hidden Savings', '98,765', 'Salary']) expect(html, `"${secret}" is still in the DOM while locked`).not.toContain(secret)

  // wrong password: a single generic message
  await page.getByLabel('Password', { exact: true }).fill('definitely the wrong password 1!')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect password, or the vault could not be unlocked.')
  await expect(page.getByRole('heading', { name: 'Unlock SpendFlow', level: 1 })).toBeVisible()

  // right password returns to the same page with the data
  await page.getByLabel('Password', { exact: true }).fill(PW)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Secret Employer Pvt Ltd' })).toContainText('₹98,765.00')

  // browser storage contains no password, key or financial data
  const stored = await page.evaluate(async () => {
    const ls = Object.fromEntries(Object.entries(localStorage))
    const ss = Object.fromEntries(Object.entries(sessionStorage))
    const names = (await indexedDB.databases()).map((d) => d.name)
    const open = (n: string) => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    let dump = ''
    for (const n of names) {
      if (!n) continue
      const db = await open(n)
      for (const s of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result) })
        const walk = (v: unknown): string => (v instanceof Uint8Array ? String.fromCharCode(...v) : v && typeof v === 'object' ? Object.values(v).map(walk).join('|') : String(v))
        dump += walk(all)
      }
      db.close()
    }
    return { ls, ss, names, dump, url: location.href }
  })
  expect(Object.keys(stored.ls)).toEqual(['sf-theme']) // only the non-sensitive theme preference
  expect(Object.keys(stored.ss)).toEqual([])
  expect(JSON.stringify(stored)).not.toContain(PW)
  expect(stored.url).not.toContain(PW)
  expect(stored.names).toContain('spendflow-vault')
  expect(stored.names).not.toContain('spendflow') // no plaintext database
  for (const secret of ['Secret Employer', 'Hidden Savings', '98765', 'Salary']) expect(stored.dump, `"${secret}" is readable in IndexedDB`).not.toContain(secret)

  // a reload locks again: the key only ever lived in memory
  await page.reload()
  await unlock(page)
  expect(problems).toEqual([])
})

test('change password: old password stops working, new one opens all data', async ({ page }) => {
  await setupVault(page)
  await addAccount(page, 'Keep Me', '1000')
  await page.goto('/#/settings')
  const form = page.getByRole('form', { name: 'Change password' })
  await form.getByLabel('Current password').fill('wrong current password 1!')
  await form.getByLabel('New password', { exact: true }).fill(PW2)
  await form.getByLabel('Confirm new password').fill(PW2)
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(form.getByRole('alert')).toContainText('current password is incorrect')

  await form.getByLabel('Current password').fill(PW)
  await form.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed. All data was re-encrypted.')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Lock now' }).click()
  await page.getByLabel('Password', { exact: true }).fill(PW)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect password')
  await page.getByLabel('Password', { exact: true }).fill(PW2)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: 'Keep Me' })).toContainText('₹1,000.00')
})

test('auto-lock: after inactivity, and after the app has been hidden (fake clock)', async ({ page }) => {
  await page.clock.install()
  await setupVault(page)
  const locked = page.getByRole('heading', { name: 'Unlock SpendFlow', level: 1 })

  // inactivity: default 5 minutes
  await page.clock.fastForward('04:00')
  await expect(locked).toBeHidden()
  await page.mouse.click(10, 10) // activity resets the timer
  await page.clock.fastForward('04:00')
  await expect(locked).toBeHidden()
  await page.clock.fastForward('02:00')
  await expect(locked).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(PW)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 30_000 })

  const setVisibility = (state: 'hidden' | 'visible') =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)

  // hidden for less than the 60s grace period, then visible again: stays unlocked (no data loss from a quick app switch)
  await setVisibility('hidden')
  await page.clock.fastForward('00:30')
  await setVisibility('visible')
  await page.clock.fastForward('00:40')
  await expect(locked).toBeHidden()

  // hidden for longer than the grace period: locks
  await setVisibility('hidden')
  await page.clock.fastForward('01:10')
  await expect(locked).toBeVisible()
})

test('production CSP is enforced: inline scripts are blocked, only same-origin resources are allowed', async ({ page }) => {
  await page.goto('/')
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/)
  expect(csp).toContain("connect-src 'self'")
  expect(csp).toContain("object-src 'none'")
  const violated = await page.evaluate(
    () =>
      new Promise<{ ran: boolean; violation: string | null }>((resolve) => {
        let violation: string | null = null
        document.addEventListener('securitypolicyviolation', (e) => (violation = e.violatedDirective))
        const s = document.createElement('script')
        s.textContent = 'window.__injected = true'
        document.head.appendChild(s)
        setTimeout(() => resolve({ ran: (window as unknown as { __injected?: boolean }).__injected === true, violation }), 200)
      }),
  )
  expect(violated.ran).toBe(false)
  expect(violated.violation).toMatch(/script-src/)
  // no third-party origins are referenced by the page
  const external = await page.evaluate(() => [...document.querySelectorAll('[src],[href]')].map((e) => e.getAttribute('src') ?? e.getAttribute('href') ?? '').filter((u) => /^(https?:)?\/\//.test(u)))
  expect(external).toEqual([])
})

test('user-entered content is rendered as text (no XSS)', async ({ page }) => {
  await setupVault(page)
  const evilAccount = '<img src=x onerror="window.__xss=1">'
  await addAccount(page, evilAccount, '10')
  await page.goto('/#/expenses')
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add transaction' })
  await dlg.getByLabel('Amount (₹)').fill('5')
  await dlg.getByLabel('Category').selectOption({ label: 'Groceries' })
  await dlg.getByLabel('Merchant').fill('<script>window.__xss=2</script><b>bold</b>')
  await dlg.getByLabel('Notes').fill('"><svg onload=window.__xss=3>')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('tx-row').filter({ hasText: '<script>window.__xss=2</script><b>bold</b>' })).toBeVisible()
  await page.goto('/#/accounts')
  await expect(page.getByRole('article', { name: evilAccount })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  expect(await page.locator('img[src="x"], main svg[onload], main b').count()).toBe(0)
})
