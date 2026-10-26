import { describe, expect, it } from 'vitest'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Transaction } from '@/types'
import {
  accountBalance, expenseByCategory, filterByRange, reconciliationDiff, savingsRate, sumExpense, sumIncome, totalBalance, upcomingRecurring,
} from './ledger'
import { budgetStatus, budgetTotals, compareMonths, monthBudgetStatuses, spentByCategory } from './budget'
import { balanceAt, buildSchedule, calcEmi, comparePlans, nextEmiDue, splitPayment, summariseLoans } from './loan'
import { allocationByAccount, goalProgress } from './goals'
import { loanBalanceTrend, monthlySeries } from './reports'

const T = '2025-01-01T00:00:00.000Z'
const acc = (id: string, opening = 0, extra: Partial<Account> = {}): Account => ({ id, name: id, type: 'savings', openingBalance: opening, createdAt: T, updatedAt: T, ...extra })
let n = 0
const tx = (p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date' | 'accountId'>): Transaction => ({
  id: `t${n++}`, paymentMethod: 'upi', createdAt: T, updatedAt: T, ...p,
})

describe('ledger', () => {
  const a = acc('A', 100000), b = acc('B', 0)
  const txs = [
    tx({ type: 'income', amount: 500000, date: '2025-03-01', accountId: 'A' }),
    tx({ type: 'expense', amount: 120000, date: '2025-03-02', accountId: 'A' }),
    tx({ type: 'transfer', amount: 200000, date: '2025-03-03', accountId: 'A', toAccountId: 'B' }),
    tx({ type: 'expense', amount: 30000, date: '2025-03-04', accountId: 'B' }),
  ]
  it('balances include transfers on both sides', () => {
    expect(accountBalance(a, txs)).toBe(100000 + 500000 - 120000 - 200000)
    expect(accountBalance(b, txs)).toBe(200000 - 30000)
  })
  it('transfers do not change total balance, income or expense (no double counting)', () => {
    const withoutTransfer = txs.filter((t) => t.type !== 'transfer')
    expect(totalBalance([a, b], txs)).toBe(totalBalance([a, b], withoutTransfer))
    expect(sumIncome(txs)).toBe(500000)
    expect(sumExpense(txs)).toBe(150000)
  })
  it('respects asOf and archived accounts', () => {
    expect(accountBalance(a, txs, '2025-03-01')).toBe(600000)
    expect(totalBalance([a, acc('Z', 999, { archived: true })], [])).toBe(100000)
  })
  it('savings rate handles zero income', () => {
    expect(savingsRate(500000, 150000)).toBeCloseTo(70)
    expect(savingsRate(0, 100)).toBeNull()
    expect(savingsRate(1000, 2000)).toBeCloseTo(-100)
  })
  it('filters by date range inclusively and skips invalid dates', () => {
    const bad = tx({ type: 'expense', amount: 1, date: 'nope', accountId: 'A' })
    const r = filterByRange([...txs, bad], { from: '2025-03-02', to: '2025-03-03' })
    expect(r.map((t) => t.date)).toEqual(['2025-03-02', '2025-03-03'])
  })
  it('reconciles calculated vs actual balance', () => {
    const acct = acc('A', 100000, { actualBalance: { amount: 585000, asOf: '2025-03-02' } })
    expect(reconciliationDiff(acct, txs)).toBe(585000 - 480000)
    expect(reconciliationDiff(a, txs)).toBeNull()
  })
  it('breaks expenses down by category', () => {
    const cats: Category[] = [{ id: 'f', name: 'Food', kind: 'expense', color: '#fff000', createdAt: T, updatedAt: T }]
    const r = expenseByCategory([tx({ type: 'expense', amount: 100, date: '2025-03-01', accountId: 'A', categoryId: 'f' }), tx({ type: 'expense', amount: 50, date: '2025-03-01', accountId: 'A' })], cats)
    expect(r.map((x) => [x.name, x.amount])).toEqual([['Food', 100], ['Uncategorised', 50]])
  })
  it('derives upcoming recurring bills from the latest entry in a series', () => {
    const cats = new Map<string, Category>()
    const list = upcomingRecurring(
      [
        tx({ type: 'expense', amount: 64900, date: '2025-02-11', accountId: 'A', merchant: 'Netflix', recurring: 'monthly' }),
        tx({ type: 'expense', amount: 64900, date: '2025-03-11', accountId: 'A', merchant: 'Netflix', recurring: 'monthly' }),
        tx({ type: 'expense', amount: 5, date: '2025-03-11', accountId: 'A', merchant: 'EMI', recurring: 'monthly', loanPaymentId: 'x' }),
      ],
      cats, '2025-04-01',
    )
    expect(list).toHaveLength(1)
    expect(list[0].dueDate).toBe('2025-04-11')
  })
})

