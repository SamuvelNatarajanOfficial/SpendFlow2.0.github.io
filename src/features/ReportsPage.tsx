import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { useData } from '@/app/data'
import { RangeFilter, useRange } from '@/components/RangeFilter'
import { BalanceTrendChart, CategoryDonut, IncomeExpenseChart, SavingsRateChart } from '@/components/charts'
import { PageHeader, Section, Stat } from '@/components/ui'
import { downloadText, rowsToCsv, transactionsToCsv } from '@/db/csv'
import { expenseByCategory, filterByRange, essentialSplit, savingsRate, sumExpense, sumIncome } from '@/lib/calc/ledger'
import { monthBudgetStatuses } from '@/lib/calc/budget'
import { loanBalanceTrend, monthlySeries } from '@/lib/calc/reports'
import { formatDate, formatMonth, monthOf, monthsInRange } from '@/lib/dates'
import { formatINR, paiseToInput } from '@/lib/money'

export default function ReportsPage() {
  const d = useData()
  const r = useRange('this-year')
  const inRange = useMemo(() => filterByRange(d.transactions, r.range), [d.transactions, r.range])
  const income = sumIncome(inRange)
  const expense = sumExpense(inRange)
  const rate = savingsRate(income, expense)
  const series = useMemo(() => monthlySeries(d.transactions, r.range), [d.transactions, r.range])
  const cats = useMemo(() => expenseByCategory(inRange, d.categories), [inRange, d.categories])
  const split = essentialSplit(inRange)
  const months = monthsInRange(r.range)
  const [bm, setBm] = useState('')
  const budgetMonth = months.includes(bm) ? bm : months.includes(monthOf(d.today)) ? monthOf(d.today) : months[months.length - 1]
  const bva = useMemo(() => monthBudgetStatuses(d.budgets, d.transactions, budgetMonth), [d.budgets, d.transactions, budgetMonth])
  const loanTrend = useMemo(() => {
    const end = monthOf(r.range.to) > monthOf(d.today) ? monthOf(d.today) : monthOf(r.range.to)
    const n = Math.min(24, Math.max(3, months.length))
    return loanBalanceTrend(d.loans, d.loanPayments, end, n).map((p) => ({ label: formatMonth(p.month), balance: p.balance }))
  }, [d.loans, d.loanPayments, r.range, d.today, months.length])

  const tag = `${r.range.from}_to_${r.range.to}`
  const exportMonthly = () => downloadText(`spendflow-monthly-${tag}.csv`, rowsToCsv(['month', 'income', 'expense', 'net_savings', 'savings_rate_pct'], series.map((p) => [p.month, paiseToInput(p.income), paiseToInput(p.expense), paiseToInput(p.savings), p.rate === null ? '' : p.rate.toFixed(1)])), 'text/csv')
  const exportCats = () => downloadText(`spendflow-categories-${tag}.csv`, rowsToCsv(['category', 'amount', 'share_pct'], cats.map((c) => [c.name, paiseToInput(c.amount), expense ? ((c.amount / expense) * 100).toFixed(1) : '0'])), 'text/csv')
  const exportBudget = () => downloadText(`spendflow-budget-vs-actual-${budgetMonth}.csv`, rowsToCsv(['month', 'category', 'budget', 'spent', 'remaining', 'percent_used'], bva.map((b) => [budgetMonth, d.catMap.get(b.budget.categoryId)?.name ?? '', paiseToInput(b.budget.amount), paiseToInput(b.spent), paiseToInput(b.remaining), Number.isFinite(b.percentUsed) ? b.percentUsed.toFixed(1) : ''])), 'text/csv')

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        subtitle={`${formatDate(r.range.from)} – ${formatDate(r.range.to)}`}
        actions={<button type="button" className="btn-secondary" disabled={inRange.length === 0} onClick={() => downloadText(`spendflow-transactions-${tag}.csv`, transactionsToCsv(inRange, d.accounts, d.categories), 'text/csv')}><Download size={16} /> Transactions CSV</button>}
      />
      <RangeFilter r={r} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Income" value={formatINR(income)} tone="pos" />
        <Stat label="Expenses" value={formatINR(expense)} />
        <Stat label="Net savings" value={formatINR(income - expense)} tone={income - expense < 0 ? 'neg' : 'pos'} />
        <Stat label="Savings rate" value={rate === null ? 'n/a' : `${rate.toFixed(1)}%`} sub={rate === null ? 'No income in range' : undefined} />
      </div>

      <Section title="Income & expense trend" actions={<button type="button" className="btn-ghost !min-h-[34px]" onClick={exportMonthly}><Download size={14} /> CSV</button>}>
        <IncomeExpenseChart data={series} />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <caption className="sr-only">Monthly income, expense and savings</caption>
            <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-2">Month</th><th scope="col" className="text-right">Income</th><th scope="col" className="text-right">Expense</th><th scope="col" className="text-right">Net</th><th scope="col" className="text-right">Rate</th></tr></thead>
            <tbody className="divide-y divide-line">
              {series.map((p) => (
                <tr key={p.month}><th scope="row" className="py-1.5 text-left font-medium">{formatMonth(p.month)}</th><td className="num text-right">{formatINR(p.income)}</td><td className="num text-right">{formatINR(p.expense)}</td><td className={`num text-right ${p.savings < 0 ? 'text-neg' : ''}`}>{formatINR(p.savings)}</td><td className="num text-right">{p.rate === null ? '—' : `${p.rate.toFixed(0)}%`}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {series.length >= 2 && <Section title="Savings rate trend"><SavingsRateChart data={series} /></Section>}

      <Section title="Category-wise spending" actions={<button type="button" className="btn-ghost !min-h-[34px]" onClick={exportCats}><Download size={14} /> CSV</button>}>
        {cats.length === 0 ? <p className="text-sm text-subtle">No expenses in this range.</p> : (
          <>
            <CategoryDonut data={cats} />
            <p className="num mt-4 text-sm text-subtle">Essential {formatINR(split.essential)} · Discretionary {formatINR(split.discretionary)}</p>
          </>
        )}
      </Section>

      <Section title="Budget vs actual" actions={
        <div className="flex items-center gap-2">
          <label htmlFor="bva-month" className="sr-only">Month</label>
          <select id="bva-month" className="input !min-h-[34px] !w-auto" value={budgetMonth} onChange={(e) => setBm(e.target.value)}>
            {[...months].reverse().map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}
          </select>
          <button type="button" className="btn-ghost !min-h-[34px]" onClick={exportBudget} disabled={bva.length === 0}><Download size={14} /> CSV</button>
        </div>
      }>
        {bva.length === 0 ? <p className="text-sm text-subtle">No budgets set for {formatMonth(budgetMonth)}.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">Budget versus actual spending</caption>
              <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-2">Category</th><th scope="col" className="text-right">Budget</th><th scope="col" className="text-right">Actual</th><th scope="col" className="text-right">Remaining</th><th scope="col" className="text-right">Used</th></tr></thead>
              <tbody className="divide-y divide-line">
                {bva.map((b) => (
                  <tr key={b.budget.id}><th scope="row" className="py-1.5 text-left font-medium">{d.catMap.get(b.budget.categoryId)?.name}</th><td className="num text-right">{formatINR(b.budget.amount)}</td><td className="num text-right">{formatINR(b.spent)}</td><td className={`num text-right ${b.remaining < 0 ? 'text-neg' : ''}`}>{formatINR(b.remaining)}</td><td className="num text-right">{Math.round(b.percentUsed)}%{b.state === 'over' ? ' ⚠' : ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {d.loans.length > 0 && <Section title="Loan balance trend"><BalanceTrendChart data={loanTrend} label="Total outstanding debt" /></Section>}
    </div>
  )
}
