import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useData } from '@/app/data'
import { Field, fp, Modal, useToast } from '@/components/ui'
import { loans as repo } from '@/db/repo'
import { calcEmi, expectedEndDate, splitPayment } from '@/lib/calc/loan'
import { isValidDate } from '@/lib/dates'
import { formatINR, paiseToInput, parseRupees } from '@/lib/money'
import type { Loan } from '@/types'

const money = (msg: string, allowZero = false) =>
  z.string().refine((v) => {
    const p = parseRupees(v)
    return p !== null && (allowZero ? p >= 0 : p > 0)
  }, msg)

const loanSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(60),
    lender: z.string().trim().max(60),
    principal: money('Enter the original principal'),
    outstanding: z.string().refine((v) => v === '' || (parseRupees(v) ?? -1) >= 0, 'Enter a valid amount'),
    rate: z.string().refine((v) => v.trim() !== '' && !isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100, 'Enter a rate between 0 and 100'),
    emi: money('Enter the EMI amount'),
    dueDay: z.string().refine((v) => /^\d+$/.test(v) && +v >= 1 && +v <= 31, 'Day must be 1 to 31'),
    startDate: z.string().refine(isValidDate, 'Enter a valid date'),
    tenure: z.string().refine((v) => /^\d+$/.test(v) && +v >= 1 && +v <= 600, 'Tenure must be 1 to 600 months'),
    accountId: z.string(),
    notes: z.string().max(300),
  })
  .superRefine((v, ctx) => {
    const p = parseRupees(v.principal), o = v.outstanding === '' ? p : parseRupees(v.outstanding)
    if (p !== null && o !== null && o > p) ctx.addIssue({ code: 'custom', path: ['outstanding'], message: 'Outstanding cannot exceed the original principal' })
  })
type LV = z.infer<typeof loanSchema>

export function LoanModal({ open, onClose, edit }: { open: boolean; onClose: () => void; edit?: Loan }) {
  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Edit loan' : 'Add loan'}>
      {open && <LoanForm edit={edit} onDone={onClose} />}
    </Modal>
  )
}

