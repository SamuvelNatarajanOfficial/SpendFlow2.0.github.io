import { useMemo, useState } from 'react'
import { Download, Plus, Receipt, Search } from 'lucide-react'
import { useData } from '@/app/data'
import { useUI } from '@/app/ui-context'
import { RangeFilter, useRange } from '@/components/RangeFilter'
import { TransactionList, describeTx } from '@/components/TransactionList'
import { EmptyState, PageHeader, Stat, useConfirm, useToast } from '@/components/ui'
import { transactions as repo } from '@/db/repo'
import { transactionsToCsv } from '@/db/csv'
import { usePlainExport } from '@/components/usePlainExport'
import { filterByRange, searchTx, sortTx } from '@/lib/calc/ledger'
import { formatINR } from '@/lib/money'
import { formatDate } from '@/lib/dates'
import type { Transaction } from '@/types'

const PAGE = 100

export default function TransactionsPage({ type }: { type: 'income' | 'expense' }) {
  const d = useData()
  const { openTransaction } = useUI()
  const confirm = useConfirm()
  const toast = useToast()
  const plainExport = usePlainExport()
  const r = useRange('this-month')
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [kind, setKind] = useState<'' | 'essential' | 'discretionary' | 'recurring'>('')
  const [limit, setLimit] = useState(PAGE)
  const isIncome = type === 'income'

  const all = useMemo(() => d.transactions.filter((t) => t.type === type), [d.transactions, type])
  const filtered = useMemo(() => {
    let list = filterByRange(all, r.range)
    if (categoryId) list = list.filter((t) => t.categoryId === categoryId)
    if (accountId) list = list.filter((t) => t.accountId === accountId)
    if (kind === 'essential') list = list.filter((t) => t.essential)
    if (kind === 'discretionary') list = list.filter((t) => !t.essential)
    if (kind === 'recurring') list = list.filter((t) => !!t.recurring)
    return sortTx(searchTx(list, q, d.catMap, d.accMap))
  }, [all, r.range, categoryId, accountId, kind, q, d.catMap, d.accMap])
  const total = filtered.reduce((s, t) => s + t.amount, 0)
  const cats = d.categories.filter((c) => c.kind === type).sort((a, b) => a.name.localeCompare(b.name))
  const label = isIncome ? 'Income' : 'Expenses'

  const onDelete = async (t: Transaction) => {
    const name = describeTx(t, d.catMap.get(t.categoryId ?? '')?.name)
    const ok = await confirm({ title: `Delete this ${type}?`, message: <>"{name}" for <strong>{formatINR(t.amount)}</strong> on {formatDate(t.date)} will be permanently removed and the account balance will change.</> })
    if (!ok) return
    try {
      await repo.remove(t.id)
      toast('Deleted')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={label}
        subtitle={isIncome ? 'Salary, freelance, bonuses, refunds and other earnings' : 'Everything you spend, by category'}
        actions={
          <>
            <button type="button" className="btn-secondary" disabled={filtered.length === 0} onClick={() => plainExport(`spendflow-${type}.csv`, transactionsToCsv(filtered, d.accounts, d.categories))}>
              <Download size={16} /> CSV
            </button>
            <button type="button" className="btn-primary" onClick={() => openTransaction({ type })}><Plus size={16} /> Add {isIncome ? 'income' : 'expense'}</button>
          </>
        }
      />
      <RangeFilter r={r} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-3 text-subtle" />
          <label htmlFor="tx-search" className="sr-only">Search {label}</label>
          <input id="tx-search" type="search" className="input !pl-9" placeholder="Search merchant, notes, category…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} />
        </div>
        <div>
          <label htmlFor="f-cat" className="sr-only">Filter by category</label>
          <select id="f-cat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-acc" className="sr-only">Filter by account</label>
          <select id="f-acc" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {d.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-kind" className="sr-only">Filter by kind</label>
          <select id="f-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">{isIncome ? 'All income' : 'Essential & discretionary'}</option>
            {!isIncome && <option value="essential">Essential only</option>}
            {!isIncome && <option value="discretionary">Discretionary only</option>}
            <option value="recurring">Recurring only</option>
          </select>
        </div>
      </div>

      <Stat label={`Total ${label.toLowerCase()} (filtered)`} value={formatINR(total)} tone={isIncome ? 'pos' : undefined} sub={`${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`} />

      <div className="card px-4">
        {filtered.length === 0 ? (
          <div className="py-4">
            <EmptyState
              icon={<Receipt size={32} />}
              title={all.length === 0 ? `No ${type} recorded yet` : 'Nothing matches these filters'}
              text={all.length === 0 ? `Record your first ${type} to see it here.` : 'Try a wider date range or clear the search.'}
              action={all.length === 0 ? <button type="button" className="btn-primary" onClick={() => openTransaction({ type })}>Add {type}</button> : undefined}
            />
          </div>
        ) : (
          <>
            <TransactionList txs={filtered.slice(0, limit)} onEdit={(t) => openTransaction({ edit: t })} onDelete={onDelete} />
            {filtered.length > limit && (
              <div className="py-3 text-center"><button type="button" className="btn-secondary" onClick={() => setLimit(limit + PAGE)}>Show more ({filtered.length - limit} left)</button></div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