describe('budget', () => {
  const txs = [
    tx({ type: 'expense', amount: 3000, date: '2025-03-05', accountId: 'A', categoryId: 'food' }),
    tx({ type: 'expense', amount: 2500, date: '2025-03-20', accountId: 'A', categoryId: 'food' }),
    tx({ type: 'expense', amount: 999, date: '2025-02-20', accountId: 'A', categoryId: 'food' }),
    tx({ type: 'transfer', amount: 7000, date: '2025-03-06', accountId: 'A', toAccountId: 'B', categoryId: 'food' }),
  ]
  const bud = (amount: number): Budget => ({ id: 'b', categoryId: 'food', month: '2025-03', amount, createdAt: T, updatedAt: T })
  it('sums only expenses of the month', () => expect(spentByCategory(txs, '2025-03').get('food')).toBe(5500))
  it('computes remaining, percent and state', () => {
    expect(budgetStatus(bud(10000), 5500)).toMatchObject({ remaining: 4500, state: 'ok' })
    expect(budgetStatus(bud(10000), 5500).percentUsed).toBeCloseTo(55)
    expect(budgetStatus(bud(6000), 5500).state).toBe('warning')
    expect(budgetStatus(bud(5000), 5500)).toMatchObject({ remaining: -500, state: 'over' })
    expect(budgetStatus(bud(5500), 5500).state).toBe('warning') // exactly used is not "over"
  })
  it('totals and month comparison', () => {
    const st = monthBudgetStatuses([bud(10000)], txs, '2025-03')
    expect(budgetTotals(st)).toMatchObject({ budget: 10000, spent: 5500 })
    expect(compareMonths(txs, ['2025-02', '2025-03']).get('food')).toEqual([999, 5500])
  })
})

describe('loan maths', () => {
  it('EMI for 10L @ 8.5% over 20y is about 8,678', () => {
    const emi = calcEmi(100000000, 8.5, 240)
    expect(emi / 100).toBeGreaterThan(8677)
    expect(emi / 100).toBeLessThan(8679)
    expect(calcEmi(120000, 0, 12)).toBe(10000)
    expect(calcEmi(0, 10, 12)).toBe(0)
  })
  it('EMI is NOT all principal: first month splits interest first', () => {
    const emi = calcEmi(100000000, 8.5, 240)
    const s = splitPayment(100000000, 8.5, emi, 'emi')
    expect(s.interest).toBe(708333)
    expect(s.principal).toBe(emi - 708333)
    expect(s.interest + s.principal).toBe(emi)
  })
  it('prepayment is all principal and capped at outstanding', () => {
    expect(splitPayment(500000, 10, 200000, 'prepayment')).toEqual({ interest: 0, principal: 200000 })
    expect(splitPayment(500000, 10, 900000, 'prepayment').principal).toBe(500000)
  })
  it('amortisation clears the loan, principal sums to the balance', () => {
    const emi = calcEmi(100000000, 8.5, 240)
    const s = buildSchedule(100000000, 8.5, emi, '2025-01-01', 5)
    expect(s.months).toBeGreaterThanOrEqual(239)
    expect(s.months).toBeLessThanOrEqual(241) // EMI is rounded to whole paise, so a tiny final instalment may remain
    expect(s.rows[s.rows.length - 1].closing).toBe(0)
    expect(s.rows.reduce((x, r) => x + r.principal + r.extra, 0)).toBe(100000000)
    expect(s.totalPaid).toBe(100000000 + s.totalInterest)
    expect(s.rows[0].date).toBe('2025-01-05')
    expect(s.neverPaysOff).toBe(false)
  })
  it('due-day clamps to short months and persists', () => {
    const s = buildSchedule(300000, 12, 110000, '2025-01-31', 31)
    expect(s.rows.map((r) => r.date)).toEqual(['2025-02-28', '2025-03-31', '2025-04-30'])
  })
  it('flags an EMI that cannot cover interest', () => {
    const s = buildSchedule(100000000, 12, 100, '2025-01-01', 5)
    expect(s.neverPaysOff).toBe(true)
    expect(s.rows.length).toBeLessThanOrEqual(12)
  })
  it('extra payments shorten the loan and save interest', () => {
    const loan: Loan = { id: 'l', name: 'L', lender: '', principal: 100000000, outstanding: 100000000, annualRate: 8.5, emi: calcEmi(100000000, 8.5, 240), dueDay: 5, startDate: '2025-01-05', tenureMonths: 240, createdAt: T, updatedAt: T }
    const c = comparePlans(loan, '2025-01-01', { extraMonthly: 500000 })
    expect(c.monthsSaved).toBeGreaterThan(60)
    expect(c.interestSaved).toBeGreaterThan(0)
    const lump = comparePlans(loan, '2025-01-01', { lumpSum: 20000000 })
    expect(lump.plan.months).toBeLessThan(lump.baseline.months)
  })
  const loan: Loan = { id: 'l', name: 'L', lender: '', principal: 1000000, outstanding: 800000, annualRate: 10, emi: 50000, dueDay: 10, startDate: '2024-06-10', tenureMonths: 24, createdAt: T, updatedAt: T }
  const pay = (date: string, principal: number, kind: 'emi' | 'prepayment' = 'emi'): LoanPayment => ({ id: `p${date}`, loanId: 'l', date, kind, amount: principal + 5000, interest: 5000, principal, createdAt: T, updatedAt: T })
  it('next EMI due: this month unless already paid', () => {
    expect(nextEmiDue(loan, [], '2025-03-05')).toEqual({ dueDate: '2025-03-10', overdue: false })
    expect(nextEmiDue(loan, [], '2025-03-15')).toEqual({ dueDate: '2025-03-10', overdue: true })
    expect(nextEmiDue(loan, [pay('2025-03-08', 45000)], '2025-03-15')).toEqual({ dueDate: '2025-04-10', overdue: false })
    expect(nextEmiDue({ ...loan, outstanding: 0 }, [], '2025-03-05')).toBeNull()
  })
  it('reconstructs historic balance and summarises debts', () => {
    const ps = [pay('2025-02-10', 40000), pay('2025-03-10', 45000)]
    expect(balanceAt(loan, ps, '2025-03-31')).toBe(800000)
    expect(balanceAt(loan, ps, '2025-02-28')).toBe(845000)
    expect(balanceAt(loan, ps, '2025-01-31')).toBe(885000)
    const s = summariseLoans([loan, { ...loan, id: 'm', outstanding: 0 }])
    expect(s).toMatchObject({ totalOutstanding: 800000, monthlyCommitment: 50000, totalPrincipal: 2000000 })
    const trend = loanBalanceTrend([loan], ps, '2025-03', 3)
    expect(trend.map((p) => p.balance)).toEqual([885000, 845000, 800000])
    expect(loanBalanceTrend([loan], [], '2025-03', 4).map((p) => p.balance).every((b) => b > 0)).toBe(true)
  })
})

