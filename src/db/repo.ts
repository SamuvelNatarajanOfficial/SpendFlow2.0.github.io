/**
 * Repository / service layer. UI code calls these functions and never touches storage directly. Every write is
 * validated with Zod and checks referential integrity, because the encrypted store has no foreign keys.
 *
 * All records live in the encrypted vault (see src/vault). Mutations run inside `vault.write`, which serialises
 * them, encrypts first and commits atomically, so multi-record operations (loan payments, cascades) cannot
 * be left half-applied.
 */
import type { ZodType } from 'zod'
import { vault, type Reader, type Writer } from '@/vault/store'
import { builtInCategoryId, defaultSettings, EMI_CATEGORY_NAME } from './defaults'
import {
  accountSchema, budgetSchema, categorySchema, goalSchema, loanPaymentSchema, loanSchema, settingsSchema, transactionSchema,
} from './schemas'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Settings, Transaction } from '@/types'
import { splitPayment } from '@/lib/calc/loan'
import { anchorDayOf, isSeriesMember, nextOccurrence, seriesKey } from '@/lib/calc/ledger'

export class RepoError extends Error {}

export function newId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
const nowIso = () => new Date().toISOString()

type Input<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'>

function clean<T extends object>(o: T): T {
  // drop undefined / empty-string optionals so stored records and exports stay tidy
  const out = { ...o } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k]
  return out as T
}

function validate<T>(schema: ZodType<T>, rec: unknown): T {
  const r = schema.safeParse(rec)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new RepoError(i ? `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}` : 'Invalid data')
  }
  return rec as T
}

function make<T extends { id: string; createdAt: string; updatedAt: string }>(input: Input<T>): T {
  const t = nowIso()
  return clean({ ...input, id: newId(), createdAt: t, updatedAt: t } as unknown as T)
}

// ---------- settings ----------

export async function getSettings(): Promise<Settings> {
  return vault.get('settings', 'app') ?? defaultSettings()
}
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return vault.write((w) => {
    const next = validate(settingsSchema, clean({ ...(w.get('settings', 'app') ?? defaultSettings()), ...patch, id: 'app' })) as Settings
    w.put('settings', next)
    return next
  })
}

// ---------- accounts ----------

const nameTaken = (r: Reader, name: string, exceptId?: string): boolean => {
  const n = name.trim().toLowerCase()
  return r.filter('accounts', (a) => a.id !== exceptId && a.name.toLowerCase() === n).length > 0
}

export const accounts = {
  async create(input: Input<Account>): Promise<Account> {
    return vault.write((w) => {
      const rec = validate(accountSchema, make<Account>(input))
      if (nameTaken(w, rec.name)) throw new RepoError('An account with this name already exists')
      w.put('accounts', rec)
      return rec
    })
  },
  async update(id: string, patch: Partial<Input<Account>>): Promise<Account> {
    return vault.write((w) => {
      const cur = w.get('accounts', id)
      if (!cur) throw new RepoError('Account not found')
      const rec = validate(accountSchema, clean({ ...cur, ...patch, updatedAt: nowIso() }))
      if (nameTaken(w, rec.name, id)) throw new RepoError('An account with this name already exists')
      w.put('accounts', rec)
      return rec
    })
  },
  async usage(id: string) {
    const tx = vault.filter('transactions', (t) => t.accountId === id || t.toAccountId === id).length
    const loans = vault.filter('loans', (l) => l.accountId === id).length
    const goals = vault.filter('goals', (g) => g.accountId === id).length
    return { tx, loans, goals, used: tx + loans + goals > 0 }
  },
  /** Accounts with history can only be archived; unused accounts can be deleted. */
  async remove(id: string): Promise<void> {
    await vault.write((w) => {
      const tx = w.filter('transactions', (t) => t.accountId === id || t.toAccountId === id).length
      const loans = w.filter('loans', (l) => l.accountId === id).length
      const goals = w.filter('goals', (g) => g.accountId === id).length
      if (tx + loans + goals > 0) throw new RepoError(`This account is used by ${tx} transaction(s), ${loans} loan(s) and ${goals} goal(s). Archive it instead.`)
      w.delete('accounts', id)
    })
  },
}

// ---------- categories ----------

