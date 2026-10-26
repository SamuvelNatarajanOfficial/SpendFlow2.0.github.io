import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Archive, ArchiveRestore, ArrowLeftRight, Pencil, Plus, Trash2, Wallet } from 'lucide-react'
import { useData } from '@/app/data'
import { useUI } from '@/app/ui-context'
import { Badge, EmptyState, Field, fp, Modal, PageHeader, Section, Stat, useConfirm, useToast } from '@/components/ui'
import { TransactionList } from '@/components/TransactionList'
import { accounts as repo, transactions as txRepo } from '@/db/repo'
import { accountBalance, reconciliationDiff, sortTx, totalBalance } from '@/lib/calc/ledger'
import { formatDate, isValidDate } from '@/lib/dates'
import { formatINR, paiseToInput, parseRupees } from '@/lib/money'
import { ACCOUNT_TYPES, type Account } from '@/types'

const schema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(60, 'Max 60 characters'),
    type: z.enum(['cash', 'savings', 'current', 'upi', 'other']),
    opening: z.string().refine((v) => parseRupees(v) !== null, 'Enter a valid amount (negative allowed)'),
    actual: z.string().refine((v) => v === '' || parseRupees(v) !== null, 'Enter a valid amount'),
    actualDate: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.actual !== '' && !isValidDate(v.actualDate)) ctx.addIssue({ code: 'custom', path: ['actualDate'], message: 'Enter the date of that balance' })
  })
type FV = z.infer<typeof schema>

