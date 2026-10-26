import Papa from 'papaparse'
import type { Account, Category, PaymentMethod, Transaction, TxType } from '@/types'
import { PAYMENT_METHODS } from '@/types'
import { isValidDate, makeDate } from '@/lib/dates'
import { paiseToInput, parseRupees } from '@/lib/money'
import { CATEGORY_COLORS } from './defaults'

export const CSV_HEADERS = ['date', 'type', 'amount', 'category', 'account', 'to_account', 'payment_method', 'merchant', 'notes', 'essential', 'recurring'] as const

export function transactionsToCsv(txs: Transaction[], accounts: Account[], categories: Category[]): string {
  const acc = new Map(accounts.map((a) => [a.id, a.name]))
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const rows = [...txs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => [
      t.date, t.type, paiseToInput(t.amount), cat.get(t.categoryId ?? '') ?? '', acc.get(t.accountId) ?? '', acc.get(t.toAccountId ?? '') ?? '',
      t.paymentMethod, t.merchant ?? '', t.notes ?? '', t.type === 'expense' ? String(!!t.essential) : '', t.recurring ?? '',
    ])
  // escapeFormulae neutralises =,+,-,@ prefixes so the file is safe to open in Excel
  return Papa.unparse({ fields: [...CSV_HEADERS], data: rows }, { escapeFormulae: true, newline: '\r\n' })
}

/** Generic report export (formula-escaped). */
export function rowsToCsv(fields: string[], rows: (string | number)[][]): string {
  return Papa.unparse({ fields, data: rows }, { escapeFormulae: true, newline: '\r\n' })
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------- import ----------

const ALIASES: Record<string, string[]> = {
  date: ['date', 'transactiondate', 'txndate', 'valuedate'],
  type: ['type', 'transactiontype', 'txntype', 'drcr'],
  amount: ['amount', 'amt', 'value', 'inr'],
  category: ['category', 'cat'],
  account: ['account', 'accountname', 'from', 'fromaccount'],
  to_account: ['toaccount', 'to', 'destination', 'destinationaccount'],
  payment_method: ['paymentmethod', 'method', 'mode', 'paymentmode'],
  merchant: ['merchant', 'payee', 'payer', 'party', 'source'],
  notes: ['notes', 'note', 'description', 'memo', 'narration', 'remarks'],
  essential: ['essential'],
  recurring: ['recurring', 'frequency'],
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

export interface ImportRow {
  line: number // 1-based line in the file (header = line 1)
  status: 'ok' | 'duplicate' | 'error'
  errors: string[]
  tx?: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
  newCategory?: { name: string; kind: 'income' | 'expense' }
  duplicateOf?: 'existing' | 'file'
}

export interface ImportPreview {
  rows: ImportRow[]
  fatal: string[]
  newCategories: { name: string; kind: 'income' | 'expense' }[]
  counts: { ok: number; duplicate: number; error: number }
}

export interface ImportContext {
  accounts: Account[]
  categories: Category[]
  existing: Transaction[]
  defaultAccountId?: string
}

export function normalizeDate(raw: string): string | null {
  const s = raw.trim()
  if (isValidDate(s)) return s
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s) // DD/MM/YYYY (Indian convention)
  if (m) {
    const d = makeDate(+m[3], +m[2], +m[1])
    const [dd, mm] = [+m[1], +m[2]]
    if (mm >= 1 && mm <= 12 && isValidDate(d) && +d.slice(8) === dd) return d
  }
  return null
}

export const dupKey = (t: { date: string; type: string; amount: number; accountId: string; toAccountId?: string; merchant?: string; notes?: string }) =>
  [t.date, t.type, t.amount, t.accountId, t.toAccountId ?? '', (t.merchant ?? '').trim().toLowerCase(), (t.notes ?? '').trim().toLowerCase()].join('|')

const MAX_ROWS = 20000

const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)

