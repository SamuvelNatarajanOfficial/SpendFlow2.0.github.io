import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vault } from '@/vault/store'
import type { TableMap, TableName } from '@/vault/format'
import { accounts, budgets, recurring, categories, goals, loans, transactions, RepoError, getSettings } from './repo'
import { applyRestore, buildBackup, exportEncryptedBackup, inspectBackupFile, openBackupFile, previewRestore } from './backup'
import { encryptBackup } from '@/vault/backupFile'
import { previewCsv, transactionsToCsv } from './csv'
import { applyCsvImport } from './importCsv'
import { loadSampleData, removeSampleData } from './sample'
import { accountBalance } from '@/lib/calc/ledger'
import { builtInCategoryId } from './defaults'

const PW = 'correct horse battery staple 42!'

/** Test-only adapter so assertions read against the decrypted in-memory vault like a table. */
function tbl<K extends TableName>(t: K) {
  type R = TableMap[K]
  return {
    toArray: async (): Promise<R[]> => vault.all(t),
    get: async (id: string): Promise<R | undefined> => vault.get(t, id),
    count: async (): Promise<number> => vault.count(t),
    where: (field: string) => ({ equals: (v: unknown) => ({ first: async (): Promise<R | undefined> => vault.all(t).find((r) => (r as unknown as Record<string, unknown>)[field] === v) }) }),
    filter: (fn: (r: R) => boolean) => ({ first: async (): Promise<R | undefined> => vault.filter(t, fn)[0] }),
    delete: async (id: string) => vault.write((w) => w.delete(t, id)),
    clear: async () => vault.write((w) => vault.all(t).forEach((r) => w.delete(t, r.id))),
  }
}
const db = { accounts: tbl('accounts'), transactions: tbl('transactions'), categories: tbl('categories'), budgets: tbl('budgets'), loans: tbl('loans'), loanPayments: tbl('loanPayments'), goals: tbl('goals'), settings: tbl('settings') }

const food = builtInCategoryId('expense', 'Groceries')
const salary = builtInCategoryId('income', 'Salary')

async function wipe() {
  await vault.destroy()
  await vault.initialize(PW, { iterations: 1000 })
}
beforeEach(wipe)

async function seedBasic() {
  const a = await accounts.create({ name: 'HDFC', type: 'savings', openingBalance: 100000 })
  const b = await accounts.create({ name: 'Cash', type: 'cash', openingBalance: 0 })
  await transactions.create({ type: 'income', amount: 500000, date: '2025-03-01', accountId: a.id, categoryId: salary, paymentMethod: 'netbanking' })
  await transactions.create({ type: 'expense', amount: 25050, date: '2025-03-02', accountId: a.id, categoryId: food, paymentMethod: 'upi', merchant: 'Mart' })
  await transactions.create({ type: 'transfer', amount: 10000, date: '2025-03-03', accountId: a.id, toAccountId: b.id, paymentMethod: 'other' })
  return { a, b }
}