function LoanForm({ edit, onDone }: { edit?: Loan; onDone: () => void }) {
  const { accounts, today } = useData()
  const toast = useToast()
  const { register, handleSubmit, control, setValue, getValues, setError, formState: { errors } } = useForm<LV>({
    resolver: zodResolver(loanSchema),
    defaultValues: edit
      ? {
          name: edit.name, lender: edit.lender, principal: paiseToInput(edit.principal), outstanding: paiseToInput(edit.outstanding), rate: String(edit.annualRate),
          emi: paiseToInput(edit.emi), dueDay: String(edit.dueDay), startDate: edit.startDate, tenure: String(edit.tenureMonths), accountId: edit.accountId ?? '', notes: edit.notes ?? '',
        }
      : { name: '', lender: '', principal: '', outstanding: '', rate: '', emi: '', dueDay: '5', startDate: today, tenure: '', accountId: accounts.find((a) => !a.archived)?.id ?? '', notes: '' },
  })
  const startDate = useWatch({ control, name: 'startDate' })
  const tenure = useWatch({ control, name: 'tenure' })
  const endPreview = isValidDate(startDate) && /^\d+$/.test(tenure) && +tenure > 0 ? expectedEndDate({ startDate, tenureMonths: +tenure }) : null

  const suggestEmi = () => {
    const v = getValues()
    const p = parseRupees(v.principal)
    if (p && p > 0 && /^\d+$/.test(v.tenure) && v.rate !== '' && !isNaN(Number(v.rate))) setValue('emi', paiseToInput(calcEmi(p, Number(v.rate), +v.tenure)), { shouldValidate: true })
    else toast('Enter principal, rate and tenure first', 'error')
  }

  const submit = handleSubmit(async (v) => {
    const principal = parseRupees(v.principal)!
    const payload = {
      name: v.name, lender: v.lender, principal, outstanding: v.outstanding === '' ? principal : parseRupees(v.outstanding)!, annualRate: Number(v.rate),
      emi: parseRupees(v.emi)!, dueDay: +v.dueDay, startDate: v.startDate, tenureMonths: +v.tenure,
      endDate: expectedEndDate({ startDate: v.startDate, tenureMonths: +v.tenure }), accountId: v.accountId || undefined, notes: v.notes || undefined,
    }
    try {
      if (edit) await repo.update(edit.id, payload)
      else await repo.create(payload)
      toast(edit ? 'Loan updated' : 'Loan added')
      onDone()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Loan name" id="l-name" error={errors.name?.message}><input {...fp('l-name', errors.name?.message)} className="input" autoFocus {...register('name')} /></Field>
        <Field label="Lender" id="l-lender" error={errors.lender?.message}><input {...fp('l-lender', errors.lender?.message)} className="input" {...register('lender')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Original principal (₹)" id="l-principal" error={errors.principal?.message}><input {...fp('l-principal', errors.principal?.message)} className="input" inputMode="decimal" {...register('principal')} /></Field>
        <Field label="Annual interest rate (%)" id="l-rate" error={errors.rate?.message}><input {...fp('l-rate', errors.rate?.message)} className="input" inputMode="decimal" {...register('rate')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" id="l-start" error={errors.startDate?.message}><input {...fp('l-start', errors.startDate?.message)} type="date" className="input" {...register('startDate')} /></Field>
        <Field label="Tenure (months)" id="l-tenure" error={errors.tenure?.message} hint={endPreview ? `Expected end: ${endPreview}` : undefined}><input {...fp('l-tenure', errors.tenure?.message, endPreview ? 'x' : undefined)} className="input" inputMode="numeric" {...register('tenure')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="EMI (₹)" id="l-emi" error={errors.emi?.message}>
          <div className="flex gap-2">
            <input {...fp('l-emi', errors.emi?.message)} className="input" inputMode="decimal" {...register('emi')} />
            <button type="button" className="btn-secondary shrink-0" onClick={suggestEmi} title="Calculate from principal, rate and tenure">Calc</button>
          </div>
        </Field>
        <Field label="Due day of month" id="l-due" error={errors.dueDay?.message}><input {...fp('l-due', errors.dueDay?.message)} className="input" inputMode="numeric" {...register('dueDay')} /></Field>
      </div>
      <Field
        label="Current outstanding principal (₹)"
        id="l-out"
        error={errors.outstanding?.message}
        hint={edit ? 'Manual correction: set this to match your lender statement. Future estimates use this figure.' : 'Leave blank for a new loan (equals the principal).'}
      >
        <input {...fp('l-out', errors.outstanding?.message, 'x')} className="input" inputMode="decimal" {...register('outstanding')} />
      </Field>
      <Field label="Pay EMIs from account (default)" id="l-acc">
        <select id="l-acc" className="input" {...register('accountId')}>
          <option value="">None</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary">{edit ? 'Save loan' : 'Add loan'}</button>
      </div>
    </form>
  )
}

// ---------- payment ----------

const paySchema = z.object({
  date: z.string().refine(isValidDate, 'Enter a valid date'),
  kind: z.enum(['emi', 'prepayment']),
  amount: money('Enter an amount greater than zero'),
  accountId: z.string(),
  interest: z.string().refine((v) => v === '' || (parseRupees(v) ?? -1) >= 0, 'Enter a valid amount'),
  notes: z.string().max(300),
})
type PV = z.infer<typeof paySchema>

export function PaymentModal({ open, onClose, loan, kind }: { open: boolean; onClose: () => void; loan: Loan; kind: 'emi' | 'prepayment' }) {
  return (
    <Modal open={open} onClose={onClose} title={`${kind === 'emi' ? 'Record EMI payment' : 'Record extra principal payment'} · ${loan.name}`}>
      {open && <PaymentForm loan={loan} kind={kind} onDone={onClose} />}
    </Modal>
  )
}

function PaymentForm({ loan, kind, onDone }: { loan: Loan; kind: 'emi' | 'prepayment'; onDone: () => void }) {
  const { accounts, today } = useData()
  const toast = useToast()
  const { register, handleSubmit, control, setError, formState: { errors } } = useForm<PV>({
    resolver: zodResolver(paySchema),
    defaultValues: { date: today, kind, amount: kind === 'emi' ? paiseToInput(Math.min(loan.emi, loan.outstanding + Math.round((loan.outstanding * loan.annualRate) / 1200))) : '', accountId: loan.accountId ?? '', interest: '', notes: '' },
  })
  const w = useWatch({ control })
  const amt = parseRupees(w.amount ?? '')
  const io = w.interest ? parseRupees(w.interest) : null
  const split = amt && amt > 0 ? splitPayment(loan.outstanding, loan.annualRate, amt, kind, io ?? undefined) : null

  const submit = handleSubmit(async (v) => {
    try {
      await repo.recordPayment({ loanId: loan.id, date: v.date, kind, amount: parseRupees(v.amount)!, accountId: v.accountId || undefined, interestOverride: v.interest === '' ? undefined : parseRupees(v.interest)!, notes: v.notes || undefined })
      toast('Payment recorded')
      onDone()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount paid (₹)" id="p-amount" error={errors.amount?.message}><input {...fp('p-amount', errors.amount?.message)} className="input" inputMode="decimal" autoFocus {...register('amount')} /></Field>
        <Field label="Payment date" id="p-date" error={errors.date?.message}><input {...fp('p-date', errors.date?.message)} type="date" className="input" {...register('date')} /></Field>
      </div>
      {kind === 'emi' && (
        <Field label="Interest charged this month (₹, optional)" id="p-int" error={errors.interest?.message} hint="Leave blank to estimate from the outstanding balance and rate.">
          <input {...fp('p-int', errors.interest?.message, 'x')} className="input" inputMode="decimal" {...register('interest')} />
        </Field>
      )}
      {split && (
        <div className="rounded-xl bg-muted p-3 text-sm" aria-live="polite">
          <p>Interest <strong className="num">{formatINR(split.interest)}</strong> · Principal <strong className="num">{formatINR(split.principal)}</strong></p>
          <p className="mt-1 text-xs text-subtle">Outstanding after payment: <span className="num font-semibold">{formatINR(Math.max(0, loan.outstanding - split.principal))}</span>. Only the principal part reduces the loan.</p>
        </div>
      )}
      <Field label="Paid from account" id="p-acc" hint="Choose an account to also record this as one expense. Pick “Don't record” to only update the loan.">
        <select id="p-acc" className="input" {...register('accountId')}>
          <option value="">Don't record in an account</option>
          {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field label="Notes" id="p-notes"><input id="p-notes" className="input" {...register('notes')} /></Field>
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn-primary">Record payment</button>
      </div>
    </form>
  )
}
