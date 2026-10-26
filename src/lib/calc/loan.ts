import type { ISODate, Loan, LoanPayment, Paise } from '@/types'
import { addMonths, makeDate, monthOf, parts } from '../dates'

/**
 * ASSUMPTIONS (also documented in the README and the Loans UI):
 *  - Fixed-rate, reducing-balance loan; monthly compounding at annualRate / 12.
 *  - Interest for a month = outstanding principal x annualRate / 1200, rounded to the nearest paisa.
 *  - Each EMI first pays that month's interest; the remainder reduces principal.
 *  - Real lenders may use day-count conventions, moratoriums, processing fees or rate resets;
 *    the schedule is therefore an ESTIMATE. Correct the outstanding balance manually
 *    whenever your lender statement differs.
 */

export const monthlyRate = (annualRatePct: number) => annualRatePct / 1200

/** Standard EMI formula: P*r*(1+r)^n / ((1+r)^n - 1). Zero-rate loans split evenly. */
export function calcEmi(principal: Paise, annualRatePct: number, months: number): Paise {
  if (principal <= 0 || months <= 0) return 0
  const r = monthlyRate(annualRatePct)
  if (r === 0) return Math.round(principal / months)
  const f = Math.pow(1 + r, months)
  return Math.round((principal * r * f) / (f - 1))
}

export function monthlyInterest(outstanding: Paise, annualRatePct: number): Paise {
  return Math.round(outstanding * monthlyRate(annualRatePct))
}

/** Split a payment into interest and principal. EMI: interest first. Prepayment: all principal. */
export function splitPayment(
  outstanding: Paise,
  annualRatePct: number,
  amount: Paise,
  kind: 'emi' | 'prepayment',
  interestOverride?: Paise,
): { interest: Paise; principal: Paise } {
  if (kind === 'prepayment') return { interest: 0, principal: Math.min(amount, Math.max(outstanding, 0)) }
  const due = Math.min(interestOverride ?? monthlyInterest(Math.max(outstanding, 0), annualRatePct), amount)
  const principal = Math.min(amount - due, Math.max(outstanding, 0))
  // Invariant: interest + principal === amount. Anything beyond outstanding principal is booked as interest/charges.
  return { interest: amount - principal, principal }
}

export interface ScheduleRow {
  n: number
  date: ISODate
  opening: Paise
  interest: Paise
  principal: Paise
  extra: Paise
  payment: Paise
  closing: Paise
}

export interface ScheduleOptions {
  extraMonthly?: Paise
  lumpSum?: Paise // applied against principal at the first instalment
  maxMonths?: number
}

export interface ScheduleResult {
  rows: ScheduleRow[]
  totalInterest: Paise
  totalPaid: Paise
  months: number
  /** true when EMI does not even cover the interest, so the loan never amortises */
  neverPaysOff: boolean
  payoffDate?: ISODate
}

/** Next instalment date after `from` on the loan's due day (clamped to month length). */
export function firstInstalmentDate(from: ISODate, dueDay: number): ISODate {
  const { y, m } = parts(from)
  const cand = makeDate(y, m, dueDay)
  return cand > from ? cand : makeDate(...nextYm(y, m), dueDay)
}
const nextYm = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1])