export function previewCsv(text: string, ctx: ImportContext): ImportPreview {
  const fatal: string[] = []
  const parsed = Papa.parse<Record<string, string>>(stripBom(text), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => norm(h) })
  if (parsed.errors.some((e) => e.type === 'Delimiter' || e.type === 'Quotes')) fatal.push('The file could not be parsed as CSV: ' + parsed.errors[0].message)
  const fields = parsed.meta.fields ?? []
  const col = (key: string) => fields.find((f) => ALIASES[key].includes(f))
  for (const req of ['date', 'amount']) if (!col(req)) fatal.push(`Missing required column "${req}". Expected headers: ${['date', 'type', 'amount', 'category', 'account'].join(', ')}.`)
  if (parsed.data.length === 0) fatal.push('The file has no data rows.')
  if (parsed.data.length > MAX_ROWS) fatal.push(`Too many rows (${parsed.data.length}). Import at most ${MAX_ROWS} rows at a time.`)
  if (fatal.length) return { rows: [], fatal, newCategories: [], counts: { ok: 0, duplicate: 0, error: 0 } }

  const accByName = new Map(ctx.accounts.filter((a) => !a.archived).map((a) => [a.name.trim().toLowerCase(), a]))
  const catByKey = new Map(ctx.categories.map((c) => [`${c.kind}|${c.name.trim().toLowerCase()}`, c]))
  const seen = new Set(ctx.existing.map(dupKey))
  const newCats = new Map<string, { name: string; kind: 'income' | 'expense' }>()
  const get = (r: Record<string, string>, key: string) => {
    const c = col(key)
    return c ? (r[c] ?? '').toString().trim() : ''
  }
  const validMethods = new Set(PAYMENT_METHODS.map((p) => p.value))

  const rows: ImportRow[] = parsed.data.map((r, i) => {
    const errors: string[] = []
    const row: ImportRow = { line: i + 2, status: 'ok', errors }
    const date = normalizeDate(get(r, 'date'))
    if (!date) errors.push(`Invalid date "${get(r, 'date')}" (use YYYY-MM-DD or DD/MM/YYYY)`)

    const rawAmt = get(r, 'amount')
    let amount = parseRupees(rawAmt)
    if (amount === null) errors.push(`Invalid amount "${rawAmt}"`)

    let type: TxType | null = null
    const rawType = get(r, 'type').toLowerCase()
    if (['income', 'credit', 'cr'].includes(rawType)) type = 'income'
    else if (['expense', 'debit', 'dr'].includes(rawType)) type = 'expense'
    else if (rawType === 'transfer') type = 'transfer'
    else if (!rawType && amount !== null) type = amount < 0 ? 'expense' : 'income'
    else errors.push(`Unknown type "${get(r, 'type')}" (use income, expense or transfer)`)
    if (amount !== null) {
      amount = Math.abs(amount)
      if (amount === 0) errors.push('Amount must be greater than zero')
    }

    const accName = get(r, 'account')
    const account: Account | undefined = accName ? accByName.get(accName.toLowerCase()) : ctx.accounts.find((a) => a.id === ctx.defaultAccountId)
    if (!account) errors.push(accName ? `Unknown account "${accName}" (create it first)` : 'No account given and no default account chosen')
    let toAccount: Account | undefined
    if (type === 'transfer') {
      const to = get(r, 'to_account')
      toAccount = accByName.get(to.toLowerCase())
      if (!toAccount) errors.push(to ? `Unknown destination account "${to}"` : 'Transfers need a to_account')
      else if (account && toAccount.id === account.id) errors.push('Transfer source and destination are the same')
    }

    let categoryId: string | undefined
    if (type && type !== 'transfer') {
      const cn = get(r, 'category')
      if (cn) {
        const c = catByKey.get(`${type}|${cn.toLowerCase()}`)
        if (c) categoryId = c.id
        else {
          const key = `${type}|${cn.toLowerCase()}`
          if (!newCats.has(key)) newCats.set(key, { name: cn, kind: type })
          row.newCategory = { name: cn, kind: type }
        }
      }
    }

    const mRaw = get(r, 'payment_method').toLowerCase().replace(/\s+/g, '-')
    const paymentMethod: PaymentMethod = validMethods.has(mRaw as PaymentMethod) ? (mRaw as PaymentMethod) : mRaw === 'upi' ? 'upi' : 'other'
    const recRaw = get(r, 'recurring').toLowerCase()
    const recurring = ['weekly', 'monthly', 'yearly'].includes(recRaw) ? (recRaw as 'weekly' | 'monthly' | 'yearly') : undefined
    const essRaw = get(r, 'essential').toLowerCase()

    if (errors.length || !date || amount === null || !type || !account) {
      row.status = 'error'
      return row
    }
    row.tx = {
      type, amount, date, accountId: account.id, toAccountId: toAccount?.id, categoryId, paymentMethod,
      merchant: get(r, 'merchant') || undefined, notes: get(r, 'notes') || undefined,
      essential: type === 'expense' ? ['true', 'yes', '1', 'y'].includes(essRaw) : undefined, recurring,
    }
    const key = dupKey(row.tx)
    if (seen.has(key)) {
      row.status = 'duplicate'
      row.duplicateOf = ctx.existing.some((t) => dupKey(t) === key) ? 'existing' : 'file'
    }
    seen.add(key)
    return row
  })

  const counts = { ok: 0, duplicate: 0, error: 0 }
  rows.forEach((r) => counts[r.status]++)
  return { rows, fatal, newCategories: [...newCats.values()], counts }
}

export function categoryColorFor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length]
}
