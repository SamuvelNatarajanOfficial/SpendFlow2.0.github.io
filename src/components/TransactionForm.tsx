import { useEffect, useMemo } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useData } from '@/app/data'
import { Field, fp, Modal, useToast } from './ui'
import { transactions as repo } from '@/db/repo'
import { addDays, isValidDate } from '@/lib/dates'
import { paiseToInput, parseRupees } from '@/lib/money'
import { PAYMENT_METHODS, type Transaction, type TxType } from '@/types'

const MIN_DATE = '2000-01-01'

function buildSchema(today: string) {
  const maxDate = addDays(today, 365)
  return z
    .object({
      type: z.enum(['income', 'expense', 'transfer']),
      amount: z.string().refine((v) => {
        const p = parseRupees(v)
        return p !== null && p > 0
      }, 'Enter an amount greater than zero, up to 2 decimals'),
      date: z.string().refine(isValidDate, 'Enter a valid date').refine((d) => !isValidDate(d) || (d >= MIN_DATE && d <= maxDate), 'Date must be between 2000 and one year from today'),
      accountId: z.string().min(1, 'Choose an account'),
      toAccountId: z.string().optional(),
      categoryId: z.string().optional(),
      paymentMethod: z.enum(['cash', 'upi', 'card', 'netbanking', 'cheque', 'auto-debit', 'other']),
      merchant: z.string().max(80, 'Max 80 characters').optional(),
      notes: z.string().max(300, 'Max 300 characters').optional(),
      essential: z.boolean(),
      recurring: z.enum(['', 'weekly', 'monthly', 'yearly']),
    })
    .superRefine((v, ctx) => {
      if (v.type === 'transfer') {
        if (!v.toAccountId) ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'Choose the destination account' })
        else if (v.toAccountId === v.accountId) ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'Source and destination must differ' })
      } else if (!v.categoryId) ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'Choose a category' })
    })
}
type FormValues = z.infer<ReturnType<typeof buildSchema>>

export interface TxModalProps {
  open: boolean
  onClose: () => void
  /** edit an existing transaction */
  edit?: Transaction
  /** initial type for a new transaction */
  type?: TxType
}

export function TransactionModal({ open, onClose, edit, type }: TxModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Edit transaction' : 'Add transaction'}>
      {open && <TransactionForm edit={edit} type={type} onDone={onClose} />}
    </Modal>
  )
}

