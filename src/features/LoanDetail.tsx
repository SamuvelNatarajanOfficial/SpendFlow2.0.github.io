import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react'
import { useData } from '@/app/data'
import { BalanceTrendChart } from '@/components/charts'
import { Badge, EmptyState, Field, Notice, PageHeader, Section, Stat, useConfirm, useToast } from '@/components/ui'
import { loans as repo } from '@/db/repo'
import { buildSchedule, comparePlans, nextEmiDue } from '@/lib/calc/loan'
import { formatDate, formatMonth } from '@/lib/dates'
import { formatINR, paiseToInput, parseRupees } from '@/lib/money'
import { LoanModal, PaymentModal } from './loanForms'

export default function LoanDetail() {
  const { id } = useParams()
  const d = useData()
  const nav = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const loan = d.loans.find((l) => l.id === id)
  const [edit, setEdit] = useState(false)
  const [pay, setPay] = useState<'emi' | 'prepayment' | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [extra, setExtra] = useState(loan?.extraMonthly ? paiseToInput(loan.extraMonthly) : '')
  const [lump, setLump] = useState('')

  const payments = useMemo(() => d.loanPayments.filter((p) => p.loanId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [d.loanPayments, id])
  const extraP = parseRupees(extra) ?? 0
  const lumpP = parseRupees(lump) ?? 0
  const cmp = useMemo(() => (loan ? comparePlans(loan, d.today, { extraMonthly: Math.max(0, extraP), lumpSum: Math.max(0, lumpP) }) : null), [loan, d.today, extraP, lumpP])
  const base = useMemo(() => (loan ? buildSchedule(loan.outstanding, loan.annualRate, loan.emi, d.today, loan.dueDay) : null), [loan, d.today])

  if (!loan || !cmp || !base) {
    return <EmptyState title="Loan not found" text="It may have been deleted." action={<Link className="btn-primary" to="/loans">Back to loans</Link>} />
  }
  const due = nextEmiDue(loan, d.loanPayments, d.today)
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  const interestPaid = payments.reduce((s, p) => s + p.interest, 0)
  const rows = showAll ? base.rows : base.rows.slice(0, 12)
  const hasPlan = extraP > 0 || lumpP > 0
  const chart = base.rows.map((r, i) => ({ label: formatMonth(r.date.slice(0, 7)), balance: r.closing, plan: hasPlan ? (cmp.plan.rows[i]?.closing ?? 0) : undefined }))

  const del = async () => {
    if (await confirm({ title: 'Delete loan?', message: `"${loan.name}", all ${payments.length} recorded payment(s) and the expenses they created will be permanently removed.` })) {
      await repo.remove(loan.id)
      toast('Loan deleted')
      nav('/loans')
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/loans" className="inline-flex items-center gap-1 text-sm font-semibold text-subtle hover:text-fg"><ArrowLeft size={16} /> Loans</Link>
      <PageHeader
        title={loan.name}
        subtitle={`${loan.lender || 'Lender not set'} · ${loan.annualRate}% p.a. · due on day ${loan.dueDay}`}
        actions={
          <>
            <button type="button" className="btn-primary" disabled={loan.outstanding <= 0} onClick={() => setPay('emi')}>Record EMI</button>
            <button type="button" className="btn-secondary" disabled={loan.outstanding <= 0} onClick={() => setPay('prepayment')}>Extra payment</button>
            <button type="button" className="btn-secondary" onClick={() => setEdit(true)} aria-label="Edit loan"><Pencil size={16} /></button>
            <button type="button" className="btn-secondary hover:!text-neg" onClick={del} aria-label="Delete loan"><Trash2 size={16} /></button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={formatINR(loan.outstanding)} tone={loan.outstanding > 0 ? 'warn' : 'pos'} sub={`of ${formatINR(loan.principal)} original`} />
        <Stat label="EMI" value={formatINR(loan.emi)} sub={due ? `Next ${formatDate(due.dueDate)}${due.overdue ? ' (overdue)' : ''}` : 'Repaid'} tone={due?.overdue ? 'neg' : undefined} />
        <Stat label="Paid so far" value={formatINR(paid)} sub={`Interest ${formatINR(interestPaid)}`} />
        <Stat label="Estimated payoff" value={base.payoffDate ? formatDate(base.payoffDate) : loan.outstanding <= 0 ? 'Done' : 'Never'} sub={base.neverPaysOff ? 'EMI does not cover interest' : `${base.months} instalments · interest ${formatINR(base.totalInterest)}`} tone={base.neverPaysOff ? 'neg' : undefined} />
      </div>
      {base.neverPaysOff && <Notice tone="neg">The EMI is lower than the monthly interest, so this loan would never be repaid. Check the EMI, rate and outstanding balance.</Notice>}

      <Section title="Repayment plan & payoff comparison">
        <p className="mb-3 text-sm text-subtle">Try paying extra each month or a one-time lump sum, and compare against the current EMI.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Extra per month (₹)" id="plan-extra"><input id="plan-extra" className="input" inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="0" /></Field>
          <Field label="One-time lump sum (₹)" id="plan-lump"><input id="plan-lump" className="input" inputMode="decimal" value={lump} onChange={(e) => setLump(e.target.value)} placeholder="0" /></Field>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="sr-only">Payoff comparison</caption>
            <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-2" /><th scope="col" className="py-2 text-right">Current EMI</th><th scope="col" className="py-2 text-right">With plan</th></tr></thead>
            <tbody className="divide-y divide-line">
              <tr><th scope="row" className="py-2 text-left font-medium">Instalments left</th><td className="num py-2 text-right">{cmp.baseline.months}</td><td className="num py-2 text-right font-semibold">{cmp.plan.months}</td></tr>
              <tr><th scope="row" className="py-2 text-left font-medium">Payoff date</th><td className="num py-2 text-right">{cmp.baseline.payoffDate ? formatDate(cmp.baseline.payoffDate) : '—'}</td><td className="num py-2 text-right font-semibold">{cmp.plan.payoffDate ? formatDate(cmp.plan.payoffDate) : '—'}</td></tr>
              <tr><th scope="row" className="py-2 text-left font-medium">Total interest</th><td className="num py-2 text-right">{formatINR(cmp.baseline.totalInterest)}</td><td className="num py-2 text-right font-semibold">{formatINR(cmp.plan.totalInterest)}</td></tr>
            </tbody>
          </table>
        </div>
        {hasPlan && (
          <p className="mt-3 rounded-xl bg-pos/10 p-3 text-sm font-semibold text-pos" role="status">
            This plan saves {formatINR(cmp.interestSaved)} in interest and finishes {cmp.monthsSaved} month{cmp.monthsSaved === 1 ? '' : 's'} sooner.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-secondary" onClick={async () => { await repo.update(loan.id, { extraMonthly: extraP > 0 ? extraP : undefined }); toast('Plan saved') }}>Save monthly extra as my plan</button>
          {loan.extraMonthly ? <Badge tone="pos">Saved plan: +{formatINR(loan.extraMonthly)}/mo</Badge> : null}
        </div>
      </Section>

      <Section title="Projected balance">
        <BalanceTrendChart data={chart} label="Projected outstanding" />
      </Section>

      <Section title={`Payment history (${payments.length})`}>
        {payments.length === 0 ? <p className="text-sm text-subtle">No payments recorded yet. Scheduled EMIs are shown below; only recorded payments reduce the balance.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Recorded payments</caption>
              <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-2">Date</th><th scope="col">Type</th><th scope="col" className="text-right">Paid</th><th scope="col" className="text-right">Interest</th><th scope="col" className="text-right">Principal</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-line">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{formatDate(p.date)}</td>
                    <td>{p.kind === 'emi' ? 'EMI' : 'Extra principal'}</td>
                    <td className="num text-right font-semibold">{formatINR(p.amount)}</td>
                    <td className="num text-right">{formatINR(p.interest)}</td>
                    <td className="num text-right">{formatINR(p.principal)}</td>
                    <td className="text-right">
                      <button type="button" className="btn-ghost !min-h-[34px] !px-2 hover:!text-neg" aria-label={`Delete payment of ${formatINR(p.amount)} on ${formatDate(p.date)}`} onClick={async () => {
                        if (await confirm({ title: 'Delete payment?', message: 'The principal is added back to the outstanding balance and the linked expense (if any) is removed.' })) { await repo.deletePayment(p.id); toast('Payment deleted') }
                      }}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Estimated amortisation schedule">
        <p className="mb-3 text-xs text-subtle">Assumes a fixed rate with monthly reducing-balance interest (annual rate ÷ 12) on the current outstanding balance. Each EMI pays interest first, then principal. This is an estimate; your lender's figures win.</p>
        {rows.length === 0 ? <p className="text-sm text-subtle">Nothing left to pay.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">Estimated amortisation schedule</caption>
              <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-2">#</th><th scope="col">Date</th><th scope="col" className="text-right">Interest</th><th scope="col" className="text-right">Principal</th><th scope="col" className="text-right">Balance</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => <tr key={r.n}><td className="py-1.5">{r.n}</td><td>{formatDate(r.date)}</td><td className="num text-right">{formatINR(r.interest)}</td><td className="num text-right">{formatINR(r.principal)}</td><td className="num text-right">{formatINR(r.closing)}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
        {base.rows.length > 12 && <button type="button" className="btn-secondary mt-3" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show first 12' : `Show all ${base.rows.length}`}</button>}
      </Section>

      <LoanModal open={edit} onClose={() => setEdit(false)} edit={loan} />
      {pay && <PaymentModal open onClose={() => setPay(null)} loan={loan} kind={pay} />}
    </div>
  )
}
