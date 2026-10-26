import type { DateRange, ISODate } from '@/types'

export const DEFAULT_TZ = 'Asia/Kolkata'

const RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Strict calendar validation: rejects 2025-02-30 etc. */
export function isValidDate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false
  const m = RE.exec(s)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false
  return d <= daysInMonth(y, mo)
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

/** Today's calendar date in the given IANA timezone. */
export function todayIn(tz: string = DEFAULT_TZ, now: Date = new Date()): ISODate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    if (RE.test(parts)) return parts
  } catch {
    /* fall through */
  }
  return now.toISOString().slice(0, 10)
}

export const monthOf = (d: ISODate): string => d.slice(0, 7)

export function parts(d: ISODate): { y: number; m: number; d: number } {
  return { y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8, 10) }
}

export function makeDate(y: number, m1: number, d: number): ISODate {
  const dd = Math.min(d, daysInMonth(y, m1))
  return `${String(y).padStart(4, '0')}-${String(m1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** Add months keeping the day where possible (clamped to month length). */
export function addMonths(d: ISODate, n: number): ISODate {
  const { y, m, d: day } = parts(d)
  const idx = y * 12 + (m - 1) + n
  return makeDate(Math.floor(idx / 12), (idx % 12 + 12) % 12 + 1, day)
}

export function addDays(d: ISODate, n: number): ISODate {
  const { y, m, d: day } = parts(d)
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10)
}

export function addMonthKey(month: string, n: number): string {
  return addMonths(`${month}-01`, n).slice(0, 7)
}

export function monthStart(month: string): ISODate {
  return `${month}-01`
}
export function monthEnd(month: string): ISODate {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  return makeDate(y, m, daysInMonth(y, m))
}

export function diffDays(a: ISODate, b: ISODate): number {
  const pa = parts(a), pb = parts(b)
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000)
}

export const inRange = (d: ISODate, r: DateRange): boolean => d >= r.from && d <= r.to

export type RangePreset = 'this-month' | 'last-month' | 'this-year' | 'custom'

export function rangeFor(preset: RangePreset, today: ISODate, custom?: Partial<DateRange>): DateRange {
  const m = monthOf(today)
  switch (preset) {
    case 'this-month':
      return { from: monthStart(m), to: monthEnd(m) }
    case 'last-month': {
      const lm = addMonthKey(m, -1)
      return { from: monthStart(lm), to: monthEnd(lm) }
    }
    case 'this-year': {
      const y = today.slice(0, 4)
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    }
    case 'custom': {
      const from = custom?.from && isValidDate(custom.from) ? custom.from : monthStart(m)
      const to = custom?.to && isValidDate(custom.to) ? custom.to : monthEnd(m)
      return from <= to ? { from, to } : { from: to, to: from }
    }
  }
}

/** Months (YYYY-MM) that intersect a range, inclusive. */
export function monthsInRange(r: DateRange): string[] {
  const out: string[] = []
  let cur = monthOf(r.from)
  const end = monthOf(r.to)
  while (cur <= end && out.length < 600) {
    out.push(cur)
    cur = addMonthKey(cur, 1)
  }
  return out
}

export function formatDate(d: ISODate): string {
  if (!isValidDate(d)) return d
  const { y, m, d: day } = parts(d)
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function formatMonth(month: string): string {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function formatDateTime(ts: string, tz: string = DEFAULT_TZ): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  try {
    return d.toLocaleString('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d.toLocaleString('en-IN')
  }
}
