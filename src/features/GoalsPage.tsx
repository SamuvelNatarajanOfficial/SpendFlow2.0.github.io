import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Pencil, Plus, Target, Trash2 } from 'lucide-react'
import { useData } from '@/app/data'
import { Badge, EmptyState, Field, fp, Modal, Notice, PageHeader, ProgressBar, Section, useConfirm, useToast } from '@/components/ui'
import { goals as repo } from '@/db/repo'
import { allocationByAccount, goalProgress } from '@/lib/calc/goals'
import { formatDate, isValidDate } from '@/lib/dates'
import { formatINR, paiseToInput, parseRupees } from '@/lib/money'
import { GOAL_KINDS, type Goal } from '@/types'

const schema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(60),
    kind: z.enum(['emergency', 'savings', 'debt-free', 'purchase', 'custom']),
    target: z.string(),
    saved: z.string().refine((v) => v === '' || (parseRupees(v) ?? -1) >= 0, 'Enter a valid amount'),
    targetDate: z.string().refine((v) => v === '' || isValidDate(v), 'Enter a valid date'),
    accountId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'debt-free' && (parseRupees(v.target) ?? 0) <= 0) ctx.addIssue({ code: 'custom', path: ['target'], message: 'Target must be greater than zero' })
  })
type FV = z.infer<typeof schema>

