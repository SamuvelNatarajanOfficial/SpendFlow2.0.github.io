import Dexie, { type Table } from 'dexie'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Settings, Transaction } from '@/types'

export class SpendFlowDB extends Dexie {
  accounts!: Table<Account, string>
  transactions!: Table<Transaction, string>
  categories!: Table<Category, string>
  budgets!: Table<Budget, string>
  loans!: Table<Loan, string>
  loanPayments!: Table<LoanPayment, string>
  goals!: Table<Goal, string>
  settings!: Table<Settings, string>

  constructor(name = 'spendflow') {
    super(name)
    /**
     * Schema versions. NEVER edit a released version: add a new `this.version(n)`
     * with the changed stores and, if data must be reshaped, an `.upgrade()` callback.
     * v1: initial schema.
     */
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

export const db = new SpendFlowDB()
