import { z } from 'zod'
import { isValidDate } from '@/lib/dates'

/** Runtime validation for every persisted record. Also used to validate backups. */

export const dateStr = z.string().refine(isValidDate, 'Enter a valid date')
const paise = z.number().int().refine(Number.isSafeInteger, 'Amount is too large')
export const positivePaise = paise.refine((n) => n > 0, 'Amount must be greater than zero')
const ts = z.string().min(1)
const id = z.string().min(1)

const base = { id, createdAt: ts, updatedAt: ts, isSample: z.boolean().optional() }

export const accountSchema = z.object({
  ...base,
  name: z.string().trim().min(1, 'Name is required').max(60),
  type: z.enum(['cash', 'savings', 'current', 'upi', 'other']),
  openingBalance: paise,
  actualBalance: z.object({ amount: paise, asOf: dateStr }).optional(),
  archived: z.boolean().optional(),
})

export const categorySchema = z.object({
  ...base,
  name: z.string().trim().min(1, 'Name is required').max(40),
  kind: z.enum(['income', 'expense']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid colour'),
  essential: z.boolean().optional(),
  builtIn: z.boolean().optional(),
})

export const paymentMethodSchema = z.enum(['cash', 'upi', 'card', 'netbanking', 'cheque', 'auto-debit', 'other'])

export const transactionSchema = z
  .object({
    ...base,
    type: z.enum(['income', 'expense', 'transfer']),
    amount: positivePaise,
    date: dateStr,
    accountId: id,
    toAccountId: id.optional(),
    categoryId: id.optional(),
    paymentMethod: paymentMethodSchema,
    merchant: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(300).optional(),
    essential: z.boolean().optional(),
    recurring: z.enum(['weekly', 'monthly', 'yearly']).optional(),
    loanPaymentId: id.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.type === 'transfer') {
      if (!t.toAccountId) ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'Choose the destination account' })
      else if (t.toAccountId === t.accountId) ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'Source and destination must differ' })
    } else if (t.toAccountId) {
      ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'Only transfers have a destination account' })
    }
  })

export const budgetSchema = z.object({
  ...base,
  categoryId: id,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid month'),
  amount: positivePaise,
})

export const loanSchema = z.object({
  ...base,
  name: z.string().trim().min(1, 'Name is required').max(60),
  lender: z.string().trim().max(60),
  principal: positivePaise,
  outstanding: paise.refine((n) => n >= 0, 'Cannot be negative'),
  annualRate: z.number().min(0, 'Rate cannot be negative').max(100, 'Rate looks too high'),
  emi: positivePaise,
  dueDay: z.number().int().min(1).max(31),
  startDate: dateStr,
  tenureMonths: z.number().int().min(1).max(600),
  endDate: dateStr.optional(),
  accountId: id.optional(),
  extraMonthly: paise.refine((n) => n >= 0).optional(),
  notes: z.string().max(300).optional(),
})

export const loanPaymentSchema = z.object({
  ...base,
  loanId: id,
  date: dateStr,
  kind: z.enum(['emi', 'prepayment']),
  amount: positivePaise,
  interest: paise.refine((n) => n >= 0),
  principal: paise.refine((n) => n >= 0),
  accountId: id.optional(),
  transactionId: id.optional(),
  notes: z.string().max(300).optional(),
})

export const goalSchema = z.object({
  ...base,
  name: z.string().trim().min(1, 'Name is required').max(60),
  kind: z.enum(['emergency', 'savings', 'debt-free', 'purchase', 'custom']),
  target: paise.refine((n) => n >= 0, 'Cannot be negative'),
  saved: paise.refine((n) => n >= 0, 'Cannot be negative'),
  targetDate: dateStr.optional(),
  accountId: id.optional(),
  notes: z.string().max(300).optional(),
})

export const settingsSchema = z.object({
  id: z.literal('app'),
  currency: z.literal('INR'),
  timezone: z.string().min(1),
  theme: z.enum(['light', 'dark']),
  lastBackupAt: z.string().optional(),
  backupReminderDays: z.number().int().min(1).max(365),
  sampleLoaded: z.boolean().optional(),
  dismissedBackupBannerAt: z.string().optional(),
  autoLockMinutes: z.number().int().min(0).max(240).optional(),
  lockOnHideSeconds: z.number().int().min(-1).max(3600).optional(),
})

export const BACKUP_APP = 'spendflow'
export const BACKUP_SCHEMA_VERSION = 1

export const backupSchema = z.object({
  app: z.literal(BACKUP_APP),
  schemaVersion: z.number().int().min(1),
  exportedAt: z.string(),
  data: z.object({
    accounts: z.array(accountSchema),
    transactions: z.array(transactionSchema),
    categories: z.array(categorySchema),
    budgets: z.array(budgetSchema),
    loans: z.array(loanSchema),
    loanPayments: z.array(loanPaymentSchema),
    goals: z.array(goalSchema),
    settings: settingsSchema.optional(),
  }),
})
export type Backup = z.infer<typeof backupSchema>
