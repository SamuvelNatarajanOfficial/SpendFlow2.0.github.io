import type { Category, Settings } from '@/types'
import { DEFAULT_TZ } from '@/lib/dates'

type Seed = { name: string; kind: 'income' | 'expense'; color: string; essential?: boolean }

export const EMI_CATEGORY_NAME = 'EMI & Loans'

export const DEFAULT_CATEGORIES: Seed[] = [
  { name: 'Food & Dining', kind: 'expense', color: '#f97316' },
  { name: 'Groceries', kind: 'expense', color: '#22c55e', essential: true },
  { name: 'Rent', kind: 'expense', color: '#6366f1', essential: true },
  { name: 'Utilities', kind: 'expense', color: '#0ea5e9', essential: true },
  { name: 'Travel', kind: 'expense', color: '#14b8a6' },
  { name: 'Fuel', kind: 'expense', color: '#eab308', essential: true },
  { name: 'Shopping', kind: 'expense', color: '#ec4899' },
  { name: 'Healthcare', kind: 'expense', color: '#ef4444', essential: true },
  { name: 'Education', kind: 'expense', color: '#8b5cf6', essential: true },
  { name: 'Subscriptions', kind: 'expense', color: '#06b6d4' },
  { name: 'Family', kind: 'expense', color: '#f43f5e', essential: true },
  { name: EMI_CATEGORY_NAME, kind: 'expense', color: '#475569', essential: true },
  { name: 'Miscellaneous', kind: 'expense', color: '#94a3b8' },
  { name: 'Salary', kind: 'income', color: '#16a34a' },
  { name: 'Freelance', kind: 'income', color: '#0d9488' },
  { name: 'Bonus', kind: 'income', color: '#65a30d' },
  { name: 'Refund', kind: 'income', color: '#0284c7' },
  { name: 'Other income', kind: 'income', color: '#7c3aed' },
]

export const CATEGORY_COLORS = ['#f97316', '#22c55e', '#6366f1', '#0ea5e9', '#14b8a6', '#eab308', '#ec4899', '#ef4444', '#8b5cf6', '#06b6d4', '#f43f5e', '#475569', '#94a3b8', '#16a34a', '#0d9488', '#65a30d']

export function defaultSettings(): Settings {
  return { id: 'app', currency: 'INR', timezone: DEFAULT_TZ, theme: 'light', backupReminderDays: 7 }
}

/** Deterministic ids so a backup from one install merges cleanly into another (no duplicate "Groceries"). */
export const builtInCategoryId = (kind: string, name: string) => `cat-${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

export function seedCategories(now: string): Category[] {
  return DEFAULT_CATEGORIES.map((c) => ({ ...c, id: builtInCategoryId(c.kind, c.name), builtIn: true, createdAt: now, updatedAt: now }))
}
