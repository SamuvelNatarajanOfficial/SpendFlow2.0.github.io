import { ArrowLeftRight, Landmark, Pencil, Repeat, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useData } from '@/app/data'
import { formatDate } from '@/lib/dates'
import { formatINR } from '@/lib/money'
import { Badge } from './ui'
import type { Transaction } from '@/types'

export function describeTx(t: Transaction, catName?: string): string {
  return t.merchant || t.notes || catName || (t.type === 'transfer' ? 'Transfer' : 'Transaction')
}

export function TransactionList({ txs, onEdit, onDelete, compact }: { txs: Transaction[]; onEdit?: (t: Transaction) => void; onDelete?: (t: Transaction) => void; compact?: boolean }) {
  const { catMap, accMap } = useData()
  return (
    <ul className="divide-y divide-line" aria-label="Transactions">
      {txs.map((t) => {
        const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
        const title = describeTx(t, cat?.name)
        const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : ''
        const isLoan = !!t.loanPaymentId
        return (
          <li key={t.id} className="flex items-center gap-3 py-3" data-testid="tx-row">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style={{ background: t.type === 'transfer' ? '#64748b' : (cat?.color ?? '#94a3b8') }} aria-hidden>
              {t.type === 'transfer' ? <ArrowLeftRight size={18} /> : isLoan ? <Landmark size={18} /> : <span className="text-sm font-bold">{(cat?.name ?? '?').charAt(0)}</span>}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{title}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
                <span>{formatDate(t.date)}</span>
                <span>·</span>
                <span className="truncate">
                  {t.type === 'transfer' ? `${accMap.get(t.accountId)?.name ?? '?'} → ${accMap.get(t.toAccountId ?? '')?.name ?? '?'}` : `${cat?.name ?? 'Uncategorised'} · ${accMap.get(t.accountId)?.name ?? '?'}`}
                </span>
                {t.recurring && <Repeat size={12} aria-label={`Repeats ${t.recurring}`} />}
                {t.type === 'expense' && !compact && <Badge tone={t.essential ? 'muted' : 'warn'}>{t.essential ? 'Essential' : 'Discretionary'}</Badge>}
                {isLoan && <Badge>Loan payment</Badge>}
                {t.isSample && <Badge tone="warn">Sample</Badge>}
              </p>
            </div>
            <p className={clsx('num shrink-0 text-sm font-bold', t.type === 'income' && 'text-pos', t.type === 'expense' && 'text-fg')}>
              {sign}{formatINR(t.amount)}
            </p>
            {(onEdit || onDelete) && !isLoan && (
              <div className="flex shrink-0">
                {onEdit && (
                  <button type="button" className="btn-ghost !min-h-[36px] !px-2" onClick={() => onEdit(t)} aria-label={`Edit ${title}`}>
                    <Pencil size={16} />
                  </button>
                )}
                {onDelete && (
                  <button type="button" className="btn-ghost !min-h-[36px] !px-2 hover:!text-neg" onClick={() => onDelete(t)} aria-label={`Delete ${title}`}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
