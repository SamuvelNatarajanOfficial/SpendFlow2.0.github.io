import { db } from './db'
import { accounts, budgets, goals, loans, transactions, updateSettings, ALL_TABLES } from './repo'
import { addMonths, monthOf, parts, makeDate } from '@/lib/dates'
import { builtInCategoryId } from './defaults'
import type { PaymentMethod } from '@/types'

const rs = (n: number) => Math.round(n * 100)

/** Loads a small, clearly flagged (isSample) dataset relative to `today`. Safe to remove with removeSampleData(). */
export async function loadSampleData(today: string): Promise<void> {
  const cat = (kind: string, name: string) => builtInCategoryId(kind, name)
  const savings = await accounts.create({ name: 'Sample Savings Bank', type: 'savings', openingBalance: rs(85000), isSample: true })
  const cash = await accounts.create({ name: 'Sample Cash Wallet', type: 'cash', openingBalance: rs(4000), isSample: true })
  const upi = await accounts.create({ name: 'Sample UPI', type: 'upi', openingBalance: rs(6000), isSample: true })

  const thisMonth = monthOf(today)
  const day = (monthsBack: number, d: number) => {
    const base = addMonths(`${thisMonth}-01`, -monthsBack)
    return makeDate(parts(base).y, parts(base).m, d)
  }
  const todayDay = parts(today).d
  const items: Array<[number, number, 'income' | 'expense', string, number, string, string, string, PaymentMethod, boolean?]> = []
  for (let back = 0; back < 4; back++) {
    const lim = (d: number) => (back === 0 ? Math.min(d, todayDay) : d)
    items.push([back, 1, 'income', 'Salary', 92000, 'Acme Technologies', savings.id, 'Monthly salary', 'netbanking'])
    if (back % 2 === 1) items.push([back, 12, 'income', 'Freelance', 14000, 'Side project', savings.id, '', 'upi'])
    items.push([back, lim(2), 'expense', 'Rent', 22000, 'Landlord', savings.id, 'Monthly rent', 'netbanking', true])
    items.push([back, lim(4), 'expense', 'Groceries', 3800 + back * 220, 'BigBasket', upi.id, '', 'upi', true])
    items.push([back, lim(9), 'expense', 'Groceries', 2900, 'Local market', cash.id, '', 'cash', true])
    items.push([back, lim(6), 'expense', 'Utilities', 2100 + back * 90, 'Electricity board', upi.id, 'Electricity & internet', 'upi', true])
    items.push([back, lim(8), 'expense', 'Food & Dining', 2600 + back * 300, 'Restaurants', upi.id, '', 'upi', false])
    items.push([back, lim(10), 'expense', 'Fuel', 3200, 'Fuel station', upi.id, '', 'upi', true])
    items.push([back, lim(11), 'expense', 'Subscriptions', 649, 'Streaming', savings.id, 'Monthly plan', 'card', false])
    items.push([back, lim(14), 'expense', 'Shopping', 4500 - back * 600, 'Online store', savings.id, '', 'card', false])
    items.push([back, lim(15), 'expense', 'Healthcare', back === 2 ? 3500 : 800, 'Pharmacy', cash.id, '', 'cash', true])
  }
  for (const [back, d, type, c, amt, merchant, accountId, notes, pm, essential] of items) {
    const date = day(back, d)
    if (date > today) continue
    await transactions.create({
      type, amount: rs(amt), date, accountId, categoryId: cat(type, c), paymentMethod: pm, merchant: merchant || undefined, notes: notes || undefined,
      essential: type === 'expense' ? !!essential : undefined, recurring: c === 'Subscriptions' || c === 'Rent' || c === 'Salary' ? 'monthly' : undefined,
      isSample: true,
    })
  }
  // an own-account transfer: must not count as income or expense
  await transactions.create({ type: 'transfer', amount: rs(5000), date: day(0, 1) > today ? today : day(0, 1), accountId: savings.id, toAccountId: cash.id, paymentMethod: 'other', notes: 'Cash withdrawal', isSample: true })

  const sampleBudgets: [string, number][] = [['Groceries', 8000], ['Food & Dining', 4000], ['Fuel', 3500], ['Shopping', 4000], ['Subscriptions', 700]]
  for (const [c, amt] of sampleBudgets) {
    await budgets.upsert(cat('expense', c), thisMonth, rs(amt), true)
    await budgets.upsert(cat('expense', c), addMonths(`${thisMonth}-01`, -1).slice(0, 7), rs(amt), true)
  }

  const homeStart = addMonths(`${thisMonth}-05`, -6)
  const home = await loans.create({
    name: 'Sample Home Loan', lender: 'Sample Bank', principal: rs(2500000), outstanding: rs(2500000), annualRate: 8.5, emi: rs(24100), dueDay: 5,
    startDate: homeStart, tenureMonths: 240, endDate: addMonths(homeStart, 240), accountId: savings.id, isSample: true,
  })
  const personal = await loans.create({
    name: 'Sample Personal Loan', lender: 'Sample Finance', principal: rs(200000), outstanding: rs(200000), annualRate: 12, emi: rs(11122), dueDay: 15,
    startDate: addMonths(`${thisMonth}-15`, -3), tenureMonths: 20, endDate: addMonths(`${thisMonth}-15`, 17), accountId: savings.id, isSample: true,
  })
  for (let back = 6; back >= 0; back--) {
    if (day(back, 5) > today) continue
    await loans.recordPayment({ loanId: home.id, date: day(back, 5), kind: 'emi', amount: rs(24100), accountId: savings.id, isSample: true })
  }
  for (let back = 3; back >= 0; back--) {
    if (day(back, 15) > today) continue
    await loans.recordPayment({ loanId: personal.id, date: day(back, 15), kind: 'emi', amount: rs(11122), accountId: savings.id, isSample: true })
  }

  await goals.create({ name: 'Emergency fund (6 months)', kind: 'emergency', target: rs(300000), saved: rs(60000), accountId: savings.id, targetDate: addMonths(today, 18), isSample: true })
  await goals.create({ name: 'Laptop upgrade', kind: 'purchase', target: rs(90000), saved: rs(25000), accountId: savings.id, targetDate: addMonths(today, 6), isSample: true })
  await goals.create({ name: 'Become debt-free', kind: 'debt-free', target: 0, saved: 0, targetDate: addMonths(today, 120), isSample: true })
  await updateSettings({ sampleLoaded: true })
}

