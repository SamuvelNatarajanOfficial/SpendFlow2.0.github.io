/**
 * Repository / service layer. UI code calls these functions and never touches Dexie
 * tables directly for writes. Every write is validated with Zod and checks
 * referential integrity, because IndexedDB has no foreign keys.
 */
import type { ZodType } from 'zod'
import { db } from './db'
import { builtInCategoryId, defaultSettings, EMI_CATEGORY_NAME, seedCategories } from './defaults'
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
    throw new RepoError(`${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
  }
  return rec as T
}

function make<T extends { id: string; createdAt: string; updatedAt: string }>(input: Input<T>): T {
  const t = nowIso()
  return clean({ ...input, id: newId(), createdAt: t, updatedAt: t } as unknown as T)
}

// ---------- bootstrap ----------

export async function ensureSeed(): Promise<void> {
  await db.transaction('rw', db.categories, db.settings, async () => {
    if (!(await db.settings.get('app'))) await db.settings.put(defaultSettings())
    if ((await db.categories.count()) === 0) await db.categories.bulkPut(seedCategories(nowIso()))
  })
}

// ---------- settings ----------

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get('app')) ?? defaultSettings()
}
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = validate(settingsSchema, { ...(await getSettings()), ...patch, id: 'app' }) as Settings
  await db.settings.put(next)
  return next
}

// ---------- accounts ----------

export const accounts = {
  async create(input: Input<Account>): Promise<Account> {
    const rec = validate(accountSchema, make<Account>(input))
    if (await nameTaken(rec.name)) throw new RepoError('An account with this name already exists')
    await db.accounts.add(rec)
    return rec
  },
  async update(id: string, patch: Partial<Input<Account>>): Promise<Account> {
    const cur = await db.accounts.get(id)
    if (!cur) throw new RepoError('Account not found')
    const rec = validate(accountSchema, clean({ ...cur, ...patch, updatedAt: nowIso() }))
    if (rec.name.toLowerCase() !== cur.name.toLowerCase() && (await nameTaken(rec.name))) throw new RepoError('An account with this name already exists')
    await db.accounts.put(rec)
    return rec
  },
  async usage(id: string) {
    const [tx, loans, goals] = await Promise.all([
      db.transactions.where('accountId').equals(id).or('toAccountId').equals(id).count(),
      db.loans.filter((l) => l.accountId === id).count(),
      db.goals.filter((g) => g.accountId === id).count(),
    ])
    return { tx, loans, goals, used: tx + loans + goals > 0 }
  },
  /** Accounts with history can only be archived; unused accounts can be deleted. */
  async remove(id: string): Promise<void> {
    const u = await accounts.usage(id)
    if (u.used) throw new RepoError(`This account is used by ${u.tx} transaction(s), ${u.loans} loan(s) and ${u.goals} goal(s). Archive it instead.`)
    await db.accounts.delete(id)
  },
}
async function nameTaken(name: string): Promise<boolean> {
  const n = name.trim().toLowerCase()
  return (await db.accounts.filter((a) => a.name.toLowerCase() === n).count()) > 0
}

// ---------- categories ----------

export const categories = {
  async create(input: Input<Category>): Promise<Category> {
    const rec = validate(categorySchema, make<Category>(input))
    const dupe = await db.categories.filter((c) => c.kind === rec.kind && c.name.toLowerCase() === rec.name.toLowerCase()).count()
    if (dupe) throw new RepoError('A category with this name already exists')
    await db.categories.add(rec)
    return rec
  },
  async update(id: string, patch: Partial<Input<Category>>): Promise<Category> {
    const cur = await db.categories.get(id)
    if (!cur) throw new RepoError('Category not found')
    const rec = validate(categorySchema, clean({ ...cur, ...patch, kind: cur.kind, updatedAt: nowIso() }))
    const dupe = await db.categories.filter((c) => c.id !== id && c.kind === rec.kind && c.name.toLowerCase() === rec.name.toLowerCase()).count()
    if (dupe) throw new RepoError('A category with this name already exists')
    await db.categories.put(rec)
    return rec
  },
  async remove(id: string): Promise<void> {
    const used = await db.transactions.where('categoryId').equals(id).count()
    if (used) throw new RepoError(`${used} transaction(s) use this category. Re-categorise them first.`)
    await db.transaction('rw', db.categories, db.budgets, async () => {
      await db.budgets.where('categoryId').equals(id).delete()
      await db.categories.delete(id)
    })
  },
  /** Finds (or creates) the built-in loan-payment category. */
  async ensureEmi(): Promise<Category> {
    const id = builtInCategoryId('expense', EMI_CATEGORY_NAME)
    const found = (await db.categories.get(id)) ?? (await db.categories.filter((c) => c.kind === 'expense' && c.name === EMI_CATEGORY_NAME).first())
    if (found) return found
    const rec = make<Category>({ name: EMI_CATEGORY_NAME, kind: 'expense', color: '#475569', essential: true, builtIn: true })
    rec.id = id
    await db.categories.add(rec)
    return rec
  },
}

// ---------- transactions ----------

async function assertTxRefs(t: Transaction): Promise<void> {
  if (!(await db.accounts.get(t.accountId))) throw new RepoError('Selected account no longer exists')
  if (t.type === 'transfer') {
    if (!t.toAccountId || !(await db.accounts.get(t.toAccountId))) throw new RepoError('Destination account no longer exists')
    return
  }
  if (t.categoryId) {
    const c = await db.categories.get(t.categoryId)
    if (!c) throw new RepoError('Selected category no longer exists')
    if (c.kind !== t.type) throw new RepoError(`Category "${c.name}" is not an ${t.type} category`)
  }
}

export const transactions = {
  async create(input: Input<Transaction>): Promise<Transaction> {
    const rec = validate(transactionSchema, make<Transaction>(input)) as Transaction
    await assertTxRefs(rec)
    await db.transactions.add(rec)
    return rec
  },
  async update(id: string, patch: Partial<Input<Transaction>>): Promise<Transaction> {
    const cur = await db.transactions.get(id)
    if (!cur) throw new RepoError('Transaction not found')
    if (cur.loanPaymentId) throw new RepoError('This entry was created by a loan payment. Edit or delete it from the Loans page.')
    const merged = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: nowIso() }
    // fields not present in a patch for optional keys should be removable: callers pass undefined explicitly
    const rec = validate(transactionSchema, clean(merged)) as Transaction
    await assertTxRefs(rec)
    await db.transactions.put(rec)
    return rec
  },
  async remove(id: string): Promise<void> {
    const cur = await db.transactions.get(id)
    if (!cur) return
    if (cur.loanPaymentId) throw new RepoError('This entry was created by a loan payment. Delete the payment from the Loans page instead.')
    await db.transactions.delete(id)
  },
  async bulkCreate(inputs: Input<Transaction>[]): Promise<number> {
    const recs = inputs.map((i) => validate(transactionSchema, make<Transaction>(i)) as Transaction)
    await db.transaction('rw', db.transactions, db.accounts, db.categories, async () => {
      for (const r of recs) await assertTxRefs(r)
      await db.transactions.bulkAdd(recs)
    })
    return recs.length
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
    return db.transaction('rw', [db.transactions, db.accounts, db.categories], async () => {
      const src = await db.transactions.get(sourceId)
      if (!src || !isSeriesMember(src)) throw new RepoError('This entry is no longer part of a recurring series')
      const key = seriesKey(src)
      const members = await db.transactions.filter((t) => isSeriesMember(t) && seriesKey(t) === key).toArray()
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
      await assertTxRefs(rec)
      await db.transactions.add(rec)
      return rec
    })
  },

  /** Ends a series: clears the recurring flag on every entry of it. Entries themselves (and balances) are untouched. */
  async stop(sourceId: string): Promise<number> {
    return db.transaction('rw', db.transactions, async () => {
      const src = await db.transactions.get(sourceId)
      if (!src || !isSeriesMember(src)) return 0
      const key = seriesKey(src)
      const members = await db.transactions.filter((t) => isSeriesMember(t) && seriesKey(t) === key).toArray()
      const now = nowIso()
      await db.transactions.bulkPut(members.map((t) => {
        const { recurring: _drop, ...rest } = t
        return { ...rest, updatedAt: now }
      }))
      return members.length
    })
  },
}

// ---------- budgets ----------

export const budgets = {
  /** Create or update the single budget for (category, month). */
  async upsert(categoryId: string, month: string, amount: number, isSample?: boolean): Promise<Budget> {
    const cat = await db.categories.get(categoryId)
    if (!cat || cat.kind !== 'expense') throw new RepoError('Choose an expense category')
    const existing = await db.budgets.where('[categoryId+month]').equals([categoryId, month]).first()
    const rec = validate(
      budgetSchema,
      existing ? { ...existing, amount, updatedAt: nowIso() } : clean({ ...make<Budget>({ categoryId, month, amount }), isSample }),
    ) as Budget
    await db.budgets.put(rec)
    return rec
  },
  async remove(id: string): Promise<void> {
    await db.budgets.delete(id)
  },
  /** Copy all budgets of `from` into `to`, never overwriting existing budgets in `to`. Returns count copied. */
  async copyMonth(from: string, to: string): Promise<number> {
    const src = await db.budgets.where('month').equals(from).toArray()
    let n = 0
    await db.transaction('rw', db.budgets, async () => {
      for (const b of src) {
        const exists = await db.budgets.where('[categoryId+month]').equals([b.categoryId, to]).first()
        if (exists) continue
        await db.budgets.add(make<Budget>({ categoryId: b.categoryId, month: to, amount: b.amount }))
        n++
      }
    })
    return n
  },
}

// ---------- goals ----------

export const goals = {
  async create(input: Input<Goal>): Promise<Goal> {
    const rec = validate(goalSchema, make<Goal>(input)) as Goal
    if (rec.kind !== 'debt-free' && rec.target <= 0) throw new RepoError('target: Target must be greater than zero')
    await db.goals.add(rec)
    return rec
  },
  async update(id: string, patch: Partial<Input<Goal>>): Promise<Goal> {
    const cur = await db.goals.get(id)
    if (!cur) throw new RepoError('Goal not found')
    const rec = validate(goalSchema, clean({ ...cur, ...patch, updatedAt: nowIso() })) as Goal
    if (rec.kind !== 'debt-free' && rec.target <= 0) throw new RepoError('target: Target must be greater than zero')
    await db.goals.put(rec)
    return rec
  },
  async remove(id: string): Promise<void> {
    await db.goals.delete(id)
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
    const rec = validate(loanSchema, make<Loan>(input)) as Loan
    if (rec.outstanding > rec.principal) throw new RepoError('outstanding: Outstanding cannot exceed the original principal')
    if (rec.accountId && !(await db.accounts.get(rec.accountId))) throw new RepoError('Selected account no longer exists')
    await db.loans.add(rec)
    return rec
  },
  async update(id: string, patch: Partial<Input<Loan>>): Promise<Loan> {
    const cur = await db.loans.get(id)
    if (!cur) throw new RepoError('Loan not found')
    const rec = validate(loanSchema, clean({ ...cur, ...patch, updatedAt: nowIso() })) as Loan
    if (rec.outstanding > rec.principal) throw new RepoError('outstanding: Outstanding cannot exceed the original principal')
    await db.loans.put(rec)
    return rec
  },
  /** Deletes the loan, its payments and the expenses those payments created. */
  async remove(id: string): Promise<void> {
    await db.transaction('rw', db.loans, db.loanPayments, db.transactions, async () => {
      const pays = await db.loanPayments.where('loanId').equals(id).toArray()
      await db.transactions.bulkDelete(pays.map((p) => p.transactionId).filter((x): x is string => !!x))
      await db.loanPayments.bulkDelete(pays.map((p) => p.id))
      await db.loans.delete(id)
    })
  },

  /**
   * Records an actual payment. Atomically: stores the payment with its interest/principal split,
   * reduces outstanding by the PRINCIPAL part only, and (optionally) records one expense in the account.
   */
  async recordPayment(input: PaymentInput): Promise<LoanPayment> {
    return db.transaction('rw', [db.loans, db.loanPayments, db.transactions, db.accounts, db.categories], async () => {
      const loan = await db.loans.get(input.loanId)
      if (!loan) throw new RepoError('Loan not found')
      if (loan.outstanding <= 0) throw new RepoError('This loan is already fully repaid')
      if (input.accountId && !(await db.accounts.get(input.accountId))) throw new RepoError('Selected account no longer exists')
      const { interest, principal } = splitPayment(loan.outstanding, loan.annualRate, input.amount, input.kind, input.interestOverride)
      if (interest + principal !== input.amount) throw new RepoError('Payment split mismatch')
      const pay = make<LoanPayment>({
        loanId: loan.id, date: input.date, kind: input.kind, amount: input.amount, interest, principal,
        accountId: input.accountId, notes: input.notes,
      })
      if (input.isSample) pay.isSample = true
      if (input.accountId) {
        const cat = await categories.ensureEmi()
        const tx = make<Transaction>({
          type: 'expense', amount: input.amount, date: input.date, accountId: input.accountId, categoryId: cat.id,
          paymentMethod: 'auto-debit', merchant: loan.lender || loan.name,
          notes: `${input.kind === 'emi' ? 'EMI' : 'Prepayment'} - ${loan.name}`, essential: input.kind === 'emi', loanPaymentId: pay.id,
        })
        if (input.isSample) tx.isSample = true
        validate(transactionSchema, tx)
        await db.transactions.add(tx)
        pay.transactionId = tx.id
      }
      validate(loanPaymentSchema, pay)
      await db.loanPayments.add(pay)
      await db.loans.put({ ...loan, outstanding: loan.outstanding - principal, updatedAt: nowIso() })
      return pay
    })
  },

  /** Reverses a payment: restores its principal to the loan and removes the linked expense. */
  async deletePayment(paymentId: string): Promise<void> {
    await db.transaction('rw', db.loans, db.loanPayments, db.transactions, async () => {
      const pay = await db.loanPayments.get(paymentId)
      if (!pay) return
      const loan = await db.loans.get(pay.loanId)
      if (loan) await db.loans.put({ ...loan, outstanding: Math.min(loan.principal, loan.outstanding + pay.principal), updatedAt: nowIso() })
      if (pay.transactionId) await db.transactions.delete(pay.transactionId)
      await db.loanPayments.delete(paymentId)
    })
  },
}

// ---------- whole-database operations ----------

export const ALL_TABLES = () => [db.accounts, db.transactions, db.categories, db.budgets, db.loans, db.loanPayments, db.goals, db.settings]

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', ALL_TABLES(), async () => {
    for (const t of ALL_TABLES()) await t.clear()
  })
  await ensureSeed()
}
