import { describe, expect, it } from 'vitest'
import { formatINR, formatINRCompact, paiseToInput, parseRupees } from './money'
import { addMonths, diffDays, formatDate, isValidDate, monthsInRange, rangeFor, todayIn } from './dates'

describe('money', () => {
  it('parses rupee strings to integer paise without float error', () => {
    expect(parseRupees('1,234.50')).toBe(123450)
    expect(parseRupees('₹ 99')).toBe(9900)
    expect(parseRupees('0.1')).toBe(10)
    expect(parseRupees('19.99')).toBe(1999)
    expect(parseRupees('1.005')).toBeNull() // more than 2 decimals rejected, not silently rounded
    expect(parseRupees('abc')).toBeNull()
    expect(parseRupees('')).toBeNull()
    expect(parseRupees('-5')).toBe(-500)
  })
  it('0.1 + 0.2 style sums are exact in paise', () => {
    expect((parseRupees('0.1') ?? 0) + (parseRupees('0.2') ?? 0)).toBe(parseRupees('0.3'))
  })
  it('formats with Indian digit grouping', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78')
    expect(formatINR(0)).toBe('₹0.00')
    expect(formatINRCompact(15000000)).toBe('₹1.5L')
    expect(formatINRCompact(250000000)).toBe('₹25L')
    expect(paiseToInput(123405)).toBe('1234.05')
    expect(paiseToInput(-5)).toBe('-0.05')
  })
})

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2024-02-29')).toBe(true)
    expect(isValidDate('2025-02-29')).toBe(false)
    expect(isValidDate('2025-13-01')).toBe(false)
    expect(isValidDate('2025-1-1')).toBe(false)
    expect(isValidDate(null)).toBe(false)
  })
  it('addMonths clamps to month end', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2025-12-15', 2)).toBe('2026-02-15')
    expect(addMonths('2025-03-15', -3)).toBe('2024-12-15')
  })
  it('computes today in Asia/Kolkata (UTC+5:30)', () => {
    // 20:00 UTC on Jan 31 is already Feb 1 in IST
    expect(todayIn('Asia/Kolkata', new Date('2025-01-31T20:00:00Z'))).toBe('2025-02-01')
    expect(todayIn('UTC', new Date('2025-01-31T20:00:00Z'))).toBe('2025-01-31')
  })
  it('builds range presets', () => {
    expect(rangeFor('this-month', '2025-03-15')).toEqual({ from: '2025-03-01', to: '2025-03-31' })
    expect(rangeFor('last-month', '2025-01-10')).toEqual({ from: '2024-12-01', to: '2024-12-31' })
    expect(rangeFor('this-year', '2025-06-10')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(rangeFor('custom', '2025-06-10', { from: '2025-05-20', to: '2025-05-01' })).toEqual({ from: '2025-05-01', to: '2025-05-20' })
    expect(rangeFor('custom', '2025-06-10', { from: 'bad', to: '2025-06-30' })).toEqual({ from: '2025-06-01', to: '2025-06-30' })
  })
  it('lists months in a range and diffs days', () => {
    expect(monthsInRange({ from: '2025-11-20', to: '2026-02-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(diffDays('2025-02-28', '2025-03-01')).toBe(1)
    expect(formatDate('2025-03-01')).toMatch(/01 Mar 2025/)
  })
})