describe('persistence & repositories', () => {
  it('seeds default categories and settings when the vault is created', async () => {
    const cats = await db.categories.toArray()
    expect(cats.length).toBe(18)
    expect((await getSettings()).timezone).toBe('Asia/Kolkata')
  })
  it('stores records durably and computes balances from them', async () => {
    const { a, b } = await seedBasic()
    const txs = await db.transactions.toArray() // fresh read from IndexedDB
    expect(txs).toHaveLength(3)
    expect(accountBalance((await db.accounts.get(a.id))!, txs)).toBe(100000 + 500000 - 25050 - 10000)
    expect(accountBalance((await db.accounts.get(b.id))!, txs)).toBe(10000)
  })
  it('rejects invalid amounts, dates, transfers and category kinds', async () => {
    const { a } = await seedBasic()
    const base = { type: 'expense' as const, amount: 100, date: '2025-03-02', accountId: a.id, categoryId: food, paymentMethod: 'upi' as const }
    await expect(transactions.create({ ...base, amount: 0 })).rejects.toThrow(RepoError)
    await expect(transactions.create({ ...base, amount: -5 })).rejects.toThrow()
    await expect(transactions.create({ ...base, amount: 10.5 })).rejects.toThrow()
    await expect(transactions.create({ ...base, date: '2025-02-30' })).rejects.toThrow(/valid date/)
    await expect(transactions.create({ ...base, type: 'transfer', toAccountId: a.id })).rejects.toThrow(/differ/)
    await expect(transactions.create({ ...base, categoryId: salary })).rejects.toThrow(/not an expense/)
    await expect(transactions.create({ ...base, accountId: 'ghost' })).rejects.toThrow(/no longer exists/)
  })
  it('edits and deletes transactions', async () => {
    const { a } = await seedBasic()
    const t = (await db.transactions.where('type').equals('expense').first())!
    await transactions.update(t.id, { amount: 30000, merchant: undefined })
    const u = (await db.transactions.get(t.id))!
    expect(u.amount).toBe(30000)
    expect(u.merchant).toBeUndefined()
    await transactions.remove(t.id)
    expect(await db.transactions.get(t.id)).toBeUndefined()
    expect(await db.accounts.get(a.id)).toBeDefined()
  })
  it('blocks deleting accounts and categories that are in use', async () => {
    const { a } = await seedBasic()
    await expect(accounts.remove(a.id)).rejects.toThrow(/Archive/)
    await expect(categories.remove(food)).rejects.toThrow(/transaction/)
    const unused = await accounts.create({ name: 'Unused', type: 'other', openingBalance: 0 })
    await accounts.remove(unused.id)
    await expect(accounts.create({ name: 'hdfc', type: 'other', openingBalance: 0 })).rejects.toThrow(/already exists/)
  })
  it('supports custom categories and one budget per category+month', async () => {
    const c = await categories.create({ name: 'Pets', kind: 'expense', color: '#123456' })
    await budgets.upsert(c.id, '2025-03', 500000)
    await budgets.upsert(c.id, '2025-03', 700000)
    const all = await db.budgets.toArray()
    expect(all).toHaveLength(1)
    expect(all[0]!.amount).toBe(700000)
    expect(await budgets.copyMonth('2025-03', '2025-04')).toBe(1)
    expect(await budgets.copyMonth('2025-03', '2025-04')).toBe(0)
    await categories.remove(c.id) // also removes its budgets
    expect(await db.budgets.count()).toBe(0)
  })
  it('goals validate', async () => {
    await expect(goals.create({ name: 'X', kind: 'savings', target: 0, saved: 0 })).rejects.toThrow()
    const g = await goals.create({ name: 'Trip', kind: 'purchase', target: 100000, saved: 20000 })
    await goals.update(g.id, { saved: 30000 })
    expect((await db.goals.get(g.id))?.saved).toBe(30000)
  })
})

describe('recurring transactions', () => {
  async function series() {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 100000 })
    const base = { type: 'expense' as const, amount: 20000, accountId: a.id, categoryId: food, paymentMethod: 'upi' as const, merchant: 'Gym', recurring: 'monthly' as const }
    const t1 = await transactions.create({ ...base, date: '2025-01-31' })
    const t2 = await transactions.create({ ...base, date: '2025-02-28' })
    return { a, t1, t2 }
  }
  it('records the next occurrence from the latest entry, once per period', async () => {
    const { a, t1 } = await series()
    const n = await recurring.recordNext(t1.id, '2025-03-31') // passing an OLD entry still continues from the latest
    expect(n).toMatchObject({ date: '2025-03-31', amount: 20000, merchant: 'Gym', recurring: 'monthly', accountId: a.id })
    const n2 = await recurring.recordNext(t1.id, '2025-04-30')
    expect(n2.date).toBe('2025-04-30') // 31st clamps to 30 in April, no permanent drift
    expect(await db.transactions.count()).toBe(4)
    expect(accountBalance((await db.accounts.get(a.id))!, await db.transactions.toArray())).toBe(100000 - 4 * 20000)
  })
  it('refuses to record something that is not due yet', async () => {
    const { t2 } = await series()
    await expect(recurring.recordNext(t2.id, '2025-03-30')).rejects.toThrow(/Not due yet/)
    expect(await db.transactions.count()).toBe(2)
  })
  it('stop ends the whole series without touching entries or balances', async () => {
    const { t1 } = await series()
    expect(await recurring.stop(t1.id)).toBe(2)
    const rows = await db.transactions.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.recurring === undefined)).toBe(true)
    await expect(recurring.recordNext(t1.id, '2026-01-01')).rejects.toThrow(/no longer part/)
    expect(await recurring.stop(t1.id)).toBe(0)
  })
  it('does not post into an account that was deleted', async () => {
    const { t2 } = await series()
    await db.accounts.clear()
    await expect(recurring.recordNext(t2.id, '2025-12-31')).rejects.toThrow(/no longer exists/)
  })
})

