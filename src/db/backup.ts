import { vault } from '@/vault/store'
import { decryptBackup, encryptBackup, inspectBackup, MAX_BACKUP_BYTES } from '@/vault/backupFile'
import type { BackupEnvelope } from '@/vault/format'
import { assessPassword } from '@/vault/password'
import { updateSettings } from './repo'
import { BACKUP_APP, BACKUP_SCHEMA_VERSION, backupSchema, type Backup } from './schemas'

export type RestoreMode = 'merge' | 'replace'
export const TABLE_KEYS = ['accounts', 'transactions', 'categories', 'budgets', 'loans', 'loanPayments', 'goals'] as const
export type TableKey = (typeof TABLE_KEYS)[number]

/** The plaintext payload that gets encrypted into a backup file (never written to disk unencrypted). */
export function buildBackup(): Backup {
  const d = vault.snapshot()
  return {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      accounts: d.accounts, transactions: d.transactions, categories: d.categories, budgets: d.budgets,
      loans: d.loans, loanPayments: d.loanPayments, goals: d.goals, settings: d.settings[0],
    },
  }
}

export function backupFilename(now = new Date()): string {
  return `spendflow-backup-${now.toISOString().slice(0, 10)}.sfbackup.json`
}

/**
 * Creates a password-protected backup file. There is intentionally NO unencrypted JSON export.
 * The backup password is independent of the vault password.
 */
export async function exportEncryptedBackup(password: string, opts: { iterations?: number } = {}): Promise<{ text: string; filename: string }> {
  if (!assessPassword(password).acceptable) throw new Error('Choose a stronger backup password')
  const text = await encryptBackup(JSON.stringify(buildBackup()), password, opts)
  return { text, filename: backupFilename() }
}

/** Call only after the file was actually handed to the user. */
export async function markBackupDone(): Promise<void> {
  await updateSettings({ lastBackupAt: new Date().toISOString() })
}

export type ParseResult = { ok: true; backup: Backup; warnings: string[] } | { ok: false; errors: string[] }

