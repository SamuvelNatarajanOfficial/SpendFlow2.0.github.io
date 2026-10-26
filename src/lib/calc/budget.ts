import type { Budget, Paise, Transaction } from '@/types'
import { monthOf } from '../dates'

export interface BudgetStatus {
  budget: Budget
  spent: Paise
  remaining: Paise // negative when over budget
  percentUsed: number // 0..n (can exceed 100)
  state: 'ok' | 'warning' | 'over'
}

/** Spending per category within one month. Only expenses count (not transfers). */
export function spentByCategory(txs: Transaction[], month: string): Map<string, Paise> {
  const m = new Map<string, Paise>()
  for (const t of txs) {
    if (t.type !== 'expense' || !t.categoryId || monthOf(t.date) !== month) continue
    m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + t.amount)
  }
  return m
}

export function budgetStatus(budget: Budget, spent: Paise): BudgetStatus {
  const percentUsed = budget.amount > 0 ? (spent / budget.amount) * 100 : spent > 0 ? Infinity : 0
  return {
    budget,
    spent,
    remaining: budget.amount - spent,
    percentUsed,
    state: spent > budget.amount ? 'over' : percentUsed >= 80 ? 'warning' : 'ok',
  }
}

export function monthBudgetStatuses(budgets: Budget[], txs: Transaction[], month: string): BudgetStatus[] {
  const spent = spentByCategory(txs, month)
  return budgets
    .filter((b) => b.month === month)
    .map((b) => budgetStatus(b, spent.get(b.categoryId) ?? 0))
    .sort((a, b) => b.percentUsed - a.percentUsed)
}

export function budgetTotals(statuses: BudgetStatus[]) {
  const budget = statuses.reduce((s, x) => s + x.budget.amount, 0)
  const spent = statuses.reduce((s, x) => s + x.spent, 0)
  return { budget, spent, remaining: budget - spent, percentUsed: budget > 0 ? (spent / budget) * 100 : 0 }
}

/** Compare per-category spend across several months. */
export function compareMonths(txs: Transaction[], months: string[]): Map<string, Paise[]> {
  const perMonth = months.map((m) => spentByCategory(txs, m))
  const cats = new Set<string>()
  perMonth.forEach((m) => m.forEach((_, k) => cats.add(k)))
  const out = new Map<string, Paise[]>()
  cats.forEach((c) => out.set(c, perMonth.map((m) => m.get(c) ?? 0)))
  return out
}
