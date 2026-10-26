import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight, CalendarClock, Landmark, Plus, Wallet } from 'lucide-react'
import { useData } from '@/app/data'
import { useUI } from '@/app/ui-context'
import { RangeFilter, useRange } from '@/components/RangeFilter'
import { BalanceTrendChart, CategoryDonut, IncomeExpenseChart } from '@/components/charts'
import { TransactionList } from '@/components/TransactionList'
import { Badge, EmptyState, PageHeader, ProgressBar, Section, Stat } from '@/components/ui'
import { expenseByCategory, filterByRange, savingsRate, sortTx, sumExpense, sumIncome, totalBalance, upcomingRecurring, type RecurringSeries } from '@/lib/calc/ledger'
import { budgetTotals, monthBudgetStatuses } from '@/lib/calc/budget'
import { nextEmiDue, summariseLoans } from '@/lib/calc/loan'
import { goalProgress } from '@/lib/calc/goals'
import { loanBalanceTrend, monthlySeries } from '@/lib/calc/reports'
import { addMonthKey, diffDays, formatDate, formatMonth, monthOf, monthsInRange, monthStart } from '@/lib/dates'
import { formatINR } from '@/lib/money'
import { useRecurringActions } from '@/components/useRecurringActions'
import { PaymentModal } from './loanForms'
import type { Loan } from '@/types'