describe('loan payments', () => {
  async function mkLoan() {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 5000000 })
    const loan = await loans.create({
      name: 'Home', lender: 'SBI', principal: 100000000, outstanding: 100000000, annualRate: 8.5, emi: 867823, dueDay: 5,
      startDate: '2025-01-05', tenureMonths: 240, accountId: a.id,
    })
    return { a, loan }
  }
  it('EMI reduces outstanding by principal only and records ONE expense', async () => {
    const { a, loan } = await mkLoan()
    const p = await loans.recordPayment({ loanId: loan.id, date: '2025-02-05', kind: 'emi', amount: 867823, accountId: a.id })
    expect(p.interest).toBe(708333)
    expect(p.principal).toBe(867823 - 708333)
    expect((await db.loans.get(loan.id))!.outstanding).toBe(100000000 - p.principal)
    const txs = await db.transactions.toArray()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ type: 'expense', amount: 867823, loanPaymentId: p.id, accountId: a.id })
    expect(accountBalance((await db.accounts.get(a.id))!, txs)).toBe(5000000 - 867823)
  })
  it('prepayment reduces principal fully; deleting a payment restores balance and expense', async () => {
    const { a, loan } = await mkLoan()
    const p = await loans.recordPayment({ loanId: loan.id, date: '2025-02-10', kind: 'prepayment', amount: 1000000, accountId: a.id })
    expect((await db.loans.get(loan.id))!.outstanding).toBe(99000000)
    await loans.deletePayment(p.id)
    expect((await db.loans.get(loan.id))!.outstanding).toBe(100000000)
    expect(await db.transactions.count()).toBe(0)
  })
  it('can record a payment without touching any account', async () => {
    const { loan } = await mkLoan()
    await loans.recordPayment({ loanId: loan.id, date: '2025-02-05', kind: 'emi', amount: 867823 })
    expect(await db.transactions.count()).toBe(0)
  })
  it('linked expenses cannot be edited from the transactions screen; deleting a loan cleans up', async () => {
    const { a, loan } = await mkLoan()
    await loans.recordPayment({ loanId: loan.id, date: '2025-02-05', kind: 'emi', amount: 867823, accountId: a.id })
    const t = (await db.transactions.toArray())[0]
    await expect(transactions.update(t!.id, { amount: 1 })).rejects.toThrow(/Loans page/)
    await expect(transactions.remove(t!.id)).rejects.toThrow(/Loans page/)
    await loans.remove(loan.id)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.loanPayments.count()).toBe(0)
  })
  it('rejects outstanding above principal and payments on repaid loans', async () => {
    const { loan } = await mkLoan()
    await expect(loans.update(loan.id, { outstanding: loan.principal + 1 })).rejects.toThrow()
    await loans.update(loan.id, { outstanding: 0 }) // manual correction
    await expect(loans.recordPayment({ loanId: loan.id, date: '2025-02-05', kind: 'emi', amount: 100 })).rejects.toThrow(/repaid/)
  })
})

