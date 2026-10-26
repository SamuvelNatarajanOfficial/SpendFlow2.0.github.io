import { Link } from 'react-router-dom'
import { Repeat } from 'lucide-react'
import { useData } from '@/app/data'
import { useUI } from '@/app/ui-context'
import { Badge, EmptyState, Notice, PageHeader, Stat } from '@/components/ui'
import { useRecurringActions } from '@/components/useRecurringActions'
import { listRecurring } from '@/lib/calc/ledger'
import { diffDays, formatDate } from '@/lib/dates'
import { formatINR } from '@/lib/money'

export default function RecurringPage() {
  const d = useData()
  const { openTransaction } = useUI()
  const { record, stop, busy } = useRecurringActions()
  const series = listRecurring(d.transactions, d.catMap)
  const monthly = (s: (typeof series)[number]) => (s.frequency === 'weekly' ? (s.amount * 52) / 12 : s.frequency === 'yearly' ? s.amount / 12 : s.amount)
  const outgo = Math.round(series.filter((s) => s.type === 'expense').reduce((t, s) => t + monthly(s), 0))
  const inflow = Math.round(series.filter((s) => s.type === 'income').reduce((t, s) => t + monthly(s), 0))
  const dueNow = series.filter((s) => s.dueDate <= d.today).length

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recurring"
        subtitle="Salary, rent, subscriptions and other repeating items"
        actions={<button type="button" className="btn-primary" onClick={() => openTransaction({ type: 'expense' })}>Add transaction</button>}
      />
      <Notice>
        Nothing is posted automatically. When an item is due, press <strong>Record</strong> to add it as a real transaction. To start a new recurring item, choose “Repeats” when adding an income or expense. Loan EMIs are tracked on the <Link className="font-semibold text-brand" to="/loans">Loans</Link> page.
      </Notice>

      {series.length === 0 ? (
        <EmptyState icon={<Repeat size={32} />} title="No recurring items" text="Add an income or expense and set “Repeats” to weekly, monthly or yearly." action={<button type="button" className="btn-primary" onClick={() => openTransaction({ type: 'expense' })}>Add transaction</button>} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Due now" value={String(dueNow)} tone={dueNow > 0 ? 'warn' : undefined} sub="Ready to record" />
            <Stat label="Recurring income" value={formatINR(inflow)} tone="pos" sub="Per month, approx." />
            <Stat label="Recurring expenses" value={formatINR(outgo)} sub="Per month, approx." />
          </div>
          <ul className="space-y-3" aria-label="Recurring items">
            {series.map((s) => {
              const days = diffDays(d.today, s.dueDate)
              const due = days <= 0
              return (
                <li key={s.key} className="card flex flex-wrap items-center gap-3 p-4" data-testid="recurring-row">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {s.title}
                      <Badge tone={s.type === 'income' ? 'pos' : 'muted'}>{s.type}</Badge>
                      <Badge>{s.frequency}</Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-subtle">
                      {d.accMap.get(s.accountId)?.name ?? 'Account'} · next {formatDate(s.dueDate)} ·{' '}
                      {days < 0 ? <span className="font-semibold text-neg">{-days} day{days === -1 ? '' : 's'} overdue</span> : days === 0 ? <span className="font-semibold text-warn">due today</span> : `in ${days} day${days === 1 ? '' : 's'}`}
                      {' '}· {s.count} recorded
                    </p>
                  </div>
                  <p className={`num text-lg font-bold ${s.type === 'income' ? 'text-pos' : ''}`}>{s.type === 'income' ? '+' : ''}{formatINR(s.amount)}</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary !min-h-[38px]" disabled={!due || busy !== null} onClick={() => record(s)} aria-label={`Record ${s.title} for ${formatDate(s.dueDate)}`}>Record</button>
                    <button type="button" className="btn-secondary !min-h-[38px]" onClick={() => stop(s)} aria-label={`Stop recurring ${s.title}`}>Stop</button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
