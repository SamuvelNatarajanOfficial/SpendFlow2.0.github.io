/**
 * Migration from the pre-encryption storage format.
 *
 * Earlier versions kept every record in PLAINTEXT in an IndexedDB database named `spendflow`. When the user sets
 * up their password, any such data is encrypted into the vault and the plaintext database is deleted - but only
 * AFTER the vault has been created and its contents verified against the legacy data. If anything fails, the
 * legacy database is left untouched and no data is lost.
 */
import Dexie, { type Table } from 'dexie'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Settings, Transaction } from '@/types'
import type { Tables } from './format'
import { vault, type InitOptions } from './store'

export const LEGACY_DB_NAME = 'spendflow'

class LegacyDB extends Dexie {
  accounts!: Table<Account, string>
  transactions!: Table<Transaction, string>
  categories!: Table<Category, string>
  budgets!: Table<Budget, string>
  loans!: Table<Loan, string>
  loanPayments!: Table<LoanPayment, string>
  goals!: Table<Goal, string>
  settings!: Table<Settings, string>
  constructor(name = LEGACY_DB_NAME) {
    super(name)
    // identical to the released v1 schema (must not change, or Dexie would try to upgrade the old data)
    this.version(1).stores({
      accounts: 'id, name, type',
      transactions: 'id, date, type, accountId, toAccountId, categoryId, loanPaymentId, [accountId+date]',
      categories: 'id, kind, name',
      budgets: 'id, month, categoryId, &[categoryId+month]',
      loans: 'id',
      loanPayments: 'id, loanId, date',
      goals: 'id',
      settings: 'id',
    })
  }
}

export interface LegacyInfo {
  /** user records (built-in default categories do not count) */
  records: number
}

async function readLegacy(name: string): Promise<Tables | null> {
  if (!(await Dexie.exists(name))) return null
  const l = new LegacyDB(name)
  try {
    await l.open()
    const [accounts, transactions, categories, budgets, loans, loanPayments, goals, settings] = await Promise.all([
      l.accounts.toArray(), l.transactions.toArray(), l.categories.toArray(), l.budgets.toArray(),
      l.loans.toArray(), l.loanPayments.toArray(), l.goals.toArray(), l.settings.toArray(),
    ])
    return { accounts, transactions, categories, budgets, loans, loanPayments, goals, settings }
  } catch {
    return null
  } finally {
    l.close()
  }
}

const countUser = (t: Tables) =>
  t.accounts.length + t.transactions.length + t.budgets.length + t.loans.length + t.loanPayments.length + t.goals.length + t.categories.filter((c) => !c.builtIn).length

/** Is there unencrypted data from an older version that should be migrated? */
export async function detectLegacy(name = LEGACY_DB_NAME): Promise<LegacyInfo | null> {
  const t = await readLegacy(name)
  if (!t) return null
  const records = countUser(t)
  return records > 0 ? { records } : null
}

/**
 * Creates the vault (migrating legacy data when present), verifies it, then deletes the plaintext database.
 * Returns the number of records migrated.
 */
export async function setupVault(password: string, opts: Omit<InitOptions, 'initial'> = {}, legacyName = LEGACY_DB_NAME): Promise<{ migrated: number }> {
  const legacy = await readLegacy(legacyName)
  const initial: Partial<Tables> | undefined = legacy ?? undefined
  await vault.initialize(password, { ...opts, initial })
  if (!legacy) return { migrated: 0 }

  // Verify a REAL round trip: drop the in-memory copy, decrypt everything back from the stored ciphertext,
  // and compare with the legacy plaintext, before touching the plaintext database.
  try {
    await vault.lock()
    await vault.unlock(password)
    const ok =
      vault.integrityIssues === 0 &&
      (['accounts', 'transactions', 'budgets', 'loans', 'loanPayments', 'goals'] as const).every((k) => {
        const have = new Map(vault.all(k).map((r) => [r.id, JSON.stringify(r)]))
        return legacy[k].every((r) => have.get(r.id) === JSON.stringify(r))
      })
    if (!ok) throw new Error('verification')
  } catch {
    // roll back the half-created vault so setup can be retried; the plaintext database is still intact
    await vault.destroy()
    throw new Error('Migrating your existing data failed verification. Nothing was changed; your original data was kept.')
  }
  await Dexie.delete(legacyName)
  return { migrated: countUser(legacy) }
}