describe('backup & restore (encrypted)', () => {
  const BPW = 'another long backup passphrase 7!'
  const fast = { iterations: 1000 }

  it('exports an encrypted file that round-trips through replace restore', async () => {
    await seedBasic()
    await loadSampleData('2025-06-15')
    const before = buildBackup()
    const { text, filename } = await exportEncryptedBackup(BPW, fast)
    expect(filename).toMatch(/^spendflow-backup-\d{4}-\d{2}-\d{2}\.sfbackup\.json$/)
    // the file must not contain any financial text in clear
    for (const needle of ['HDFC', 'Mart', 'Salary', 'Sample Home Loan', 'Acme Technologies']) expect(text).not.toContain(needle)

    await vault.destroy()
    await vault.initialize(PW, fast) // "a different device": fresh vault, different password
    const opened = await openBackupFile(text, BPW)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const preview = await applyRestore(opened.opened.backup, 'replace')
    expect(preview.tables.find((t) => t.key === 'transactions')?.added).toBe(before.data.transactions.length)
    const after = buildBackup()
    for (const k of ['accounts', 'transactions', 'budgets', 'loans', 'loanPayments', 'goals'] as const) {
      expect(after.data[k].slice().sort((x, y) => x.id.localeCompare(y.id))).toEqual(before.data[k].slice().sort((x, y) => x.id.localeCompare(y.id)))
    }
    expect(after.data.categories.length).toBe(before.data.categories.length)
  })

  it('merge never overwrites existing records and skips id collisions', async () => {
    const { a } = await seedBasic()
    const snap = buildBackup()
    await accounts.update(a.id, { name: 'HDFC Renamed' })
    const p = previewRestore(snap, 'merge')
    expect(p.totalSkipped).toBe(snap.data.accounts.length + snap.data.transactions.length + snap.data.categories.length)
    await applyRestore(snap, 'merge')
    expect((await db.accounts.get(a.id))?.name).toBe('HDFC Renamed') // not silently overwritten
    expect(await db.transactions.count()).toBe(3) // not duplicated
  })

  it('merge adds only the missing records', async () => {
    await seedBasic()
    const snap = buildBackup()
    const extra = (await db.transactions.where('type').equals('expense').first())!
    await db.transactions.delete(extra.id)
    await applyRestore(snap, 'merge')
    expect(await db.transactions.count()).toBe(3)
  })

  it('public header reveals no financial data and no counts', async () => {
    await seedBasic()
    const { text } = await exportEncryptedBackup(BPW, fast)
    const stage = inspectBackupFile(text)
    expect(stage.ok && stage.kind === 'encrypted').toBe(true)
    const keys = Object.keys(JSON.parse(text)).sort()
    expect(keys).toEqual(['appSchemaVersion', 'cipher', 'ciphertext', 'createdAt', 'format', 'formatVersion', 'iv', 'kdf'])
    expect(text).not.toMatch(/accounts|transactions|amount|merchant/)
  })

  it('wrong password, tampered ciphertext, tampered header all fail with the same generic message', async () => {
    await seedBasic()
    const { text } = await exportEncryptedBackup(BPW, fast)
    const wrong = await openBackupFile(text, 'not the right password at all 1!')
    expect(wrong).toMatchObject({ ok: false, errors: [expect.stringMatching(/password is wrong, or the file was modified/)] })

    const env = JSON.parse(text)
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64')
      bytes[Math.floor(bytes.length / 2)]! ^= 0x01
      return bytes.toString('base64')
    }
    const tamperedCt = await openBackupFile(JSON.stringify({ ...env, ciphertext: flip(env.ciphertext) }), BPW)
    expect(tamperedCt.ok).toBe(false)
    // header fields are bound into the AAD: changing the date or the app schema version breaks authentication
    const tamperedDate = await openBackupFile(JSON.stringify({ ...env, createdAt: '2020-01-01T00:00:00.000Z' }), BPW)
    expect(tamperedDate.ok).toBe(false)
    const tamperedVersion = await openBackupFile(JSON.stringify({ ...env, appSchemaVersion: 2 }), BPW)
    expect(tamperedVersion.ok).toBe(false)
    const swappedSalt = await openBackupFile(JSON.stringify({ ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt) } }), BPW)
    expect(swappedSalt.ok).toBe(false)
    // and the untouched file still opens
    expect((await openBackupFile(text, BPW)).ok).toBe(true)
  })

  it('rejects unsupported versions, malformed envelopes, foreign and oversized files clearly', async () => {
    await seedBasic()
    const env = JSON.parse((await exportEncryptedBackup(BPW, fast)).text)
    expect(inspectBackupFile(JSON.stringify({ ...env, formatVersion: 2 }))).toMatchObject({ ok: false, message: expect.stringMatching(/format version 2/) })
    expect(inspectBackupFile(JSON.stringify({ ...env, iv: 'AAAA' }))).toMatchObject({ ok: false, message: expect.stringMatching(/damaged/) })
    expect(inspectBackupFile(JSON.stringify({ ...env, kdf: { ...env.kdf, iterations: 2_000_000_000 } }))).toMatchObject({ ok: false })
    expect(inspectBackupFile(JSON.stringify({ ...env, kdf: { ...env.kdf, iterations: 1 } }))).toMatchObject({ ok: false })
    expect(inspectBackupFile('not json')).toMatchObject({ ok: false, message: expect.stringMatching(/not valid JSON/) })
    expect(inspectBackupFile('{"hello":1}')).toMatchObject({ ok: false })
    expect(inspectBackupFile(' '.repeat(26 * 1024 * 1024))).toMatchObject({ ok: false, message: expect.stringMatching(/25 MB/) })
  })

  it('rejects a correctly encrypted backup whose CONTENT is invalid or from a newer schema', async () => {
    await seedBasic()
    const snap = buildBackup()
    const bad = structuredClone(snap)
    bad.data.transactions[0]!.amount = -4
    const badFile = await encryptBackup(JSON.stringify(bad), BPW, fast)
    expect(await openBackupFile(badFile, BPW)).toMatchObject({ ok: false })
    const orphan = structuredClone(snap)
    orphan.data.accounts = []
    expect(await openBackupFile(await encryptBackup(JSON.stringify(orphan), BPW, fast), BPW)).toMatchObject({ ok: false, errors: [expect.stringMatching(/reference an account/)] })
    const newer = await encryptBackup(JSON.stringify({ ...snap, schemaVersion: 99 }), BPW, fast)
    expect(await openBackupFile(newer, BPW)).toMatchObject({ ok: false, errors: [expect.stringMatching(/newer version/)] })
    const dup = await encryptBackup(JSON.stringify({ ...snap, data: { ...snap.data, transactions: [snap.data.transactions[0], snap.data.transactions[0]] } }), BPW, fast)
    expect(await openBackupFile(dup, BPW)).toMatchObject({ ok: false })
    expect(await db.transactions.count()).toBe(3) // failed opens changed nothing
  })

  it('still imports an OLD unencrypted backup (and re-encrypts it into the vault)', async () => {
    await seedBasic()
    const legacy = JSON.stringify(buildBackup())
    const stage = inspectBackupFile(legacy)
    expect(stage).toMatchObject({ ok: true, kind: 'legacy-plain' })
    await vault.destroy()
    await vault.initialize(PW, fast)
    const r = await openBackupFile(legacy, '')
    expect(r.ok && r.opened.warnings.join(' ')).toMatch(/UNENCRYPTED/)
    if (r.ok) await applyRestore(r.opened.backup, 'replace')
    expect(await db.transactions.count()).toBe(3)
  })

  it('refuses to create a backup with a weak password', async () => {
    await expect(exportEncryptedBackup('short', fast)).rejects.toThrow(/stronger/)
  })

  it('an interrupted replace-restore never destroys the existing vault', async () => {
    await seedBasic()
    const { text } = await exportEncryptedBackup(BPW, fast)
    const opened = await openBackupFile(text, BPW)
    if (!opened.ok) throw new Error('setup')
    // add a record the backup does not contain, so we can tell whether the vault was replaced
    await accounts.create({ name: 'Only In Vault', type: 'other', openingBalance: 5 })
    const snapshotBefore = JSON.stringify((await vault._rawRows()).rows.map((r) => r.key).sort())

    // (a) failure while ENCRYPTING the staged replacement
    const enc = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
    let calls = 0
    enc.mockImplementation(async (...args) => {
      if (++calls === 5) throw new Error('simulated crypto failure')
      return (Object.getPrototypeOf(globalThis.crypto.subtle).encrypt as SubtleCrypto['encrypt']).apply(globalThis.crypto.subtle, args)
    })
    await expect(applyRestore(opened.opened.backup, 'replace')).rejects.toThrow()
    enc.mockRestore()

    // (b) failure while WRITING the swap transaction
    const put = vi.spyOn(vault._rawDb().records, 'bulkPut').mockRejectedValueOnce(new Error('simulated disk failure'))
    await expect(applyRestore(opened.opened.backup, 'replace')).rejects.toThrow()
    put.mockRestore()

    // memory AND persisted storage are both exactly as before
    expect((await db.accounts.filter((a) => a.name === 'Only In Vault').first())?.name).toBe('Only In Vault')
    expect(JSON.stringify((await vault._rawRows()).rows.map((r) => r.key).sort())).toBe(snapshotBefore)
    await vault.lock()
    await vault.unlock(PW)
    expect(await db.transactions.count()).toBe(3)
    expect((await db.accounts.filter((a) => a.name === 'Only In Vault').first())?.name).toBe('Only In Vault')
    // and a later restore still works
    await applyRestore(opened.opened.backup, 'replace')
    expect(await db.accounts.filter((a) => a.name === 'Only In Vault').first()).toBeUndefined()
  })
})