export async function countSample(): Promise<number> {
  let n = 0
  for (const t of ALL_TABLES()) if (t.name !== 'settings') n += await t.filter((r: { isSample?: boolean }) => !!r.isSample).count()
  return n
}

/**
 * Removes only flagged sample records. A sample account/loan that now has REAL (non-sample)
 * records attached is kept (and un-flagged) so real data is never orphaned or deleted.
 */
export async function removeSampleData(): Promise<void> {
  await db.transaction('rw', ALL_TABLES(), async () => {
    const realTx = await db.transactions.filter((t) => !t.isSample).toArray()
    const realPays = await db.loanPayments.filter((p) => !p.isSample).toArray()
    const keepAccounts = new Set<string>()
    for (const t of realTx) {
      keepAccounts.add(t.accountId)
      if (t.toAccountId) keepAccounts.add(t.toAccountId)
    }
    const sampleLoans = await db.loans.filter((l) => !!l.isSample).toArray()
    const keepLoans = new Set(realPays.map((p) => p.loanId))
    for (const l of sampleLoans) if (l.accountId && keepAccounts.has(l.accountId)) keepAccounts.add(l.accountId)
    for (const l of sampleLoans) if (keepLoans.has(l.id) && l.accountId) keepAccounts.add(l.accountId)

    await db.transactions.filter((t) => !!t.isSample).delete()
    await db.loanPayments.filter((p) => !!p.isSample).delete()
    await db.budgets.filter((b) => !!b.isSample).delete()
    await db.goals.filter((g) => !!g.isSample).delete()
    for (const l of sampleLoans) {
      if (keepLoans.has(l.id)) await db.loans.put({ ...l, isSample: false })
      else await db.loans.delete(l.id)
    }
    for (const a of await db.accounts.filter((x) => !!x.isSample).toArray()) {
      if (keepAccounts.has(a.id)) await db.accounts.put({ ...a, isSample: false })
      else await db.accounts.delete(a.id)
    }
  })
  await updateSettings({ sampleLoaded: false })
}