function GoalForm({ edit, onClose }: { edit?: Goal; onClose: () => void }) {
  const { accounts } = useData()
  const toast = useToast()
  const { register, handleSubmit, control, setError, formState: { errors } } = useForm<FV>({
    resolver: zodResolver(schema),
    defaultValues: { name: edit?.name ?? '', kind: edit?.kind ?? 'savings', target: edit ? paiseToInput(edit.target) : '', saved: edit ? paiseToInput(edit.saved) : '0', targetDate: edit?.targetDate ?? '', accountId: edit?.accountId ?? '' },
  })
  const kind = useWatch({ control, name: 'kind' })
  const submit = handleSubmit(async (v) => {
    const payload = {
      name: v.name, kind: v.kind, target: v.kind === 'debt-free' ? 0 : parseRupees(v.target)!, saved: v.kind === 'debt-free' ? 0 : parseRupees(v.saved || '0')!,
      targetDate: v.targetDate || undefined, accountId: v.kind === 'debt-free' ? undefined : v.accountId || undefined,
    }
    try {
      if (edit) await repo.update(edit.id, payload)
      else await repo.create(payload)
      toast(edit ? 'Goal updated' : 'Goal created')
      onClose()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Goal name" id="g-name" error={errors.name?.message}><input {...fp('g-name', errors.name?.message)} className="input" autoFocus {...register('name')} /></Field>
      <Field label="Goal type" id="g-kind">
        <select id="g-kind" className="input" {...register('kind')}>{GOAL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
      </Field>
      {kind === 'debt-free' ? (
        <p className="rounded-xl bg-muted p-3 text-sm text-subtle">Progress is calculated automatically from the principal you've repaid across all your loans.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Target amount (₹)" id="g-target" error={errors.target?.message}><input {...fp('g-target', errors.target?.message)} className="input" inputMode="decimal" {...register('target')} /></Field>
            <Field label="Saved so far (₹)" id="g-saved" error={errors.saved?.message}><input {...fp('g-saved', errors.saved?.message)} className="input" inputMode="decimal" {...register('saved')} /></Field>
          </div>
          <Field label="Money is held in account" id="g-acc" hint="Goals earmark money already in an account. They are never added on top of your balance.">
            <select id="g-acc" className="input" {...register('accountId')}>
              <option value="">Not linked</option>
              {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </>
      )}
      <Field label="Target date (optional)" id="g-date" error={errors.targetDate?.message}><input {...fp('g-date', errors.targetDate?.message)} type="date" className="input" {...register('targetDate')} /></Field>
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary">{edit ? 'Save goal' : 'Create goal'}</button>
      </div>
    </form>
  )
}

function AddFundsForm({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const toast = useToast()
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  return (
    <form noValidate className="space-y-4" onSubmit={async (e) => {
      e.preventDefault()
      const p = parseRupees(v)
      if (p === null || p === 0) return setErr('Enter a non-zero amount (negative to withdraw)')
      if (goal.saved + p < 0) return setErr('Cannot withdraw more than is saved')
      await repo.update(goal.id, { saved: goal.saved + p })
      toast('Goal updated')
      onClose()
    }}>
      <p className="text-sm text-subtle">This only updates the earmarked amount. It does not create a transaction or move money between accounts.</p>
      <Field label="Amount to add (₹)" id="gf-amt" error={err}><input {...fp('gf-amt', err)} className="input" inputMode="decimal" autoFocus value={v} onChange={(e) => { setV(e.target.value); setErr('') }} /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn-primary">Update</button></div>
    </form>
  )
}

export default function GoalsPage() {
  const d = useData()
  const confirm = useConfirm()
  const toast = useToast()
  const [modal, setModal] = useState<{ edit?: Goal } | null>(null)
  const [funds, setFunds] = useState<Goal | null>(null)
  const progress = d.goals.map((g) => goalProgress(g, d.loans, d.today))
  const alloc = allocationByAccount(d.accounts, d.transactions, d.goals)
  const over = alloc.filter((a) => a.overAllocated)

  return (
    <div className="space-y-5">
      <PageHeader title="Savings & goals" subtitle="Earmark money you already have toward what matters" actions={<button type="button" className="btn-primary" onClick={() => setModal({})}><Plus size={16} /> New goal</button>} />
      <Notice>Goals are <strong>earmarks</strong>, not extra money. Their saved amounts are part of your account balances, so they are never added to your total balance.</Notice>
      {over.map((a) => (
        <Notice key={a.accountId} tone="warn">
          Goals earmark <strong>{formatINR(a.earmarked)}</strong> in {d.accMap.get(a.accountId)?.name}, but the account's calculated balance is only <strong>{formatINR(a.balance)}</strong>.
        </Notice>
      ))}
      {d.goals.length === 0 ? (
        <EmptyState icon={<Target size={32} />} title="No goals yet" text="Create an emergency fund, a savings target or a debt-free goal." action={<button type="button" className="btn-primary" onClick={() => setModal({})}>New goal</button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {progress.map((p) => (
            <article key={p.goal.id} className="card p-4" aria-label={p.goal.name}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-bold">{p.goal.name} {p.goal.isSample && <Badge tone="warn">Sample</Badge>}</h3>
                  <p className="text-xs text-subtle">{GOAL_KINDS.find((k) => k.value === p.goal.kind)?.label}{p.goal.targetDate && ` · by ${formatDate(p.goal.targetDate)}`}</p>
                </div>
                <div className="flex">
                  <button type="button" className="btn-ghost !min-h-[34px] !px-2" aria-label={`Edit ${p.goal.name}`} onClick={() => setModal({ edit: p.goal })}><Pencil size={16} /></button>
                  <button type="button" className="btn-ghost !min-h-[34px] !px-2 hover:!text-neg" aria-label={`Delete ${p.goal.name}`} onClick={async () => { if (await confirm({ title: 'Delete goal?', message: `"${p.goal.name}" will be removed. No money or transactions are affected.` })) { await repo.remove(p.goal.id); toast('Goal deleted') } }}><Trash2 size={16} /></button>
                </div>
              </div>
              <div className="mt-3 flex items-end justify-between">
                <p className="num text-2xl font-bold">{formatINR(p.current)}</p>
                <p className="num text-sm text-subtle">{Math.round(p.percent)}%</p>
              </div>
              <div className="mt-2"><ProgressBar value={p.percent} label={`${p.goal.name} progress`} /></div>
              <p className="num mt-2 text-xs text-subtle">
                {p.achieved ? <span className="font-semibold text-pos">Goal reached 🎉</span> : <>{formatINR(p.remaining)} to go{p.monthlyNeeded !== null && <> · save about <strong>{formatINR(p.monthlyNeeded)}</strong>/month</>}</>}
                {p.goal.kind !== 'debt-free' && p.goal.accountId && <> · in {d.accMap.get(p.goal.accountId)?.name}</>}
              </p>
              {p.goal.kind !== 'debt-free' && <button type="button" className="btn-secondary mt-3 !min-h-[36px]" onClick={() => setFunds(p.goal)}>Add / withdraw funds</button>}
            </article>
          ))}
        </div>
      )}
      {alloc.some((a) => a.earmarked > 0) && (
        <Section title="Earmarked vs account balance">
          <ul className="divide-y divide-line text-sm">
            {alloc.filter((a) => a.earmarked > 0).map((a) => (
              <li key={a.accountId} className="num flex flex-wrap justify-between gap-2 py-2">
                <span className="font-medium">{d.accMap.get(a.accountId)?.name}</span>
                <span>Balance {formatINR(a.balance)} · earmarked {formatINR(a.earmarked)} · free <strong className={a.free < 0 ? 'text-neg' : ''}>{formatINR(a.free)}</strong></span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.edit ? 'Edit goal' : 'New goal'}>{modal && <GoalForm edit={modal.edit} onClose={() => setModal(null)} />}</Modal>
      <Modal open={!!funds} onClose={() => setFunds(null)} title={`Update ${funds?.name ?? ''}`}>{funds && <AddFundsForm goal={funds} onClose={() => setFunds(null)} />}</Modal>
    </div>
  )
}