describe('csv', () => {
  it('exports and re-imports identical data as duplicates', async () => {
    const { a } = await seedBasic()
    const [accs, cats, txs] = await Promise.all([db.accounts.toArray(), db.categories.toArray(), db.transactions.toArray()])
    const csv = transactionsToCsv(txs, accs, cats)
    expect(csv.split('\r\n')[0]).toBe('date,type,amount,category,account,to_account,payment_method,merchant,notes,essential,recurring')
    expect(csv).toContain('250.50')
    const prev = previewCsv(csv, { accounts: accs, categories: cats, existing: txs })
    expect(prev.counts).toEqual({ ok: 0, duplicate: 3, error: 0 })
    expect((await applyCsvImport(prev, false)).imported).toBe(0)
    expect(await db.transactions.count()).toBe(3)
    expect(a.id).toBeTruthy()
  })
  it('validates rows, reports line errors, creates new categories, detects in-file duplicates', async () => {
    await seedBasic()
    const [accs, cats, txs] = await Promise.all([db.accounts.toArray(), db.categories.toArray(), db.transactions.toArray()])
    const csv = [
      'Date,Type,Amount,Category,Account,Notes',
      '10/03/2025,expense,"1,200.50",Pet care,HDFC,vet',
      '2025-03-11,expense,50,Groceries,HDFC,x',
      '2025-03-11,expense,50,Groceries,HDFC,x',
      '2025-02-30,expense,10,Groceries,HDFC,bad date',
      '2025-03-12,expense,abc,Groceries,HDFC,bad amount',
      '2025-03-12,expense,10,Groceries,Nowhere,bad account',
      '2025-03-13,gift,10,Groceries,HDFC,bad type',
      '2025-03-14,,-75,Groceries,HDFC,sign infers expense',
      '=2025-03-15,expense,5,Groceries,HDFC,formula',
    ].join('\n')
    const prev = previewCsv(csv, { accounts: accs, categories: cats, existing: txs })
    expect(prev.fatal).toEqual([])
    expect(prev.counts).toEqual({ ok: 3, duplicate: 1, error: 5 })
    expect(prev.rows[0]!.tx?.date).toBe('2025-03-10')
    expect(prev.rows[0]!.tx?.amount).toBe(120050)
    expect(prev.newCategories).toEqual([{ name: 'Pet care', kind: 'expense' }])
    expect(prev.rows[2]!.duplicateOf).toBe('file')
    expect(prev.rows[3]!.errors[0]).toMatch(/Invalid date/)
    expect(prev.rows[5]!.errors[0]).toMatch(/Unknown account/)
    expect(prev.rows[7]!.tx).toMatchObject({ type: 'expense', amount: 7500 })
    const r = await applyCsvImport(prev, false)
    expect(r).toEqual({ imported: 3, categoriesCreated: 1 })
    expect((await db.categories.toArray()).some((c) => c.name === 'Pet care')).toBe(true)
    // including duplicates is an explicit opt-in
    const again = previewCsv(csv, { accounts: accs, categories: await db.categories.toArray(), existing: await db.transactions.toArray() })
    expect((await applyCsvImport(again, true)).imported).toBe(again.counts.ok + again.counts.duplicate)
  })
  it('fails fast on a file without required columns', () => {
    const p = previewCsv('foo,bar\n1,2', { accounts: [], categories: [], existing: [] })
    expect(p.fatal.length).toBeGreaterThan(0)
  })
  it('escapes spreadsheet formulas on export', async () => {
    const a = await accounts.create({ name: 'A', type: 'cash', openingBalance: 0 })
    await transactions.create({ type: 'expense', amount: 100, date: '2025-03-01', accountId: a.id, paymentMethod: 'cash', merchant: '=HYPERLINK("http://x")' })
    const csv = transactionsToCsv(await db.transactions.toArray(), await db.accounts.toArray(), await db.categories.toArray())
    expect(csv).not.toMatch(/,=HYPERLINK/)
  })
})