function ensureEmiCategory(w: Writer): Category {
  const id = builtInCategoryId('expense', EMI_CATEGORY_NAME)
  const found = w.get('categories', id) ?? w.filter('categories', (c) => c.kind === 'expense' && c.name === EMI_CATEGORY_NAME)[0]
  if (found) return found
  const rec = make<Category>({ name: EMI_CATEGORY_NAME, kind: 'expense', color: '#475569', essential: true, builtIn: true })
  rec.id = id
  w.put('categories', rec)
  return rec
}

export const categories = {
  async create(input: Input<Category>): Promise<Category> {
    return vault.write((w) => {
      const rec = validate(categorySchema, make<Category>(input))
      if (w.filter('categories', (c) => c.kind === rec.kind && c.name.toLowerCase() === rec.name.toLowerCase()).length) throw new RepoError('A category with this name already exists')
      w.put('categories', rec)
      return rec
    })
  },
  async update(id: string, patch: Partial<Input<Category>>): Promise<Category> {
    return vault.write((w) => {
      const cur = w.get('categories', id)
      if (!cur) throw new RepoError('Category not found')
      const rec = validate(categorySchema, clean({ ...cur, ...patch, kind: cur.kind, updatedAt: nowIso() }))
      if (w.filter('categories', (c) => c.id !== id && c.kind === rec.kind && c.name.toLowerCase() === rec.name.toLowerCase()).length) throw new RepoError('A category with this name already exists')
      w.put('categories', rec)
      return rec
    })
  },
  async remove(id: string): Promise<void> {
    await vault.write((w) => {
      const used = w.filter('transactions', (t) => t.categoryId === id).length
      if (used) throw new RepoError(`${used} transaction(s) use this category. Re-categorise them first.`)
      for (const b of w.filter('budgets', (x) => x.categoryId === id)) w.delete('budgets', b.id)
      w.delete('categories', id)
    })
  },
  /** Finds (or creates) the built-in loan-payment category. */
  async ensureEmi(): Promise<Category> {
    return vault.write((w) => ensureEmiCategory(w))
  },
}

// ---------- transactions ----------

function assertTxRefs(w: Reader, t: Transaction): void {
  if (!w.get('accounts', t.accountId)) throw new RepoError('Selected account no longer exists')
  if (t.type === 'transfer') {
    if (!t.toAccountId || !w.get('accounts', t.toAccountId)) throw new RepoError('Destination account no longer exists')
    return
  }
  if (t.categoryId) {
    const c = w.get('categories', t.categoryId)
    if (!c) throw new RepoError('Selected category no longer exists')
    if (c.kind !== t.type) throw new RepoError(`Category "${c.name}" is not an ${t.type} category`)
  }
}

export const transactions = {
  async create(input: Input<Transaction>): Promise<Transaction> {
    return vault.write((w) => {
      const rec = validate(transactionSchema, make<Transaction>(input)) as Transaction
      assertTxRefs(w, rec)
      w.put('transactions', rec)
      return rec
    })
  },
  async update(id: string, patch: Partial<Input<Transaction>>): Promise<Transaction> {
    return vault.write((w) => {
      const cur = w.get('transactions', id)
      if (!cur) throw new RepoError('Transaction not found')
      if (cur.loanPaymentId) throw new RepoError('This entry was created by a loan payment. Edit or delete it from the Loans page.')
      const merged = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: nowIso() }
      // optional keys are removable: callers pass undefined explicitly
      const rec = validate(transactionSchema, clean(merged)) as Transaction
      assertTxRefs(w, rec)
      w.put('transactions', rec)
      return rec
    })
  },
  async remove(id: string): Promise<void> {
    await vault.write((w) => {
      const cur = w.get('transactions', id)
      if (!cur) return
      if (cur.loanPaymentId) throw new RepoError('This entry was created by a loan payment. Delete the payment from the Loans page instead.')
      w.delete('transactions', id)
    })
  },
  async bulkCreate(inputs: Input<Transaction>[]): Promise<number> {
    return vault.write((w) => {
      const recs = inputs.map((i) => validate(transactionSchema, make<Transaction>(i)) as Transaction)
      for (const r of recs) assertTxRefs(w, r)
      for (const r of recs) w.put('transactions', r)
      return recs.length
    })
  },
}

// ---------- recurring series ----------

