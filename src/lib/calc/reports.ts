import type { DateRange, Loan, LoanPayment, Paise, Transaction } from '@/types'
import { addMonthKey, monthEnd, monthOf, monthsInRange } from '../dates'
import { balanceAt } from './loan'
import { savingsRate } from './ledger'

export interface MonthPoint {
  month: string
  income: Paise
  expense: Paise
  savings: Paise
  rate: number | null
}

/** One bucket per month in the range (empty months included so charts have no gaps). */
export function monthlySeries(txs: Transaction[], range: DateRange): MonthPoint[] {
  const months = monthsInRange(range)
  const idx = new Map(months.map((m, i) => [m, i]))
  const pts: MonthPoint[] = months.map((month) => ({ month, income: 0, expense: 0, savings: 0, rate: null }))
  for (const t of txs) {
    if (t.type === 'transfer') continue
    if (t.date < range.from || t.date > range.to) continue
    const i = idx.get(monthOf(t.date))
    const pt = i === undefined ? undefined : pts[i]
    if (!pt) continue
    if (t.type === 'income') pt.income += t.amount
    else pt.expense += t.amount
  }
  for (const p of pts) {
    p.savings = p.income - p.expense
    p.rate = savingsRate(p.income, p.expense)
  }
  return pts
}

export interface LoanTrendPoint {
  month: string
  balance: Paise
}

/** Combined outstanding principal at each month end over the last `count` months. */
export function loanBalanceTrend(loans: Loan[], payments: LoanPayment[], endMonth: string, count: number): LoanTrendPoint[] {
  const out: LoanTrendPoint[] = []
  for (let i = count - 1; i >= 0; i--) {
    const month = addMonthKey(endMonth, -i)
    const end = monthEnd(month)
    const balance = loans
      .filter((l) => l.startDate <= end)
      .reduce((s, l) => s + balanceAt(l, payments, end), 0)
    out.push({ month, balance })
  }
  // drop leading months before any loan existed (keep at least two points so a chart can draw)
  let first = 0
  while (first < out.length - 2 && out[first]!.balance === 0) first++
  return out.slice(first)
}