export function buildSchedule(
  outstanding: Paise,
  annualRatePct: number,
  emi: Paise,
  startAfter: ISODate,
  dueDay: number,
  opts: ScheduleOptions = {},
): ScheduleResult {
  const cap = opts.maxMonths ?? 600
  const rows: ScheduleRow[] = []
  let bal = Math.max(0, outstanding)
  let totalInterest = 0, totalPaid = 0
  const extraMonthly = opts.extraMonthly ?? 0
  let date = firstInstalmentDate(startAfter, dueDay)
  let neverPaysOff = false

  if (bal > 0 && emi + extraMonthly <= monthlyInterest(bal, annualRatePct) && annualRatePct > 0) neverPaysOff = true

  let lump = opts.lumpSum ?? 0
  while (bal > 0 && rows.length < cap && !(neverPaysOff && rows.length >= 12)) {
    const opening = bal
    let extra = extraMonthly
    if (lump > 0) {
      extra += lump
      lump = 0
    }
    const interest = monthlyInterest(bal, annualRatePct)
    let principal = Math.max(0, emi - interest)
    let payment = emi
    if (principal + extra >= bal) {
      // final instalment
      principal = Math.min(principal, bal)
      extra = bal - principal
      payment = interest + principal
    }
    bal = bal - principal - extra
    rows.push({ n: rows.length + 1, date, opening, interest, principal, extra, payment: payment + extra, closing: bal })
    totalInterest += interest
    totalPaid += payment + extra
    date = addMonths(date, 1)
    // addMonths preserves a clamped day; restore the configured due day
    date = makeDate(parts(date).y, parts(date).m, dueDay)
  }
  const done = bal === 0 && rows.length > 0
  return {
    rows,
    totalInterest,
    totalPaid,
    months: rows.length,
    neverPaysOff: neverPaysOff && !done,
    payoffDate: done ? rows[rows.length - 1]!.date : undefined,
  }
}

export interface PlanComparison {
  baseline: ScheduleResult
  plan: ScheduleResult
  monthsSaved: number
  interestSaved: Paise
}

export function comparePlans(loan: Loan, today: ISODate, opts: ScheduleOptions): PlanComparison {
  const baseline = buildSchedule(loan.outstanding, loan.annualRate, loan.emi, today, loan.dueDay)
  const plan = buildSchedule(loan.outstanding, loan.annualRate, loan.emi, today, loan.dueDay, opts)
  return {
    baseline,
    plan,
    monthsSaved: Math.max(0, baseline.months - plan.months),
    interestSaved: Math.max(0, baseline.totalInterest - plan.totalInterest),
  }
}

export function expectedEndDate(loan: Pick<Loan, 'startDate' | 'tenureMonths'>): ISODate {
  return addMonths(loan.startDate, loan.tenureMonths)
}

/** Next unpaid EMI due date. An EMI payment recorded in the due month counts as paying that month's EMI. */
export function nextEmiDue(loan: Loan, payments: LoanPayment[], today: ISODate): { dueDate: ISODate; overdue: boolean } | null {
  if (loan.outstanding <= 0) return null
  const { y, m } = parts(today)
  const thisMonth = makeDate(y, m, loan.dueDay)
  const paidThisMonth = payments.some((p) => p.loanId === loan.id && p.kind === 'emi' && monthOf(p.date) === monthOf(today))
  if (!paidThisMonth) return { dueDate: thisMonth, overdue: thisMonth < today }
  return { dueDate: makeDate(...nextYm(y, m), loan.dueDay), overdue: false }
}

/** Outstanding principal at the END of `date`, reconstructed from payment history (valid while no manual corrections were made after `date`). */
export function balanceAt(loan: Loan, payments: LoanPayment[], date: ISODate): Paise {
  const after = payments.filter((p) => p.loanId === loan.id && p.date > date).reduce((s, p) => s + p.principal, 0)
  return Math.min(loan.principal, loan.outstanding + after)
}

export interface LoanSummary {
  totalOutstanding: Paise
  totalPrincipal: Paise
  monthlyCommitment: Paise
  repaid: Paise
}

export function summariseLoans(loans: Loan[]): LoanSummary {
  const active = loans.filter((l) => l.outstanding > 0)
  const totalPrincipal = loans.reduce((s, l) => s + l.principal, 0)
  const totalOutstanding = loans.reduce((s, l) => s + Math.max(0, l.outstanding), 0)
  return {
    totalOutstanding,
    totalPrincipal,
    monthlyCommitment: active.reduce((s, l) => s + l.emi, 0),
    repaid: Math.max(0, totalPrincipal - totalOutstanding),
  }
}
