import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { ensureSeed } from '@/db/repo'
import { defaultSettings } from '@/db/defaults'
import { todayIn } from '@/lib/dates'
import type { Account, Budget, Category, Goal, Loan, LoanPayment, Settings, Transaction } from '@/types'

export interface AppData {
  accounts: Account[]
  transactions: Transaction[]
  categories: Category[]
  budgets: Budget[]
  loans: Loan[]
  loanPayments: LoanPayment[]
  goals: Goal[]
  settings: Settings
  today: string
  accMap: Map<string, Account>
  catMap: Map<string, Category>
}

const Ctx = createContext<AppData | null>(null)

export function useData(): AppData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useData outside DataProvider')
  return v
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [seeded, setSeeded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ensureSeed().then(() => setSeeded(true), (e) => setError(String(e?.message ?? e)))
    // Ask the browser not to evict our data under storage pressure (best effort).
    navigator.storage?.persist?.().catch(() => undefined)
  }, [])

  const raw = useLiveQuery(async () => {
    if (!seeded) return undefined
    const [accounts, transactions, categories, budgets, loans, loanPayments, goals, settings] = await Promise.all([
      db.accounts.toArray(), db.transactions.toArray(), db.categories.toArray(), db.budgets.toArray(),
      db.loans.toArray(), db.loanPayments.toArray(), db.goals.toArray(), db.settings.get('app'),
    ])
    return { accounts, transactions, categories, budgets, loans, loanPayments, goals, settings: settings ?? defaultSettings() }
  }, [seeded])

  // re-evaluate "today" when the tab regains focus (handles an app left open past midnight)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const f = () => setTick((t) => t + 1)
    window.addEventListener('focus', f)
    document.addEventListener('visibilitychange', f)
    return () => {
      window.removeEventListener('focus', f)
      document.removeEventListener('visibilitychange', f)
    }
  }, [])

  const value = useMemo<AppData | null>(() => {
    if (!raw) return null
    return {
      ...raw,
      today: todayIn(raw.settings.timezone),
      accMap: new Map(raw.accounts.map((a) => [a.id, a])),
      catMap: new Map(raw.categories.map((c) => [c.id, c])),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, tick])

  useEffect(() => {
    if (!value) return
    const t = value.settings.theme
    document.documentElement.setAttribute('data-theme', t)
    try {
      localStorage.setItem('sf-theme', t)
    } catch {
      /* storage unavailable */
    }
  }, [value])

  if (error) {
    return (
      <div role="alert" className="mx-auto mt-20 max-w-md p-6 text-center">
        <h1 className="text-xl font-bold">Storage is unavailable</h1>
        <p className="mt-2 text-sm text-subtle">
          SpendFlow could not open the browser database ({error}). Private/incognito windows and some browser settings block IndexedDB. Open the app in a regular window and allow site data.
        </p>
      </div>
    )
  }
  if (!value) return <div className="grid min-h-screen place-items-center text-subtle" role="status">Loading your data…</div>
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