function TransactionForm({ edit, type, onDone }: { edit?: Transaction; type?: TxType; onDone: () => void }) {
  const { accounts, categories, today, catMap } = useData()
  const toast = useToast()
  const schema = useMemo(() => buildSchema(today), [today])
  const active = accounts.filter((a) => !a.archived || a.id === edit?.accountId || a.id === edit?.toAccountId)

  const { register, handleSubmit, control, setValue, setError, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: edit
      ? {
          type: edit.type, amount: paiseToInput(edit.amount), date: edit.date, accountId: edit.accountId, toAccountId: edit.toAccountId ?? '',
          categoryId: edit.categoryId ?? '', paymentMethod: edit.paymentMethod, merchant: edit.merchant ?? '', notes: edit.notes ?? '',
          essential: !!edit.essential, recurring: edit.recurring ?? '',
        }
      : {
          type: type ?? 'expense', amount: '', date: today, accountId: active[0]?.id ?? '', toAccountId: '', categoryId: '', paymentMethod: 'upi',
          merchant: '', notes: '', essential: false, recurring: '',
        },
  })
  const t = useWatch({ control, name: 'type' })
  const categoryId = useWatch({ control, name: 'categoryId' })
  const kindCats = categories.filter((c) => c.kind === t).sort((a, b) => a.name.localeCompare(b.name))

  // keep category valid when switching between income/expense
  useEffect(() => {
    if (t !== 'transfer' && categoryId && catMap.get(categoryId)?.kind !== t) setValue('categoryId', '')
  }, [t, categoryId, catMap, setValue])

  if (active.length === 0) {
    return <p className="text-sm text-subtle">Create an account first (Accounts page), then you can record transactions.</p>
  }

  const onSubmit = handleSubmit(async (v) => {
    const payload = {
      type: v.type, amount: parseRupees(v.amount)!, date: v.date, accountId: v.accountId,
      toAccountId: v.type === 'transfer' ? v.toAccountId : undefined,
      categoryId: v.type === 'transfer' ? undefined : v.categoryId,
      paymentMethod: v.paymentMethod, merchant: v.type === 'transfer' ? undefined : v.merchant?.trim() || undefined,
      notes: v.notes?.trim() || undefined, essential: v.type === 'expense' ? v.essential : undefined,
      recurring: v.type === 'transfer' || !v.recurring ? undefined : v.recurring,
    }
    try {
      if (edit) await repo.update(edit.id, payload)
      else await repo.create(payload)
      toast(edit ? 'Transaction updated' : v.type === 'transfer' ? 'Transfer recorded' : `${v.type === 'income' ? 'Income' : 'Expense'} added`)
      onDone()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <fieldset>
        <legend className="label">Type</legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Transaction type">
          {(['expense', 'income', 'transfer'] as const).map((k) => (
            <label key={k} className="cursor-pointer">
              <input type="radio" value={k} className="peer sr-only" disabled={!!edit && edit.type !== k} {...register('type')} />
              <span className="flex min-h-[38px] items-center justify-center rounded-lg text-sm font-semibold capitalize text-subtle peer-checked:bg-card peer-checked:text-fg peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-disabled:opacity-40">
                {k}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (₹)" id="tx-amount" error={errors.amount?.message}>
          <input {...fp('tx-amount', errors.amount?.message)} className="input" inputMode="decimal" placeholder="0.00" autoComplete="off" autoFocus {...register('amount')} />
        </Field>
        <Field label="Date" id="tx-date" error={errors.date?.message}>
          <input {...fp('tx-date', errors.date?.message)} type="date" className="input" {...register('date')} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t === 'transfer' ? 'From account' : 'Account'} id="tx-account" error={errors.accountId?.message}>
          <select {...fp('tx-account', errors.accountId?.message)} className="input" {...register('accountId')}>
            <option value="">Select…</option>
            {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        {t === 'transfer' ? (
          <Field label="To account" id="tx-to" error={errors.toAccountId?.message}>
            <select {...fp('tx-to', errors.toAccountId?.message)} className="input" {...register('toAccountId')}>
              <option value="">Select…</option>
              {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Category" id="tx-category" error={errors.categoryId?.message}>
            <select {...fp('tx-category', errors.categoryId?.message)} className="input" {...register('categoryId')}>
              <option value="">Select…</option>
              {kindCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
      </div>

      {t !== 'transfer' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t === 'income' ? 'Source / payer' : 'Merchant'} id="tx-merchant" error={errors.merchant?.message}>
            <input {...fp('tx-merchant', errors.merchant?.message)} className="input" {...register('merchant')} />
          </Field>
          <Field label="Payment method" id="tx-method">
            <select id="tx-method" className="input" {...register('paymentMethod')}>
              {PAYMENT_METHODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
        </div>
      )}

      <Field label="Notes" id="tx-notes" error={errors.notes?.message}>
        <textarea {...fp('tx-notes', errors.notes?.message)} className="input !min-h-[64px] py-2" rows={2} {...register('notes')} />
      </Field>

      {t !== 'transfer' && (
        <div className="grid grid-cols-2 items-end gap-3">
          <Field label="Repeats" id="tx-recurring">
            <select id="tx-recurring" className="input" {...register('recurring')}>
              <option value="">Does not repeat</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </Field>
          {t === 'expense' && (
            <label className="flex min-h-[42px] items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" {...register('essential')} />
              Essential spending
            </label>
          )}
        </div>
      )}
      {t === 'transfer' && <p className="text-xs text-subtle">Transfers between your own accounts are not income or expense and don't affect savings totals.</p>}

      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={isSubmitting}>{edit ? 'Save changes' : 'Save'}</button>
      </div>
    </form>
  )
}
