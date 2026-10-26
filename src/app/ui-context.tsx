import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { TransactionModal } from '@/components/TransactionForm'
import type { Transaction, TxType } from '@/types'

interface UI {
  openTransaction: (o?: { type?: TxType; edit?: Transaction }) => void
}
const Ctx = createContext<UI>({ openTransaction: () => undefined })
export const useUI = () => useContext(Ctx)

/** Hosts the single global add/edit transaction dialog so any page can open it. */
export function UIProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ type?: TxType; edit?: Transaction } | null>(null)
  const openTransaction = useCallback((o: { type?: TxType; edit?: Transaction } = {}) => setState(o), [])
  return (
    <Ctx.Provider value={{ openTransaction }}>
      {children}
      <TransactionModal open={!!state} onClose={() => setState(null)} edit={state?.edit} type={state?.type} />
    </Ctx.Provider>
  )
}