describe('goals', () => {
  const g: Goal = { id: 'g', name: 'EF', kind: 'emergency', target: 100000, saved: 25000, targetDate: '2025-12-31', accountId: 'A', createdAt: T, updatedAt: T }
  it('progress and monthly need', () => {
    const p = goalProgress(g, [], '2025-01-01')
    expect(p.percent).toBe(25)
    expect(p.remaining).toBe(75000)
    expect(p.monthlyNeeded).toBeGreaterThan(6000)
    expect(p.monthlyNeeded).toBeLessThan(7000)
    expect(goalProgress({ ...g, saved: 200000 }, [], '2025-01-01')).toMatchObject({ percent: 100, achieved: true })
  })
  it('debt-free goal is derived from loans', () => {
    const l: Loan = { id: 'l', name: 'L', lender: '', principal: 1000000, outstanding: 400000, annualRate: 10, emi: 1, dueDay: 1, startDate: '2024-01-01', tenureMonths: 12, createdAt: T, updatedAt: T }
    expect(goalProgress({ ...g, kind: 'debt-free', target: 0, saved: 0 }, [l], '2025-01-01').percent).toBe(60)
  })
  it('goals are earmarks: they never add to balances, and over-allocation is flagged', () => {
    const accounts = [acc('A', 50000)]
    const alloc = allocationByAccount(accounts, [], [g])
    expect(alloc[0]).toMatchObject({ balance: 50000, earmarked: 25000, free: 25000, overAllocated: false })
    expect(allocationByAccount(accounts, [], [{ ...g, saved: 80000 }])[0].overAllocated).toBe(true)
    expect(totalBalance(accounts, [])).toBe(50000)
  })
})

describe('reports', () => {
  it('monthly series includes empty months and ignores transfers', () => {
    const s = monthlySeries(
      [
        tx({ type: 'income', amount: 1000, date: '2025-01-10', accountId: 'A' }),
        tx({ type: 'expense', amount: 400, date: '2025-03-10', accountId: 'A' }),
        tx({ type: 'transfer', amount: 999, date: '2025-02-10', accountId: 'A', toAccountId: 'B' }),
      ],
      { from: '2025-01-01', to: '2025-03-31' },
    )
    expect(s.map((p) => [p.income, p.expense])).toEqual([[1000, 0], [0, 0], [0, 400]])
    expect(s[0].rate).toBe(100)
    expect(s[1].rate).toBeNull()
  })
})
