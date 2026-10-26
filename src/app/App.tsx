import { lazy, Suspense, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, Link } from 'react-router-dom'
import { useRegisterSW } from 'virtual:pwa-register/react'
import {
  BarChart3, Home, LayoutGrid, Landmark, Lock, Moon, PiggyBank, Plus, Repeat, Settings as SettingsIcon, Sun, Target, TrendingDown, TrendingUp, Wallet, X,
} from 'lucide-react'
import clsx from 'clsx'
import { DataProvider, useData } from './data'
import { VaultGate } from './VaultGate'
import { AutoLock } from './AutoLock'
import { vault } from '@/vault/store'
import { UIProvider, useUI } from './ui-context'
import { ConfirmProvider, Notice, ToastProvider } from '@/components/ui'
import { updateSettings } from '@/db/repo'
import { diffDays, formatDate, todayIn } from '@/lib/dates'
const Dashboard = lazy(() => import('@/features/Dashboard'))
const TransactionsPage = lazy(() => import('@/features/TransactionsPage'))
const AccountsPage = lazy(() => import('@/features/AccountsPage'))
const BudgetsPage = lazy(() => import('@/features/BudgetsPage'))
const LoansPage = lazy(() => import('@/features/LoansPage'))
const LoanDetail = lazy(() => import('@/features/LoanDetail'))
const GoalsPage = lazy(() => import('@/features/GoalsPage'))
const ReportsPage = lazy(() => import('@/features/ReportsPage'))
const RecurringPage = lazy(() => import('@/features/RecurringPage'))
const SettingsPage = lazy(() => import('@/features/SettingsPage'))

const NAV = [
  { to: '/', label: 'Dashboard', icon: Home, end: true },
  { to: '/income', label: 'Income', icon: TrendingUp },
  { to: '/expenses', label: 'Expenses', icon: TrendingDown },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/loans', label: 'Loans & EMI', icon: Landmark },
  { to: '/goals', label: 'Goals', icon: Target },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]
const BOTTOM = ['/', '/expenses', '/budgets']

function ThemeToggle() {
  const { settings } = useData()
  const dark = settings.theme === 'dark'
  return (
    <button type="button" className="btn-ghost !px-2.5" onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}

function LockButton() {
  return (
    <button type="button" className="btn-ghost !px-2.5" onClick={() => void vault.lock()} aria-label="Lock SpendFlow" title="Lock now">
      <Lock size={18} />
    </button>
  )
}

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-9 w-9 rounded-xl" />
      <div className="leading-tight">
        <div className="text-base font-bold">SpendFlow <span className="text-brand">2.0</span></div>
        <div className="hidden text-[10px] text-subtle lg:block">Every rupee. Every goal. Under control.</div>
      </div>
    </Link>
  )
}