interface UpcomingItem {
  key: string
  title: string
  amount: number
  dueDate: string
  kind: 'emi' | 'bill' | 'income'
  overdue: boolean
  loan?: Loan
  series?: RecurringSeries
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function Dashboard() {
  const d = useData()
  const { openTransaction } = useUI()
  const r = useRange('this-month')
  const { range } = r

  const inRange = useMemo(() => filterByRange(d.transactions, range), [d.transactions, range])
  const income = sumIncome(inRange)
  const expense = sumExpense(inRange)
  const rate = savingsRate(income, expense)
  const balance = totalBalance(d.accounts, d.transactions)

  const chartRange = useMemo(() => {
    const ms = monthsInRange(range)
    return ms.length >= 2 ? range : { from: monthStart(addMonthKey(monthOf(range.to), -5)), to: range.to }
  }, [range])
  const series = useMemo(() => monthlySeries(d.transactions, chartRange), [d.transactions, chartRange])
  const cats = useMemo(() => expenseByCategory(inRange, d.categories), [inRange, d.categories])

  const budgetMonth = monthOf(range.to)
  const budgets = useMemo(() => monthBudgetStatuses(d.budgets, d.transactions, budgetMonth), [d.budgets, d.transactions, budgetMonth])
  const bt = budgetTotals(budgets)

  const loanSum = summariseLoans(d.loans)
  const { record, busy } = useRecurringActions()
  const [payLoan, setPayLoan] = useState<Loan | null>(null)
  const upcoming = useMemo<UpcomingItem[]>(() => {
    const emis = d.loans
      .map((l) => ({ l, due: nextEmiDue(l, d.loanPayments, d.today) }))
      .filter((x) => x.due && diffDays(d.today, x.due.dueDate) <= 30)
      .map((x) => ({ key: `loan-${x.l.id}`, title: `${x.l.name} EMI`, amount: x.l.emi, dueDate: x.due!.dueDate, kind: 'emi' as const, overdue: x.due!.overdue, loan: x.l }))
    const bills = upcomingRecurring(d.transactions, d.catMap, d.today).map((b) => ({ ...b, kind: b.type === 'income' ? ('income' as const) : ('bill' as const), overdue: b.dueDate < d.today, series: b }))
    return [...emis, ...bills].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  }, [d.loans, d.loanPayments, d.transactions, d.catMap, d.today])

  const goals = d.goals.map((g) => goalProgress(g, d.loans, d.today))
  const debtTrend = useMemo(
    () => (d.loans.length ? loanBalanceTrend(d.loans, d.loanPayments, monthOf(d.today), 12).map((p) => ({ label: formatMonth(p.month), balance: p.balance })) : []),
    [d.loans, d.loanPayments, d.today],
  )
  const recent = useMemo(() => sortTx(d.transactions).slice(0, 6), [d.transactions])
  const empty = d.transactions.length === 0 && d.accounts.length === 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle={`${formatDate(range.from)} – ${formatDate(range.to)}`}
        actions={<button type="button" className="btn-primary hidden md:inline-flex" onClick={() => openTransaction()}><Plus size={16} /> Add transaction</button>}
      />
      <RangeFilter r={r} />

      {empty && (
        <EmptyState
          icon={<Wallet size={32} />}
          title="Welcome to SpendFlow"
          text="Start by adding an account with its opening balance, then record income and expenses. Or load sample data in Settings to explore."
          action={<div className="flex gap-2"><Link to="/accounts" className="btn-primary">Add an account</Link><Link to="/settings#data" className="btn-secondary">Load sample data</Link></div>}
        />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total balance" value={formatINR(balance)} sub="Calculated from your records, not your bank" icon={<Wallet size={16} />} />
        <Stat label="Income" value={formatINR(income)} tone="pos" icon={<ArrowDownRight size={16} />} sub={plural(inRange.filter((t) => t.type === 'income').length, 'entry', 'entries')} />
        <Stat label="Expenses" value={formatINR(expense)} icon={<ArrowUpRight size={16} />} sub={plural(inRange.filter((t) => t.type === 'expense').length, 'entry', 'entries')} />
        <Stat
          label="Net savings"
          value={formatINR(income - expense)}
          tone={income - expense < 0 ? 'neg' : 'pos'}
          sub={rate === null ? 'Savings rate: n/a (no income)' : `Savings rate: ${rate.toFixed(1)}%`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Section title="Income vs expense">
            <IncomeExpenseChart data={series} />
          </Section>
        </div>
        <div className="lg:col-span-2">
          <Section title="Where the money went">
            {cats.length ? <CategoryDonut data={cats} /> : <p className="py-8 text-center text-sm text-subtle">No expenses in this period.</p>}
          </Section>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={`Budget · ${formatMonth(budgetMonth)}`} actions={<Link to="/budgets" className="text-sm font-semibold text-brand">Manage</Link>}>
          {budgets.length === 0 ? (
            <p className="text-sm text-subtle">No budgets for this month. <Link to="/budgets" className="font-semibold text-brand">Create one</Link>.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="num">{formatINR(bt.spent)} of {formatINR(bt.budget)}</span>
                  <span className="num font-semibold">{Math.round(bt.percentUsed)}%</span>
                </div>
                <ProgressBar value={bt.percentUsed} tone={bt.percentUsed > 100 ? 'neg' : bt.percentUsed >= 80 ? 'warn' : 'brand'} label="Overall budget used" />
              </div>
              {budgets.slice(0, 4).map((b) => (
                <div key={b.budget.id}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium">{d.catMap.get(b.budget.categoryId)?.name ?? 'Category'}</span>
                    <span className="num text-subtle">{formatINR(b.spent)} / {formatINR(b.budget.amount)}{b.state === 'over' && <Badge tone="neg"> Over</Badge>}</span>
                  </div>
                  <ProgressBar value={b.percentUsed} tone={b.state === 'over' ? 'neg' : b.state === 'warning' ? 'warn' : 'brand'} label={`${d.catMap.get(b.budget.categoryId)?.name} budget used`} />
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Upcoming EMIs & bills" actions={<CalendarClock size={18} className="text-subtle" />}>
          {upcoming.length === 0 ? (
            <p className="text-sm text-subtle">Nothing due in the next 30 days.</p>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.slice(0, 6).map((u) => (
                <li key={u.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{u.title}</p>
                    <p className="text-xs text-subtle">{formatDate(u.dueDate)} {u.overdue ? <Badge tone="neg">Overdue</Badge> : <span>· in {Math.max(0, diffDays(d.today, u.dueDate))} days</span>}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`num font-bold ${u.kind === 'income' ? 'text-pos' : ''}`}>{u.kind === 'income' ? '+' : ''}{formatINR(u.amount)}</span>
                    {u.dueDate <= d.today && u.series && (
                      <button type="button" className="btn-primary !min-h-[32px] !px-3 text-xs" disabled={busy !== null} onClick={() => record(u.series!)} aria-label={`Record ${u.title}`}>Record</button>
                    )}
                    {u.dueDate <= d.today && u.loan && (
                      <button type="button" className="btn-primary !min-h-[32px] !px-3 text-xs" onClick={() => setPayLoan(u.loan!)} aria-label={`Record EMI for ${u.loan.name}`}>Record</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Savings goals & debt" actions={<Link to="/goals" className="text-sm font-semibold text-brand">Goals</Link>}>
          <div className="space-y-3">
            {goals.length === 0 && d.loans.length === 0 && <p className="text-sm text-subtle">No goals or loans yet.</p>}
            {goals.slice(0, 3).map((g) => (
              <div key={g.goal.id}>
                <div className="mb-1 flex justify-between text-xs"><span className="font-medium">{g.goal.name}</span><span className="num text-subtle">{Math.round(g.percent)}%</span></div>
                <ProgressBar value={g.percent} label={`${g.goal.name} progress`} />
              </div>
            ))}
            {d.loans.length > 0 && (
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><Landmark size={12} /> Debt repaid</span>
                  <span className="num text-subtle">{formatINR(loanSum.repaid)} of {formatINR(loanSum.totalPrincipal)}</span>
                </div>
                <ProgressBar value={loanSum.totalPrincipal ? (loanSum.repaid / loanSum.totalPrincipal) * 100 : 0} label="Debt repaid" />
                <p className="num mt-1 text-xs text-subtle">Outstanding {formatINR(loanSum.totalOutstanding)} · EMIs {formatINR(loanSum.monthlyCommitment)}/month</p>
              </div>
            )}
          </div>
        </Section>

        <Section title="Recent transactions" actions={<Link to="/expenses" className="text-sm font-semibold text-brand">All</Link>}>
          {recent.length === 0 ? <p className="text-sm text-subtle">No transactions yet.</p> : <TransactionList txs={recent} compact />}
        </Section>
      </div>

      {debtTrend.length > 0 && (
        <Section title="Debt reduction over time">
          <BalanceTrendChart data={debtTrend} label="Total outstanding debt" />
        </Section>
      )}
      {payLoan && <PaymentModal open onClose={() => setPayLoan(null)} loan={payLoan} kind="emi" />}
    </div>
  )
}