export const recurring = {
  /**
   * Posts the next occurrence of a recurring series as a real transaction, dated on its due date.
   * Always continues from the series' LATEST entry (whichever entry was passed), so it can never post a
   * duplicate of an existing date, and refuses to post anything not yet due as of `today`.
   */
  async recordNext(sourceId: string, today: string): Promise<Transaction> {
    return vault.write((w) => {
      const src = w.get('transactions', sourceId)
      if (!src || !isSeriesMember(src)) throw new RepoError('This entry is no longer part of a recurring series')
      const key = seriesKey(src)
      const members = w.filter('transactions', (t) => isSeriesMember(t) && seriesKey(t) === key)
      const latest = members.reduce((a, b) => (b.date > a.date ? b : a))
      const date = nextOccurrence(latest.date, latest.recurring!, anchorDayOf(members.map((m) => m.date)))
      if (date > today) throw new RepoError(`Not due yet: next occurrence is ${date}`)
      const rec = validate(
        transactionSchema,
        make<Transaction>({
          type: latest.type, amount: latest.amount, date, accountId: latest.accountId, categoryId: latest.categoryId, paymentMethod: latest.paymentMethod,
          merchant: latest.merchant, notes: latest.notes, essential: latest.essential, recurring: latest.recurring,
        }),
      ) as Transaction
      if (latest.isSample) rec.isSample = true
      assertTxRefs(w, rec)
      w.put('transactions', rec)
      return rec
    })
  },

  /** Ends a series: clears the recurring flag on every entry of it. Entries themselves (and balances) are untouched. */
  async stop(sourceId: string): Promise<number> {
    return vault.write((w) => {
      const src = w.get('transactions', sourceId)
      if (!src || !isSeriesMember(src)) return 0
      const key = seriesKey(src)
      const members = w.filter('transactions', (t) => isSeriesMember(t) && seriesKey(t) === key)
      const now = nowIso()
      for (const t of members) {
        const { recurring: _drop, ...rest } = t
        w.put('transactions', { ...rest, updatedAt: now })
      }
      return members.length
    })
  },
}

// ---------- budgets ----------

export const budgets = {
  /** Create or update the single budget for (category, month). */
  async upsert(categoryId: string, month: string, amount: number, isSample?: boolean): Promise<Budget> {
    return vault.write((w) => {
      const cat = w.get('categories', categoryId)
      if (!cat || cat.kind !== 'expense') throw new RepoError('Choose an expense category')
      const existing = w.filter('budgets', (b) => b.categoryId === categoryId && b.month === month)[0]
      const rec = validate(
        budgetSchema,
        existing ? { ...existing, amount, updatedAt: nowIso() } : clean({ ...make<Budget>({ categoryId, month, amount }), isSample }),
      ) as Budget
      w.put('budgets', rec)
      return rec
    })
  },
  async remove(id: string): Promise<void> {
    await vault.write((w) => w.delete('budgets', id))
  },
  /** Copy all budgets of `from` into `to`, never overwriting existing budgets in `to`. Returns count copied. */
  async copyMonth(from: string, to: string): Promise<number> {
    return vault.write((w) => {
      let n = 0
      for (const b of w.filter('budgets', (x) => x.month === from)) {
        if (w.filter('budgets', (x) => x.categoryId === b.categoryId && x.month === to).length) continue
        w.put('budgets', make<Budget>({ categoryId: b.categoryId, month: to, amount: b.amount }))
        n++
      }
      return n
    })
  },
}

// ---------- goals ----------

export const goals = {
  async create(input: Input<Goal>): Promise<Goal> {
    return vault.write((w) => {
      const rec = validate(goalSchema, make<Goal>(input)) as Goal
      if (rec.kind !== 'debt-free' && rec.target <= 0) throw new RepoError('target: Target must be greater than zero')
      w.put('goals', rec)
      return rec
    })
  },
  async update(id: string, patch: Partial<Input<Goal>>): Promise<Goal> {
    return vault.write((w) => {
      const cur = w.get('goals', id)
      if (!cur) throw new RepoError('Goal not found')
      const rec = validate(goalSchema, clean({ ...cur, ...patch, updatedAt: nowIso() })) as Goal
      if (rec.kind !== 'debt-free' && rec.target <= 0) throw new RepoError('target: Target must be greater than zero')
      w.put('goals', rec)
      return rec
    })
  },
  async remove(id: string): Promise<void> {
    await vault.write((w) => w.delete('goals', id))
  },
}

