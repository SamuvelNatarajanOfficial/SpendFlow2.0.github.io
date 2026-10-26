import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { vault } from '@/vault/store'
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

/**
 * Exposes the DECRYPTED in-memory records to the UI. Must only be rendered while the vault is unlocked
 * (VaultGate guarantees this). It re-renders whenever the vault changes and renders nothing the moment it locks.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const version = useSyncExternalStore(vault.subscribe, vault.getVersion)

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
    if (!vault.isUnlocked()) return null
    const s = vault.snapshot()
    const settings = s.settings.find((x) => x.id === 'app') ?? defaultSettings()
    return {
      accounts: s.accounts, transactions: s.transactions, categories: s.categories, budgets: s.budgets, loans: s.loans, loanPayments: s.loanPayments, goals: s.goals,
      settings,
      today: todayIn(settings.timezone),
      accMap: new Map(s.accounts.map((a) => [a.id, a])),
      catMap: new Map(s.categories.map((c) => [c.id, c])),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick])

  useEffect(() => {
    if (!value) return
    const t = value.settings.theme
    document.documentElement.setAttribute('data-theme', t)
    try {
      // theme is a non-sensitive UI preference, kept outside the vault so the lock screen can match it
      localStorage.setItem('sf-theme', t)
    } catch {
      /* storage unavailable */
    }
  }, [value])

  if (!value) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
