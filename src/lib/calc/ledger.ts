import type { Account, Category, DateRange, Frequency, Paise, Transaction } from '@/types'
import { addDays, addMonths, inRange, isValidDate } from '../dates'

/** Transfers between own accounts are NEVER income or expense. */
export const isIncome = (t: Transaction) => t.type === 'income'
export const isExpense = (t: Transaction) => t.type === 'expense'

export function filterByRange(txs: Transaction[], range: DateRange): Transaction[] {
  return txs.filter((t) => isValidDate(t.date) && inRange(t.date, range))
}

export function sumIncome(txs: Transaction[]): Paise {
  return txs.reduce((s, t) => (isIncome(t) ? s + t.amount : s), 0)
}
export function sumExpense(txs: Transaction[]): Paise {
  return txs.reduce((s, t) => (isExpense(t) ? s + t.amount : s), 0)
}

export function netSavings(income: Paise, expense: Paise): Paise {
  return income - expense
}

/** Savings rate in percent of income. null when there is no income (undefined rate). */
export function savingsRate(income: Paise, expense: Paise): number | null {
  if (income <= 0) return null
  return ((income - expense) / income) * 100
}

/**
 * Calculated balance = opening + income - expense + transfers in - transfers out.
 * Each transaction touches each account at most once; a transfer moves money
 * (out of `accountId`, into `toAccountId`) without altering income/expense totals.
 * Optionally restricted to `asOf` (inclusive).
 */
export function accountBalance(account: Account, txs: Transaction[], asOf?: string): Paise {
  let bal = account.openingBalance
  for (const t of txs) {
    if (asOf && t.date > asOf) continue
    if (t.type === 'income' && t.accountId === account.id) bal += t.amount
    else if (t.type === 'expense' && t.accountId === account.id) bal -= t.amount
    else if (t.type === 'transfer') {
      if (t.accountId === account.id) bal -= t.amount
      if (t.toAccountId === account.id) bal += t.amount
    }
  }
  return bal
}

export function totalBalance(accounts: Account[], txs: Transaction[]): Paise {
  return accounts.filter((a) => !a.archived).reduce((s, a) => s + accountBalance(a, txs), 0)
}

/** Difference between the bank's reported balance and our calculated balance on the same date. */
export function reconciliationDiff(account: Account, txs: Transaction[]): Paise | null {
  if (!account.actualBalance) return null
  return account.actualBalance.amount - accountBalance(account, txs, account.actualBalance.asOf)
}

export interface CategoryTotal {
  categoryId: string
  name: string
  color: string
  amount: Paise
}

export function expenseByCategory(txs: Transaction[], categories: Category[]): CategoryTotal[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const acc = new Map<string, Paise>()
  for (const t of txs) {
    if (!isExpense(t)) continue
    const key = t.categoryId && byId.has(t.categoryId) ? t.categoryId : '__none'
    acc.set(key, (acc.get(key) ?? 0) + t.amount)
  }
  return [...acc.entries()]
    .map(([id, amount]) => {
      const c = byId.get(id)
      return { categoryId: id, name: c?.name ?? 'Uncategorised', color: c?.color ?? '#94a3b8', amount }
    })
    .sort((a, b) => b.amount - a.amount)
}

export function essentialSplit(txs: Transaction[]): { essential: Paise; discretionary: Paise } {
  let essential = 0, discretionary = 0
  for (const t of txs) {
    if (!isExpense(t)) continue
    if (t.essential) essential += t.amount
    else discretionary += t.amount
  }
  return { essential, discretionary }
}

export function searchTx(txs: Transaction[], q: string, cats: Map<string, Category>, accs: Map<string, Account>): Transaction[] {
  const s = q.trim().toLowerCase()
  if (!s) return txs
  return txs.filter((t) =>
    [t.merchant, t.notes, cats.get(t.categoryId ?? '')?.name, accs.get(t.accountId)?.name, String(t.amount / 100)]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(s)),
  )
}

export function sortTx(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)))
}

export function nextOccurrence(date: string, freq: Frequency): string {
  if (freq === 'weekly') return addDays(date, 7)
  if (freq === 'yearly') return addMonths(date, 12)
  return addMonths(date, 1)
}

export interface UpcomingBill {
  key: string
  title: string
  amount: Paise
  dueDate: string
  type: 'income' | 'expense'
}

/**
 * Upcoming recurring items. A "series" is recurring transactions sharing
 * type + category + merchant + amount; the next due date is derived from the
 * latest entry in the series. Loan-generated expenses are excluded (loans are tracked separately).
 */
export function upcomingRecurring(txs: Transaction[], cats: Map<string, Category>, today: string, horizonDays = 30): UpcomingBill[] {
  const latest = new Map<string, Transaction>()
  for (const t of txs) {
    if (!t.recurring || t.type === 'transfer' || t.loanPaymentId) continue
    const key = `${t.type}|${t.categoryId ?? ''}|${(t.merchant ?? '').toLowerCase()}|${t.amount}|${t.recurring}`
    const cur = latest.get(key)
    if (!cur || t.date > cur.date) latest.set(key, t)
  }
  const horizon = addDays(today, horizonDays)
  const out: UpcomingBill[] = []
  for (const [key, t] of latest) {
    const due = nextOccurrence(t.date, t.recurring!)
    // overdue items stay visible until the next occurrence is recorded
    if (due > horizon) continue
    out.push({
      key,
      title: t.merchant || cats.get(t.categoryId ?? '')?.name || 'Recurring',
      amount: t.amount,
      dueDate: due,
      type: t.type as 'income' | 'expense',
    })
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}
