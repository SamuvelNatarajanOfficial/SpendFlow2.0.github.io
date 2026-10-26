import type { Account, Goal, Loan, Paise, Transaction } from '@/types'
import { accountBalance } from './ledger'
import { summariseLoans } from './loan'
import { diffDays } from '../dates'

export interface GoalProgress {
  goal: Goal
  current: Paise
  percent: number // clamped 0..100
  remaining: Paise
  achieved: boolean
  /** monthly amount needed to hit the target by the target date, if one is set and in the future */
  monthlyNeeded: Paise | null
}

/**
 * Savings goals are EARMARKS of money that already sits in an account, so they
 * are never added to total balance (that would count the same rupees twice).
 * Debt-free goals are derived from loans: target = total principal, current = principal repaid.
 */
export function goalProgress(goal: Goal, loans: Loan[], today: string): GoalProgress {
  let target = goal.target
  let current = goal.saved
  if (goal.kind === 'debt-free') {
    const s = summariseLoans(loans)
    target = s.totalPrincipal
    current = s.repaid
  }
  const percent = target > 0 ? Math.max(0, Math.min(100, (current / target) * 100)) : 0
  const remaining = Math.max(0, target - current)
  let monthlyNeeded: Paise | null = null
  if (goal.targetDate && remaining > 0) {
    const days = diffDays(today, goal.targetDate)
    if (days > 0) monthlyNeeded = Math.ceil(remaining / Math.max(1, days / 30.4375))
  }
  return { goal, current, percent, remaining, achieved: target > 0 && current >= target, monthlyNeeded }
}

export interface AllocationCheck {
  accountId: string
  balance: Paise
  earmarked: Paise
  /** earmarked > balance means goals promise money the account doesn't hold */
  overAllocated: boolean
  free: Paise
}

/** Per-account view of how much balance is earmarked by goals (savings-type goals only). */
export function allocationByAccount(accounts: Account[], txs: Transaction[], goals: Goal[]): AllocationCheck[] {
  return accounts
    .filter((a) => !a.archived)
    .map((a) => {
      const balance = accountBalance(a, txs)
      const earmarked = goals.filter((g) => g.kind !== 'debt-free' && g.accountId === a.id).reduce((s, g) => s + g.saved, 0)
      return { accountId: a.id, balance, earmarked, overAllocated: earmarked > Math.max(balance, 0), free: balance - earmarked }
    })
}