/** Validates a decrypted (or legacy plaintext) backup payload against the versioned schema, plus referential integrity. */
export function parseBackup(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['The backup content is not valid JSON.'] }
  }
  if (!raw || typeof raw !== 'object' || (raw as { app?: unknown }).app !== BACKUP_APP) {
    return { ok: false, errors: ['This is not a SpendFlow backup file (missing app marker).'] }
  }
  const v = (raw as { schemaVersion?: unknown }).schemaVersion
  if (typeof v !== 'number') return { ok: false, errors: ['Backup has no schemaVersion.'] }
  if (v > BACKUP_SCHEMA_VERSION) {
    return { ok: false, errors: [`This backup (schema v${v}) was made by a newer version of SpendFlow. Update the app and try again.`] }
  }
  // Older schema versions would be migrated here: `raw = migrate(raw, v)`.
  const r = backupSchema.safeParse(raw)
  if (!r.success) {
    const errors = r.error.issues.slice(0, 15).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`)
    if (r.error.issues.length > 15) errors.push(`...and ${r.error.issues.length - 15} more problem(s).`)
    return { ok: false, errors }
  }
  const b = r.data
  const errors = integrityErrors(b)
  if (errors.length) return { ok: false, errors }
  const warnings: string[] = []
  const ids = new Map<string, number>()
  for (const k of TABLE_KEYS) for (const rec of b.data[k]) ids.set(`${k}:${rec.id}`, (ids.get(`${k}:${rec.id}`) ?? 0) + 1)
  const dup = [...ids.values()].filter((n) => n > 1).length
  if (dup) return { ok: false, errors: [`${dup} record id(s) appear more than once in the backup.`] }
  if (b.data.transactions.some((t) => t.isSample) || b.data.accounts.some((a) => a.isSample)) warnings.push('Backup contains sample data.')
  return { ok: true, backup: b, warnings }
}

function integrityErrors(b: Backup): string[] {
  const d = b.data
  const acc = new Set(d.accounts.map((a) => a.id))
  const cat = new Map(d.categories.map((c) => [c.id, c]))
  const loan = new Set(d.loans.map((l) => l.id))
  const out: string[] = []
  const bad = (n: number, what: string) => n > 0 && out.push(`${n} ${what}`)
  bad(d.transactions.filter((t) => !acc.has(t.accountId) || (t.toAccountId && !acc.has(t.toAccountId))).length, 'transaction(s) reference an account that is not in the backup.')
  bad(d.transactions.filter((t) => t.categoryId && !cat.has(t.categoryId)).length, 'transaction(s) reference a category that is not in the backup.')
  bad(d.transactions.filter((t) => t.type !== 'transfer' && t.categoryId && cat.get(t.categoryId)?.kind !== t.type).length, 'transaction(s) use a category of the wrong kind.')
  bad(d.budgets.filter((x) => !cat.has(x.categoryId)).length, 'budget(s) reference a missing category.')
  bad(d.loanPayments.filter((p) => !loan.has(p.loanId)).length, 'loan payment(s) reference a missing loan.')
  bad(d.loans.filter((l) => l.outstanding > l.principal).length, 'loan(s) have outstanding greater than principal.')
  const seen = new Set<string>()
  let dupBudget = 0
  for (const x of d.budgets) {
    const k = `${x.categoryId}|${x.month}`
    if (seen.has(k)) dupBudget++
    seen.add(k)
  }
  bad(dupBudget, 'duplicate budget(s) for the same category and month.')
  return out
}

// ---------- reading a backup FILE ----------

export type FileStage =
  | { ok: true; kind: 'encrypted'; header: BackupEnvelope }
  | { ok: true; kind: 'legacy-plain' }
  | { ok: false; message: string }

/** Step 1: public header only. Reveals nothing financial and needs no password. */
export function inspectBackupFile(text: string): FileStage {
  const r = inspectBackup(text)
  return r.ok ? r : { ok: false, message: r.message }
}

export interface OpenedBackup {
  backup: Backup
  warnings: string[]
  source: 'encrypted' | 'legacy-plain'
  /** metadata that is only available after successful authentication */
  counts: Record<TableKey, number>
}
export type OpenResult = { ok: true; opened: OpenedBackup } | { ok: false; errors: string[] }

/**
 * Step 2: authenticate + decrypt + schema-validate. Nothing is written to the vault here; the caller shows a
 * preview and requires explicit confirmation before `applyRestore`.
 */
export async function openBackupFile(text: string, password: string): Promise<OpenResult> {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, errors: ['The file is larger than 25 MB.'] }
  const stage = inspectBackupFile(text)
  if (!stage.ok) return { ok: false, errors: [stage.message] }
  let payload: string
  if (stage.kind === 'legacy-plain') payload = text
  else {
    const dec = await decryptBackup(stage.header, password)
    if (!dec.ok) return { ok: false, errors: [dec.message] }
    payload = dec.payloadJson
  }
  const parsed = parseBackup(payload)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const counts = Object.fromEntries(TABLE_KEYS.map((k) => [k, parsed.backup.data[k].length])) as Record<TableKey, number>
  const warnings = [...parsed.warnings]
  if (stage.kind === 'legacy-plain') warnings.push('This is an old UNENCRYPTED backup. Its contents will be encrypted when restored.')
  return { ok: true, opened: { backup: parsed.backup, warnings, source: stage.kind, counts } }
}

// ---------- applying ----------

export interface RestorePreview {
  mode: RestoreMode
  tables: { key: TableKey; incoming: number; added: number; skipped: number; existing: number }[]
  /** merge mode: records whose id already exists locally are kept as-is and NOT overwritten */
  totalSkipped: number
  /** replace mode: records that will be deleted */
  willDelete: number
}

type Rec = { id: string }

function plan(b: Backup, mode: RestoreMode) {
  const existing = Object.fromEntries(TABLE_KEYS.map((k) => [k, vault.all(k) as Rec[]])) as Record<TableKey, Rec[]>
  const toAdd = {} as Record<TableKey, Rec[]>
  for (const k of TABLE_KEYS) {
    const incoming = b.data[k] as Rec[]
    if (mode === 'replace') {
      toAdd[k] = incoming
      continue
    }
    const have = new Set(existing[k].map((r) => r.id))
    let list = incoming.filter((r) => !have.has(r.id))
    if (k === 'budgets') {
      // a budget is unique per (category, month): skip incoming budgets that collide with an existing one
      const keys = new Set((existing.budgets as unknown as { categoryId: string; month: string }[]).map((x) => `${x.categoryId}|${x.month}`))
      list = list.filter((x) => !keys.has(`${(x as unknown as { categoryId: string }).categoryId}|${(x as unknown as { month: string }).month}`))
    }
    toAdd[k] = list
  }
  return { existing, toAdd }
}

export function previewRestore(b: Backup, mode: RestoreMode): RestorePreview {
  const { existing, toAdd } = plan(b, mode)
  const tables = TABLE_KEYS.map((key) => {
    const incoming = b.data[key].length
    const added = toAdd[key].length
    return { key, incoming, added, skipped: incoming - added, existing: existing[key].length }
  })
  return {
    mode,
    tables,
    totalSkipped: tables.reduce((s, t) => s + t.skipped, 0),
    willDelete: mode === 'replace' ? TABLE_KEYS.reduce((s, k) => s + existing[k].length, 0) : 0,
  }
}

/**
 * Applies an already decrypted + validated backup. Replace mode encrypts everything first and swaps storage in a
 * single transaction (see VaultStore.replaceAll); merge mode adds missing records in one atomic write. If anything
 * throws, the existing vault is unchanged.
 */
export async function applyRestore(b: Backup, mode: RestoreMode): Promise<RestorePreview> {
  const preview = previewRestore(b, mode)
  if (mode === 'replace') {
    await vault.replaceAll({
      accounts: b.data.accounts, transactions: b.data.transactions, categories: b.data.categories, budgets: b.data.budgets,
      loans: b.data.loans, loanPayments: b.data.loanPayments, goals: b.data.goals, settings: b.data.settings ? [b.data.settings] : [],
    })
  } else {
    const { toAdd } = plan(b, mode)
    await vault.write((w) => {
      for (const k of TABLE_KEYS) for (const r of toAdd[k]) w.put(k, r as never)
    })
  }
  return preview
}
