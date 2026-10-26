import { useState } from 'react'
import { useData } from '@/app/data'
import { useConfirm, useToast } from './ui'
import { recurring } from '@/db/repo'
import { formatDate } from '@/lib/dates'
import { formatINR } from '@/lib/money'
import type { RecurringSeries } from '@/lib/calc/ledger'

/** Record-next / stop handlers shared by the Recurring page and the Dashboard. `busy` prevents double-clicks. */
export function useRecurringActions() {
  const { today } = useData()
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)

  const record = async (s: RecurringSeries) => {
    if (busy) return
    setBusy(s.key)
    try {
      const tx = await recurring.recordNext(s.sourceId, today)
      toast(`${s.type === 'income' ? 'Income' : 'Expense'} recorded: ${s.title} ${formatINR(tx.amount)} on ${formatDate(tx.date)}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record', 'error')
    } finally {
      setBusy(null)
    }
  }

  const stop = async (s: RecurringSeries) => {
    const ok = await confirm({
      title: 'Stop this recurring item?',
      confirmLabel: 'Stop recurring',
      message: <>"{s.title}" ({formatINR(s.amount)}, {s.frequency}) will no longer appear as upcoming. Your {s.count} existing transaction(s) and balances are <strong>not</strong> changed.</>,
    })
    if (!ok) return
    await recurring.stop(s.sourceId)
    toast('Recurring stopped')
  }

  return { record, stop, busy }
}
