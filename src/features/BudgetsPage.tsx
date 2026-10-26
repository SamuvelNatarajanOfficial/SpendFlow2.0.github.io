import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ChevronLeft, ChevronRight, Copy, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react'
import { useData } from '@/app/data'
import { Badge, EmptyState, Field, fp, Modal, PageHeader, ProgressBar, Section, Stat, useConfirm, useToast } from '@/components/ui'
import { budgets as repo } from '@/db/repo'
import { budgetTotals, compareMonths, monthBudgetStatuses, type BudgetStatus } from '@/lib/calc/budget'
import { addMonthKey, formatMonth, monthOf } from '@/lib/dates'
import { formatINR, paiseToInput, parseRupees } from '@/lib/money'

const schema = z.object({
  categoryId: z.string().min(1, 'Choose a category'),
  amount: z.string().refine((v) => {
    const p = parseRupees(v)
    return p !== null && p > 0
  }, 'Enter an amount greater than zero'),
})
type FV = z.infer<typeof schema>

function BudgetForm({ month, edit, free, onClose }: { month: string; edit?: BudgetStatus; free: { id: string; name: string }[]; onClose: () => void }) {
  const toast = useToast()
  const { register, handleSubmit, setError, formState: { errors } } = useForm<FV>({
    resolver: zodResolver(schema),
    defaultValues: { categoryId: edit?.budget.categoryId ?? '', amount: edit ? paiseToInput(edit.budget.amount) : '' },
  })
  const submit = handleSubmit(async (v) => {
    try {
      await repo.upsert(v.categoryId, month, parseRupees(v.amount)!)
      toast(edit ? 'Budget updated' : 'Budget created')
      onClose()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Category" id="b-cat" error={errors.categoryId?.message}>
        {/* a disabled registered input would submit undefined, so the category is made non-interactive when editing */}
        <select {...fp('b-cat', errors.categoryId?.message)} className="input" {...register('categoryId')} style={edit ? { pointerEvents: 'none', opacity: 0.6 } : undefined} tabIndex={edit ? -1 : undefined}>
          <option value="">Select…</option>
          {free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label={`Monthly budget for ${formatMonth(month)} (₹)`} id="b-amount" error={errors.amount?.message}>
        <input {...fp('b-amount', errors.amount?.message)} className="input" inputMode="decimal" autoFocus {...register('amount')} />
      </Field>
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary">{edit ? 'Save budget' : 'Create budget'}</button>
      </div>
    </form>
  )
}

export default function BudgetsPage() {
  const d = useData()
  const confirm = useConfirm()
  const toast = useToast()
  const [month, setMonth] = useState(monthOf(d.today))
  const [modal, setModal] = useState<{ edit?: BudgetStatus } | null>(null)

  const statuses = useMemo(() => monthBudgetStatuses(d.budgets, d.transactions, month), [d.budgets, d.transactions, month])
  const totals = budgetTotals(statuses)
  const budgeted = new Set(statuses.map((s) => s.budget.categoryId))
  const expenseCats = d.categories.filter((c) => c.kind === 'expense').sort((a, b) => a.name.localeCompare(b.name))
  const free = expenseCats.filter((c) => !budgeted.has(c.id))
  const prev = addMonthKey(month, -1)
  const prevCount = d.budgets.filter((b) => b.month === prev).length

  const months3 = [addMonthKey(month, -2), addMonthKey(month, -1), month]
  const cmp = useMemo(() => compareMonths(d.transactions, months3), [d.transactions, month]) // eslint-disable-line react-hooks/exhaustive-deps
  const cmpRows = [...cmp.entries()]
    .map(([id, vals]) => ({ id, name: d.catMap.get(id)?.name ?? 'Uncategorised', vals, budget: statuses.find((s) => s.budget.categoryId === id)?.budget.amount }))
    .filter((r) => r.vals.some((v) => v > 0))
    .sort((a, b) => b.vals[2] - a.vals[2])

  const del = async (s: BudgetStatus) => {
    const name = d.catMap.get(s.budget.categoryId)?.name
    if (await confirm({ title: 'Delete budget?', message: `The ${name} budget for ${formatMonth(month)} will be removed. Your transactions are not affected.` })) {
      await repo.remove(s.budget.id)
      toast('Budget deleted')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Budgets"
        subtitle="Set a monthly limit per category and track it live"
        actions={
          <>
            {prevCount > 0 && (
              <button type="button" className="btn-secondary" onClick={async () => toast(`Copied ${await repo.copyMonth(prev, month)} budget(s) from ${formatMonth(prev)}`)}>
                <Copy size={16} /> Copy {formatMonth(prev)}
              </button>
            )}
            <button type="button" className="btn-primary" onClick={() => setModal({})} disabled={free.length === 0}><Plus size={16} /> Add budget</button>
          </>
        }
      />
      <div className="flex items-center gap-2" role="group" aria-label="Budget month">
        <button type="button" className="btn-secondary !px-2.5" onClick={() => setMonth(addMonthKey(month, -1))} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <span className="min-w-[110px] text-center font-bold" aria-live="polite">{formatMonth(month)}</span>
        <button type="button" className="btn-secondary !px-2.5" onClick={() => setMonth(addMonthKey(month, 1))} aria-label="Next month"><ChevronRight size={18} /></button>
      </div>

      {statuses.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Budgeted" value={formatINR(totals.budget)} />
          <Stat label="Spent" value={formatINR(totals.spent)} />
          <Stat label="Remaining" value={formatINR(totals.remaining)} tone={totals.remaining < 0 ? 'neg' : 'pos'} />
          <Stat label="Used" value={`${Math.round(totals.percentUsed)}%`} tone={totals.percentUsed > 100 ? 'neg' : totals.percentUsed >= 80 ? 'warn' : undefined} />
        </div>
      )}

      {statuses.length === 0 ? (
        <EmptyState icon={<PiggyBank size={32} />} title={`No budgets for ${formatMonth(month)}`} text="Create a budget for a category such as Groceries to track spending against a limit." action={<button type="button" className="btn-primary" onClick={() => setModal({})}>Add budget</button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {statuses.map((s) => {
            const name = d.catMap.get(s.budget.categoryId)?.name ?? 'Category'
            return (
              <article key={s.budget.id} className="card p-4" aria-label={`${name} budget`}>
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold">{name} {s.budget.isSample && <Badge tone="warn">Sample</Badge>}</h3>
                    <p className="num text-xs text-subtle">Budget {formatINR(s.budget.amount)}</p>
                  </div>
                  <div className="flex">
                    <button type="button" className="btn-ghost !min-h-[34px] !px-2" onClick={() => setModal({ edit: s })} aria-label={`Edit ${name} budget`}><Pencil size={16} /></button>
                    <button type="button" className="btn-ghost !min-h-[34px] !px-2 hover:!text-neg" onClick={() => del(s)} aria-label={`Delete ${name} budget`}><Trash2 size={16} /></button>
                  </div>
                </div>
                <div className="mt-3"><ProgressBar value={s.percentUsed} tone={s.state === 'over' ? 'neg' : s.state === 'warning' ? 'warn' : 'brand'} label={`${name} budget used`} /></div>
                <div className="num mt-2 flex flex-wrap justify-between gap-x-3 text-sm">
                  <span>Spent <strong>{formatINR(s.spent)}</strong></span>
                  <span>{Number.isFinite(s.percentUsed) ? Math.round(s.percentUsed) : '∞'}% used</span>
                  <span className={s.remaining < 0 ? 'font-semibold text-neg' : 'text-pos'}>{s.remaining < 0 ? `Over by ${formatINR(-s.remaining)}` : `${formatINR(s.remaining)} left`}</span>
                </div>
                {s.state === 'over' && <p role="alert" className="mt-2 text-xs font-semibold text-neg">⚠ Over budget</p>}
                {s.state === 'warning' && <p className="mt-2 text-xs font-semibold text-warn">Approaching the limit (80%+ used)</p>}
              </article>
            )
          })}
        </div>
      )}

      {cmpRows.length > 0 && (
        <Section title="Spending comparison">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">Spending by category across the last three months</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-subtle">
                  <th scope="col" className="py-2 pr-3">Category</th>
                  {months3.map((m) => <th key={m} scope="col" className="py-2 pr-3 text-right">{formatMonth(m)}</th>)}
                  <th scope="col" className="py-2 text-right">Budget</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cmpRows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium">{r.name}</th>
                    {r.vals.map((v, i) => <td key={i} className="num py-2 pr-3 text-right">{formatINR(v)}</td>)}
                    <td className="num py-2 text-right text-subtle">{r.budget ? formatINR(r.budget) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.edit ? 'Edit budget' : 'Add budget'}>
        {modal && <BudgetForm month={month} edit={modal.edit} free={modal.edit ? expenseCats : free} onClose={() => setModal(null)} />}
      </Modal>
    </div>
  )
}
