import { db } from './db'
import { ALL_TABLES, ensureSeed, getSettings, updateSettings } from './repo'
import { BACKUP_APP, BACKUP_SCHEMA_VERSION, backupSchema, type Backup } from './schemas'

export type RestoreMode = 'merge' | 'replace'
export const TABLE_KEYS = ['accounts', 'transactions', 'categories', 'budgets', 'loans', 'loanPayments', 'goals'] as const
export type TableKey = (typeof TABLE_KEYS)[number]

export async function buildBackup(): Promise<Backup> {
  const [accounts, transactions, categories, budgets, loans, loanPayments, goals, settings] = await Promise.all([
    db.accounts.toArray(), db.transactions.toArray(), db.categories.toArray(), db.budgets.toArray(),
    db.loans.toArray(), db.loanPayments.toArray(), db.goals.toArray(), getSettings(),
  ])
  return {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { accounts, transactions, categories, budgets, loans, loanPayments, goals, settings },
  }
}

export function backupFilename(now = new Date()): string {
  return `spendflow-backup-${now.toISOString().slice(0, 10)}.json`
}

/** Serialise a backup. Does NOT mark it as the "last backup": call markBackupDone() once the file was actually saved. */
export async function exportBackupJson(): Promise<{ json: string; filename: string }> {
  const b = await buildBackup()
  return { json: JSON.stringify(b, null, 2), filename: backupFilename() }
}

export async function markBackupDone(): Promise<void> {
  await updateSettings({ lastBackupAt: new Date().toISOString() })
}

export type ParseResult = { ok: true; backup: Backup; warnings: string[] } | { ok: false; errors: string[] }

/** Validate raw backup text against the versioned schema, plus referential integrity. */
export function parseBackup(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['This file is not valid JSON.'] }
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

export interface RestorePreview {
  mode: RestoreMode
  tables: { key: TableKey; incoming: number; added: number; skipped: number; existing: number }[]
  /** merge mode: records whose id already exists locally are kept as-is and NOT overwritten */
  totalSkipped: number
  /** replace mode: records that will be deleted */
  willDelete: number
}

type Rec = { id: string }

async function plan(b: Backup, mode: RestoreMode) {
  const existing: Record<TableKey, Rec[]> = {
    accounts: await db.accounts.toArray(), transactions: await db.transactions.toArray(), categories: await db.categories.toArray(),
    budgets: await db.budgets.toArray(), loans: await db.loans.toArray(), loanPayments: await db.loanPayments.toArray(), goals: await db.goals.toArray(),
  }
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
      // unique (category, month): skip incoming budgets that collide with an existing one
      const keys = new Set((existing.budgets as unknown as { categoryId: string; month: string }[]).map((x) => `${x.categoryId}|${x.month}`))
      list = list.filter((x) => !keys.has(`${(x as unknown as { categoryId: string }).categoryId}|${(x as unknown as { month: string }).month}`))
    }
    toAdd[k] = list
  }
  return { existing, toAdd }
}

export async function previewRestore(b: Backup, mode: RestoreMode): Promise<RestorePreview> {
  const { existing, toAdd } = await plan(b, mode)
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

export async function applyRestore(b: Backup, mode: RestoreMode): Promise<RestorePreview> {
  const preview = await previewRestore(b, mode)
  const { toAdd } = await plan(b, mode)
  await db.transaction('rw', ALL_TABLES(), async () => {
    if (mode === 'replace') for (const t of ALL_TABLES()) await t.clear()
    await db.categories.bulkAdd(toAdd.categories as never[])
    await db.accounts.bulkAdd(toAdd.accounts as never[])
    await db.transactions.bulkAdd(toAdd.transactions as never[])
    await db.budgets.bulkAdd(toAdd.budgets as never[])
    await db.loans.bulkAdd(toAdd.loans as never[])
    await db.loanPayments.bulkAdd(toAdd.loanPayments as never[])
    await db.goals.bulkAdd(toAdd.goals as never[])
    if (mode === 'replace' && b.data.settings) await db.settings.put({ ...b.data.settings, lastBackupAt: b.data.settings.lastBackupAt })
  })
  await ensureSeed()
  return preview
}