describe('sample data', () => {
  it('loads flagged sample data and removes only it, preserving real data', async () => {
    const real = await accounts.create({ name: 'Real Bank', type: 'savings', openingBalance: 1000 })
    await transactions.create({ type: 'expense', amount: 500, date: '2025-06-01', accountId: real.id, paymentMethod: 'upi' })
    await loadSampleData('2025-06-15')
    expect(await db.transactions.count()).toBeGreaterThan(20)
    expect((await db.loans.toArray()).every((l) => l.isSample)).toBe(true)
    // user adds a real transaction into a sample account
    const sampleAcc = (await db.accounts.filter((a) => !!a.isSample).first())!
    await transactions.create({ type: 'expense', amount: 700, date: '2025-06-10', accountId: sampleAcc.id, paymentMethod: 'cash' })
    await removeSampleData()
    expect(await db.loans.count()).toBe(0)
    expect(await db.goals.count()).toBe(0)
    expect(await db.budgets.count()).toBe(0)
    expect(await db.transactions.count()).toBe(2) // the two real ones
    expect((await db.accounts.toArray()).map((a) => a.name).sort()).toEqual(['Real Bank', sampleAcc.name].sort())
    expect((await db.accounts.get(sampleAcc.id))?.isSample).toBe(false)
  })
})
