import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { accounts, budgets, categories, clearAllData, ensureSeed, goals, loans, transactions, RepoError } from './repo'
import { applyRestore, buildBackup, exportBackupJson, parseBackup, previewRestore } from './backup'
import { previewCsv, transactionsToCsv } from './csv'
import { applyCsvImport } from './importCsv'
import { loadSampleData, removeSampleData } from './sample'
import { accountBalance } from '@/lib/calc/ledger'
import { builtInCategoryId } from './defaults'

const food = builtInCategoryId('expense', 'Groceries')
const salary = builtInCategoryId('income', 'Salary')

async function wipe() {
  for (const t of db.tables) await t.clear()
  await ensureSeed()
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
  it('seeds default categories and settings exactly once', async () => {
    await ensureSeed()
    await ensureSeed()
    const cats = await db.categories.toArray()
    expect(cats.length).toBe(18)
    expect((await db.settings.get('app'))?.timezone).toBe('Asia/Kolkata')
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
    expect(all[0].amount).toBe(700000)
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
    await expect(transactions.update(t.id, { amount: 1 })).rejects.toThrow(/Loans page/)
    await expect(transactions.remove(t.id)).rejects.toThrow(/Loans page/)
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

describe('backup & restore', () => {
  it('exports a versioned backup that round-trips through replace restore', async () => {
    await seedBasic()
    await loadSampleData('2025-06-15')
    const before = await buildBackup()
    const { json } = await exportBackupJson()
    const parsed = parseBackup(json)
    expect(parsed.ok).toBe(true)
    await clearAllData()
    expect(await db.transactions.count()).toBe(0)
    if (!parsed.ok) return
    const preview = await applyRestore(parsed.backup, 'replace')
    expect(preview.tables.find((t) => t.key === 'transactions')?.added).toBe(before.data.transactions.length)
    const after = await buildBackup()
    for (const k of ['accounts', 'transactions', 'budgets', 'loans', 'loanPayments', 'goals'] as const) {
      expect(after.data[k].slice().sort((x, y) => x.id.localeCompare(y.id))).toEqual(before.data[k].slice().sort((x, y) => x.id.localeCompare(y.id)))
    }
    expect(after.data.categories.length).toBe(before.data.categories.length)
  })
  it('merge never overwrites existing records and skips id collisions', async () => {
    const { a } = await seedBasic()
    const snap = await buildBackup()
    await accounts.update(a.id, { name: 'HDFC Renamed' })
    const p = await previewRestore(snap, 'merge')
    expect(p.totalSkipped).toBe(snap.data.accounts.length + snap.data.transactions.length + snap.data.categories.length)
    await applyRestore(snap, 'merge')
    expect((await db.accounts.get(a.id))?.name).toBe('HDFC Renamed') // not silently overwritten
    expect(await db.transactions.count()).toBe(3) // not duplicated
  })
  it('merge adds only the missing records', async () => {
    await seedBasic()
    const snap = await buildBackup()
    const extra = (await db.transactions.where('type').equals('expense').first())!
    await db.transactions.delete(extra.id)
    await applyRestore(snap, 'merge')
    expect(await db.transactions.count()).toBe(3)
  })
  it('rejects malformed, foreign, newer-version and inconsistent files with clear errors', async () => {
    expect(parseBackup('not json')).toMatchObject({ ok: false })
    expect(parseBackup('{"hello":1}')).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a SpendFlow/)] })
    expect(parseBackup('{"app":"spendflow","schemaVersion":99,"data":{}}')).toMatchObject({ ok: false, errors: [expect.stringMatching(/newer version/)] })
    await seedBasic()
    const snap = await buildBackup()
    const bad = structuredClone(snap)
    bad.data.transactions[0].amount = -4
    const r = parseBackup(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    const orphan = structuredClone(snap)
    orphan.data.accounts = []
    const r2 = parseBackup(JSON.stringify(orphan))
    expect(r2).toMatchObject({ ok: false, errors: [expect.stringMatching(/reference an account/)] })
    expect(parseBackup(JSON.stringify({ ...snap, data: { ...snap.data, transactions: [snap.data.transactions[0], snap.data.transactions[0]] } }))).toMatchObject({ ok: false })
    await expect(db.transactions.count()).resolves.toBe(3) // failed parse changed nothing
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
    expect(prev.rows[0].tx?.date).toBe('2025-03-10')
    expect(prev.rows[0].tx?.amount).toBe(120050)
    expect(prev.newCategories).toEqual([{ name: 'Pet care', kind: 'expense' }])
    expect(prev.rows[2].duplicateOf).toBe('file')
    expect(prev.rows[3].errors[0]).toMatch(/Invalid date/)
    expect(prev.rows[5].errors[0]).toMatch(/Unknown account/)
    expect(prev.rows[7].tx).toMatchObject({ type: 'expense', amount: 7500 })
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