// ---------- loans ----------

export interface PaymentInput {
  loanId: string
  date: string
  kind: 'emi' | 'prepayment'
  amount: number
  accountId?: string // when set, an expense is recorded in that account
  interestOverride?: number
  notes?: string
  isSample?: boolean
}

export const loans = {
  async create(input: Input<Loan>): Promise<Loan> {
    return vault.write((w) => {
      const rec = validate(loanSchema, make<Loan>(input)) as Loan
      if (rec.outstanding > rec.principal) throw new RepoError('outstanding: Outstanding cannot exceed the original principal')
      if (rec.accountId && !w.get('accounts', rec.accountId)) throw new RepoError('Selected account no longer exists')
      w.put('loans', rec)
      return rec
    })
  },
  async update(id: string, patch: Partial<Input<Loan>>): Promise<Loan> {
    return vault.write((w) => {
      const cur = w.get('loans', id)
      if (!cur) throw new RepoError('Loan not found')
      const rec = validate(loanSchema, clean({ ...cur, ...patch, updatedAt: nowIso() })) as Loan
      if (rec.outstanding > rec.principal) throw new RepoError('outstanding: Outstanding cannot exceed the original principal')
      w.put('loans', rec)
      return rec
    })
  },
  /** Deletes the loan, its payments and the expenses those payments created. */
  async remove(id: string): Promise<void> {
    await vault.write((w) => {
      for (const p of w.filter('loanPayments', (x) => x.loanId === id)) {
        if (p.transactionId) w.delete('transactions', p.transactionId)
        w.delete('loanPayments', p.id)
      }
      w.delete('loans', id)
    })
  },

  /**
   * Records an actual payment. Atomically: stores the payment with its interest/principal split,
   * reduces outstanding by the PRINCIPAL part only, and (optionally) records one expense in the account.
   */
  async recordPayment(input: PaymentInput): Promise<LoanPayment> {
    return vault.write((w) => {
      const loan = w.get('loans', input.loanId)
      if (!loan) throw new RepoError('Loan not found')
      if (loan.outstanding <= 0) throw new RepoError('This loan is already fully repaid')
      if (input.accountId && !w.get('accounts', input.accountId)) throw new RepoError('Selected account no longer exists')
      const { interest, principal } = splitPayment(loan.outstanding, loan.annualRate, input.amount, input.kind, input.interestOverride)
      if (interest + principal !== input.amount) throw new RepoError('Payment split mismatch')
      const pay = make<LoanPayment>({
        loanId: loan.id, date: input.date, kind: input.kind, amount: input.amount, interest, principal,
        accountId: input.accountId, notes: input.notes,
      })
      if (input.isSample) pay.isSample = true
      if (input.accountId) {
        const cat = ensureEmiCategory(w)
        const tx = make<Transaction>({
          type: 'expense', amount: input.amount, date: input.date, accountId: input.accountId, categoryId: cat.id,
          paymentMethod: 'auto-debit', merchant: loan.lender || loan.name,
          notes: `${input.kind === 'emi' ? 'EMI' : 'Prepayment'} - ${loan.name}`, essential: input.kind === 'emi', loanPaymentId: pay.id,
        })
        if (input.isSample) tx.isSample = true
        validate(transactionSchema, tx)
        w.put('transactions', tx)
        pay.transactionId = tx.id
      }
      validate(loanPaymentSchema, pay)
      w.put('loanPayments', pay)
      w.put('loans', { ...loan, outstanding: loan.outstanding - principal, updatedAt: nowIso() })
      return pay
    })
  },

  /** Reverses a payment: restores its principal to the loan and removes the linked expense. */
  async deletePayment(paymentId: string): Promise<void> {
    await vault.write((w) => {
      const pay = w.get('loanPayments', paymentId)
      if (!pay) return
      const loan = w.get('loans', pay.loanId)
      if (loan) w.put('loans', { ...loan, outstanding: Math.min(loan.principal, loan.outstanding + pay.principal), updatedAt: nowIso() })
      if (pay.transactionId) w.delete('transactions', pay.transactionId)
      w.delete('loanPayments', paymentId)
    })
  },
}

// ---------- whole-vault operations ----------

/** Destroys the entire encrypted vault, including its password. The app returns to first-time setup. */
export async function clearAllData(): Promise<void> {
  await vault.destroy()
}