function AccountModal({ edit, onClose, today }: { edit?: Account | null; onClose: () => void; today: string }) {
  const toast = useToast()
  const { register, handleSubmit, setError, formState: { errors } } = useForm<FV>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: edit?.name ?? '', type: edit?.type ?? 'savings', opening: edit ? paiseToInput(edit.openingBalance) : '0',
      actual: edit?.actualBalance ? paiseToInput(edit.actualBalance.amount) : '', actualDate: edit?.actualBalance?.asOf ?? today,
    },
  })
  const submit = handleSubmit(async (v) => {
    const payload = {
      name: v.name, type: v.type, openingBalance: parseRupees(v.opening)!,
      actualBalance: v.actual === '' ? undefined : { amount: parseRupees(v.actual)!, asOf: v.actualDate },
    }
    try {
      if (edit) await repo.update(edit.id, payload)
      else await repo.create(payload)
      toast(edit ? 'Account updated' : 'Account added')
      onClose()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Account name" id="acc-name" error={errors.name?.message}>
        <input {...fp('acc-name', errors.name?.message)} className="input" autoFocus {...register('name')} />
      </Field>
      <Field label="Type" id="acc-type">
        <select id="acc-type" className="input" {...register('type')}>
          {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      <Field label="Opening balance (₹)" id="acc-opening" error={errors.opening?.message} hint="Balance before your first tracked transaction.">
        <input {...fp('acc-opening', errors.opening?.message, 'x')} className="input" inputMode="decimal" {...register('opening')} />
      </Field>
      <fieldset className="rounded-xl border border-line p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-subtle">Reconcile with your bank (optional)</legend>
        <p className="mb-3 text-xs text-subtle">Enter the balance your bank shows. SpendFlow compares it with the balance it calculated from your records and shows the difference.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Actual bank balance (₹)" id="acc-actual" error={errors.actual?.message}>
            <input {...fp('acc-actual', errors.actual?.message)} className="input" inputMode="decimal" {...register('actual')} />
          </Field>
          <Field label="As of" id="acc-actual-date" error={errors.actualDate?.message}>
            <input {...fp('acc-actual-date', errors.actualDate?.message)} type="date" className="input" {...register('actualDate')} />
          </Field>
        </div>
      </fieldset>
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary">{edit ? 'Save changes' : 'Add account'}</button>
      </div>
    </form>
  )
}

export default function AccountsPage() {
  const d = useData()
  const { openTransaction } = useUI()
  const confirm = useConfirm()
  const toast = useToast()
  const [modal, setModal] = useState<{ edit?: Account } | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const list = d.accounts.filter((a) => showArchived || !a.archived)
  const transfers = sortTx(d.transactions.filter((t) => t.type === 'transfer'))

  const remove = async (a: Account) => {
    const u = await repo.usage(a.id)
    if (u.used) {
      toast(`"${a.name}" has ${u.tx} transaction(s), ${u.loans} loan(s) and ${u.goals} goal(s) linked, so it can only be archived.`, 'error')
      return
    }
    if (await confirm({ title: 'Delete account?', message: <>"{a.name}" has no transactions and will be permanently deleted.</> })) {
      await repo.remove(a.id)
      toast('Account deleted')
    }
  }
  const toggleArchive = async (a: Account) => {
    if (!a.archived && !(await confirm({ title: 'Archive account?', confirmLabel: 'Archive', danger: false, message: <>"{a.name}" will be hidden from new entries and excluded from total balance. Its history is kept.</> }))) return
    await repo.update(a.id, { archived: !a.archived })
    toast(a.archived ? 'Account restored' : 'Account archived')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        subtitle="Manually managed. Balances are calculated from your records."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => openTransaction({ type: 'transfer' })} disabled={d.accounts.filter((a) => !a.archived).length < 2}>
              <ArrowLeftRight size={16} /> Transfer
            </button>
            <button type="button" className="btn-primary" onClick={() => setModal({})}><Plus size={16} /> Add account</button>
          </>
        }
      />
      <Stat label="Total across accounts" value={formatINR(totalBalance(d.accounts, d.transactions))} sub="Transfers between accounts never change this total" />

      {list.length === 0 ? (
        <EmptyState icon={<Wallet size={32} />} title="No accounts yet" text="Add cash, a bank account or a UPI wallet with its opening balance." action={<button type="button" className="btn-primary" onClick={() => setModal({})}>Add account</button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((a) => {
            const bal = accountBalance(a, d.transactions)
            const diff = reconciliationDiff(a, d.transactions)
            return (
              <article key={a.id} className="card p-4" aria-label={a.name}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold">{a.name}</h3>
                    <p className="flex items-center gap-1.5 text-xs text-subtle">{ACCOUNT_TYPES.find((t) => t.value === a.type)?.label} {a.archived && <Badge>Archived</Badge>} {a.isSample && <Badge tone="warn">Sample</Badge>}</p>
                  </div>
                  <div className="flex">
                    <button type="button" className="btn-ghost !min-h-[34px] !px-2" aria-label={`Edit ${a.name}`} onClick={() => setModal({ edit: a })}><Pencil size={16} /></button>
                    <button type="button" className="btn-ghost !min-h-[34px] !px-2" aria-label={`${a.archived ? 'Restore' : 'Archive'} ${a.name}`} onClick={() => toggleArchive(a)}>{a.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
                    <button type="button" className="btn-ghost !min-h-[34px] !px-2 hover:!text-neg" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}><Trash2 size={16} /></button>
                  </div>
                </div>
                <p className="num mt-3 text-2xl font-bold" aria-label={`Calculated balance ${formatINR(bal)}`}>{formatINR(bal)}</p>
                <p className="text-xs text-subtle">Calculated balance · opening {formatINR(a.openingBalance)}</p>
                {a.actualBalance && (
                  <div className="mt-3 rounded-xl bg-muted p-3 text-xs">
                    <p>Bank showed <strong className="num">{formatINR(a.actualBalance.amount)}</strong> on {formatDate(a.actualBalance.asOf)}</p>
                    {diff === 0 ? <p className="mt-0.5 font-semibold text-pos">Matches your records ✓</p> : (
                      <p className="mt-0.5 font-semibold text-warn">Difference {diff! > 0 ? '+' : '−'}{formatINR(Math.abs(diff!))}: {diff! > 0 ? 'income or credits may be missing' : 'expenses may be missing'} in SpendFlow.</p>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
      {d.accounts.some((a) => a.archived) && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[rgb(var(--brand))]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived accounts</label>
      )}

      <Section title="Transfers between your accounts">
        {transfers.length === 0 ? <p className="text-sm text-subtle">No transfers yet. Transfers are not income or expenses.</p> : (
          <TransactionList txs={transfers.slice(0, 20)} onEdit={(t) => openTransaction({ edit: t })} onDelete={async (t) => {
            if (await confirm({ title: 'Delete transfer?', message: `${formatINR(t.amount)} on ${formatDate(t.date)} will be removed from both accounts.` })) { await txRepo.remove(t.id); toast('Transfer deleted') }
          }} />
        )}
      </Section>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.edit ? 'Edit account' : 'Add account'}>
        {modal && <AccountModal edit={modal.edit} onClose={() => setModal(null)} today={d.today} />}
      </Modal>
    </div>
  )
}
