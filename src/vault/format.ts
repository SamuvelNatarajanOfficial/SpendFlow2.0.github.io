import { z } from 'zod'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Settings, Transaction } from '@/types'
import type { KdfParams } from './crypto'

/** Logical tables. The table NAME of a record is stored in clear (it is needed for AAD and bulk operations). */
export const TABLES = ['accounts', 'transactions', 'categories', 'budgets', 'loans', 'loanPayments', 'goals', 'settings'] as const
export type TableName = (typeof TABLES)[number]

export interface TableMap {
  accounts: Account
  transactions: Transaction
  categories: Category
  budgets: Budget
  loans: Loan
  loanPayments: LoanPayment
  goals: Goal
  settings: Settings
}
export type Tables = { [K in TableName]: TableMap[K][] }

/**
 * Persisted record row. Everything sensitive is inside `ct`. Only technical metadata is readable:
 *   key  = "<table>:<random id>"   (ids are random UUIDs, not derived from content)
 *   type = table name              (record COUNTS per table are therefore visible)
 *   v    = record schema version   (bound into the AAD)
 *   iv   = 96-bit AES-GCM nonce
 *   ct   = AES-256-GCM ciphertext || 128-bit tag. Its LENGTH is visible and loosely reflects content size.
 * There are deliberately NO indexes on any financial field.
 */
export interface VaultRow {
  key: string
  type: TableName
  v: number
  iv: Uint8Array
  ct: Uint8Array
}

/** Single metadata row describing the vault's KDF parameters and holding a key-check ciphertext. */
export interface VaultMeta {
  id: 'vault'
  formatVersion: number
  createdAt: string
  cipher: 'AES-256-GCM'
  kdf: KdfParams
  check: { iv: Uint8Array; ct: Uint8Array }
}

export const rowKey = (type: TableName, id: string) => `${type}:${id}`
export const CHECK_PLAINTEXT = 'spendflow-vault-ok'

const bytes = z.instanceof(Uint8Array)
export const vaultMetaSchema = z.object({
  id: z.literal('vault'),
  formatVersion: z.number().int(),
  createdAt: z.string(),
  cipher: z.literal('AES-256-GCM'),
  kdf: z.object({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int(), salt: bytes }),
  check: z.object({ iv: bytes, ct: bytes }),
})

// ---------- encrypted backup file ----------

export const BACKUP_FORMAT = 'spendflow-encrypted-backup'
export const BACKUP_FORMAT_VERSION = 1

export const envelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  createdAt: z.string().min(1).max(40),
  appSchemaVersion: z.number().int().min(1),
  cipher: z.literal('AES-256-GCM'),
  kdf: z.object({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int(), salt: z.string().min(1).max(200) }),
  iv: z.string().min(1).max(100),
  ciphertext: z.string().min(1),
})
export type BackupEnvelope = z.infer<typeof envelopeSchema>