function Banners() {
  const { settings, transactions, loans, today } = useData()
  const hasData = transactions.length > 0 || loans.length > 0
  const last = settings.lastBackupAt
  const days = last ? diffDays(todayIn(settings.timezone, new Date(last)), today) : Infinity
  const dismissedToday = settings.dismissedBackupBannerAt && todayIn(settings.timezone, new Date(settings.dismissedBackupBannerAt)) === today
  const showBackup = hasData && days >= settings.backupReminderDays && !dismissedToday
  return (
    <div className="mb-4 space-y-2">
      {vault.integrityIssues > 0 && (
        <Notice tone="neg">
          {vault.integrityIssues} stored record(s) failed verification when unlocking (corrupted or modified) and were ignored. Restore from an encrypted backup if data looks missing.
        </Notice>
      )}
      {settings.sampleLoaded && (
        <Notice tone="warn" action={<Link className="btn-secondary !min-h-[34px]" to="/settings#data">Manage sample data</Link>}>
          You're viewing <strong>sample data</strong>. It is flagged and can be removed in Settings without touching your own records.
        </Notice>
      )}
      {showBackup && (
        <Notice
          tone="warn"
          action={
            <span className="flex gap-2">
              <Link className="btn-primary !min-h-[34px]" to="/settings#data">Back up now</Link>
              <button type="button" className="btn-ghost !min-h-[34px]" onClick={() => updateSettings({ dismissedBackupBannerAt: new Date().toISOString() })}>Later</button>
            </span>
          }
        >
          {last ? <>Your last backup was on <strong>{formatDate(todayIn(settings.timezone, new Date(last)))}</strong> ({days} days ago).</> : <>You haven't backed up yet.</>} Data lives only in this browser, so download a backup regularly.
        </Notice>
      )}
    </div>
  )
}

function PwaPrompt() {
  const { needRefresh: [needRefresh, setNeedRefresh], offlineReady: [offlineReady, setOfflineReady], updateServiceWorker } = useRegisterSW()
  if (!needRefresh && !offlineReady) return null
  return (
    <div className="fixed inset-x-3 bottom-24 z-[90] mx-auto max-w-md rounded-2xl border border-line bg-card p-4 shadow-2xl md:bottom-6" role="alertdialog" aria-label="App update">
      <p className="text-sm font-semibold">{needRefresh ? 'A new version is ready' : 'SpendFlow can now work offline'}</p>
      {needRefresh && <p className="mt-1 text-xs text-subtle">Your data is stored separately and is not affected. Finish anything you're typing, then update.</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-secondary !min-h-[36px]" onClick={() => { setNeedRefresh(false); setOfflineReady(false) }}>{needRefresh ? 'Later' : 'OK'}</button>
        {needRefresh && <button type="button" className="btn-primary !min-h-[36px]" onClick={() => updateServiceWorker(true)}>Update now</button>}
      </div>
    </div>
  )
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] md:hidden" role="dialog" aria-label="More navigation">
      <button type="button" className="absolute inset-0 bg-black/50" aria-label="Close menu" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-line bg-card p-4 pb-24">
        <div className="mb-2 flex items-center justify-between">
          <p className="font-bold">More</p>
          <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {NAV.filter((n) => !BOTTOM.includes(n.to)).map((n) => (
            <NavLink key={n.to} to={n.to} onClick={onClose} className={({ isActive }) => clsx('flex flex-col items-center gap-1 rounded-xl p-3 text-xs font-semibold', isActive ? 'bg-brand/15 text-brand' : 'bg-muted text-fg')}>
              <n.icon size={20} />
              {n.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  )
}

function Shell() {
  const { openTransaction } = useUI()
  const [more, setMore] = useState(false)
  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:rounded-lg focus:bg-card focus:p-3">Skip to content</a>
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-card p-4 md:flex" aria-label="Primary">
        <Logo />
        <button type="button" className="btn-primary mt-5" onClick={() => openTransaction()}><Plus size={18} /> Add transaction</button>
        <nav className="mt-5 flex flex-1 flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx('flex min-h-[40px] items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors', isActive ? 'bg-navy text-white dark:bg-brand/15 dark:text-brand' : 'text-subtle hover:bg-muted hover:text-fg')}>
              <n.icon size={18} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between text-xs text-subtle">
          <span>Encrypted · INR</span>
          <span className="flex"><LockButton /><ThemeToggle /></span>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur md:hidden">
          <Logo />
          <span className="flex"><LockButton /><ThemeToggle /></span>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
          <Banners />
          <Suspense fallback={<div className="py-20 text-center text-subtle" role="status">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/income" element={<TransactionsPage type="income" />} />
            <Route path="/expenses" element={<TransactionsPage type="expense" />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/budgets" element={<BudgetsPage />} />
            <Route path="/recurring" element={<RecurringPage />} />
            <Route path="/loans" element={<LoansPage />} />
            <Route path="/loans/:id" element={<LoanDetail />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>

      {/* mobile bottom nav with centre add button */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Mobile">
        <div className="mx-auto grid max-w-md grid-cols-5 items-end">
          {NAV.filter((n) => BOTTOM.slice(0, 2).includes(n.to)).map((n) => <BottomLink key={n.to} n={n} />)}
          <div className="flex justify-center">
            <button type="button" onClick={() => openTransaction()} className="-mt-5 grid h-14 w-14 place-items-center rounded-full bg-brand text-brand-fg shadow-lg ring-4 ring-bg focus-visible:outline-none focus-visible:ring-brand" aria-label="Add transaction">
              <Plus size={26} />
            </button>
          </div>
          {NAV.filter((n) => n.to === BOTTOM[2]).map((n) => <BottomLink key={n.to} n={n} />)}
          <button type="button" onClick={() => setMore(true)} className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-subtle" aria-label="More">
            <LayoutGrid size={20} />
            More
          </button>
        </div>
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} />}
      <PwaPrompt />
      <AutoLock />
    </div>
  )
}

function BottomLink({ n }: { n: (typeof NAV)[number] }) {
  return (
    <NavLink to={n.to} end={n.end} className={({ isActive }) => clsx('flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', isActive ? 'text-brand' : 'text-subtle')}>
      <n.icon size={20} />
      {n.label.split(' ')[0]}
    </NavLink>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <VaultGate>
          <DataProvider>
            <HashRouter>
              <UIProvider>
                <Shell />
              </UIProvider>
            </HashRouter>
          </DataProvider>
        </VaultGate>
      </ConfirmProvider>
    </ToastProvider>
  )
}
