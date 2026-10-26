import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Landmark, Plus } from 'lucide-react'
import { useData } from '@/app/data'
import { BalanceTrendChart } from '@/components/charts'
import { Badge, EmptyState, Notice, PageHeader, ProgressBar, Section, Stat } from '@/components/ui'
import { nextEmiDue, summariseLoans } from '@/lib/calc/loan'
import { loanBalanceTrend } from '@/lib/calc/reports'
import { diffDays, formatDate, formatMonth, monthOf } from '@/lib/dates'
import { formatINR } from '@/lib/money'
import { LoanModal, PaymentModal } from './loanForms'
import type { Loan } from '@/types'

export default function LoansPage() {
  const d = useData()
  const [add, setAdd] = useState(false)
  const [pay, setPay] = useState<Loan | null>(null)
  const s = summariseLoans(d.loans)
  const trend = useMemo(
    () => loanBalanceTrend(d.loans, d.loanPayments, monthOf(d.today), 12).map((p) => ({ label: formatMonth(p.month), balance: p.balance })),
    [d.loans, d.loanPayments, d.today],
  )
  const upcoming = d.loans
    .map((l) => ({ l, due: nextEmiDue(l, d.loanPayments, d.today) }))
    .filter((x) => x.due)
    .sort((a, b) => a.due!.dueDate.localeCompare(b.due!.dueDate))

  return (
    <div className="space-y-5">
      <PageHeader title="Loans & EMI" subtitle="Track principal, interest and payoff progress" actions={<button type="button" className="btn-primary" onClick={() => setAdd(true)}><Plus size={16} /> Add loan</button>} />

      {d.loans.length === 0 ? (
        <EmptyState icon={<Landmark size={32} />} title="No loans tracked" text="Add a home, car or personal loan to see outstanding principal, upcoming EMIs and a payoff schedule." action={<button type="button" className="btn-primary" onClick={() => setAdd(true)}>Add loan</button>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total outstanding" value={formatINR(s.totalOutstanding)} tone={s.totalOutstanding > 0 ? 'warn' : 'pos'} />
            <Stat label="Monthly EMIs" value={formatINR(s.monthlyCommitment)} sub="Active loans" />
            <Stat label="Principal repaid" value={formatINR(s.repaid)} tone="pos" sub={`of ${formatINR(s.totalPrincipal)}`} />
            <Stat label="Next EMI" value={upcoming[0] ? formatDate(upcoming[0].due!.dueDate) : '—'} sub={upcoming[0] ? `${upcoming[0].l.name}${upcoming[0].due!.overdue ? ' · overdue' : ''}` : 'All loans cleared'} tone={upcoming[0]?.due!.overdue ? 'neg' : undefined} />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {d.loans.map((l) => {
              const due = nextEmiDue(l, d.loanPayments, d.today)
              const paidPct = l.principal ? ((l.principal - l.outstanding) / l.principal) * 100 : 0
              return (
                <article key={l.id} className="card p-4" aria-label={l.name}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold">{l.name} {l.isSample && <Badge tone="warn">Sample</Badge>}</h3>
                      <p className="text-xs text-subtle">{l.lender || 'Lender not set'} · {l.annualRate}% · EMI {formatINR(l.emi)}</p>
                    </div>
                    {l.outstanding <= 0 ? <Badge tone="pos">Repaid</Badge> : due && <Badge tone={due.overdue ? 'neg' : 'muted'}>{due.overdue ? 'Overdue' : `Due in ${Math.max(0, diffDays(d.today, due.dueDate))}d`}</Badge>}
                  </div>
                  <p className="num mt-3 text-2xl font-bold">{formatINR(l.outstanding)}</p>
                  <p className="text-xs text-subtle">Outstanding principal</p>
                  <div className="mt-3"><ProgressBar value={paidPct} label={`${l.name} repaid`} /></div>
                  <p className="num mt-1 text-xs text-subtle">{Math.round(paidPct)}% repaid · next due {due ? formatDate(due.dueDate) : '—'}</p>
                  <div className="mt-4 flex gap-2">
                    <button type="button" className="btn-primary !min-h-[38px] flex-1" disabled={l.outstanding <= 0} onClick={() => setPay(l)} aria-label={`Record EMI for ${l.name}`}>Record EMI</button>
                    <Link to={`/loans/${l.id}`} className="btn-secondary !min-h-[38px] flex-1" aria-label={`Details of ${l.name}`}>Details</Link>
                  </div>
                </article>
              )
            })}
          </div>

          <Section title="Debt reduction over time">
            <BalanceTrendChart data={trend} label="Total outstanding debt" />
            <p className="mt-2 text-xs text-subtle">Reconstructed from recorded payments. Manual balance corrections are not reflected in past months.</p>
          </Section>
          <Notice>Schedules assume a fixed-rate, reducing-balance loan with monthly compounding. Real lenders may differ, so correct the outstanding balance from your statement whenever needed.</Notice>
        </>
      )}

      <LoanModal open={add} onClose={() => setAdd(false)} />
      {pay && <PaymentModal open onClose={() => setPay(null)} loan={pay} kind="emi" />}
    </div>
  )
}
