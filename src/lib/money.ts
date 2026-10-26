import type { Paise } from '@/types'

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

/** Format integer paise as ₹1,23,456.78 */
export function formatINR(paise: Paise): string {
  return inr.format(paise / 100)
}

/** ₹1,23,457 (no decimals) - used in tight UI such as charts */
export function formatINRWhole(paise: Paise): string {
  return inrWhole.format(Math.round(paise / 100))
}

/** ₹1.2L / ₹3.4Cr / ₹12K compact form for chart axes */
export function formatINRCompact(paise: Paise): string {
  const r = Math.abs(paise) / 100
  const sign = paise < 0 ? '-' : ''
  if (r >= 1e7) return `${sign}₹${trim(r / 1e7)}Cr`
  if (r >= 1e5) return `${sign}₹${trim(r / 1e5)}L`
  if (r >= 1e3) return `${sign}₹${trim(r / 1e3)}K`
  return `${sign}₹${Math.round(r)}`
}
const trim = (n: number) => String(Math.round(n * 10) / 10)

/**
 * Parse a user-entered rupee amount ("1,234.5", "₹ 99", "12.34") to integer paise
 * using string arithmetic only (no float multiplication). Returns null when invalid.
 */
export function parseRupees(input: string | number | null | undefined): Paise | null {
  if (input === null || input === undefined) return null
  const s = String(input).replace(/[₹,\s]/g, '').replace(/^\+/, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(s) && !/^-?\.\d{1,2}$/.test(s)) return null
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [whole = '0', frac = ''] = body.split('.')
  const paise = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(paise)) return null
  return neg ? -paise : paise
}

/** Paise -> plain decimal string for form inputs / CSV ("1234.50"). */
export function paiseToInput(paise: Paise): string {
  const neg = paise < 0
  const abs = Math.abs(Math.round(paise))
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return neg ? `-${s}` : s
}

/** Percentage helper that guards divide-by-zero. */
export function pct(part: number, whole: number): number {
  if (!whole) return 0
  return (part / whole) * 100
}
