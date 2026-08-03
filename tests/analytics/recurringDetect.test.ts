import { describe, it, expect } from 'vitest'
import { detectRecurring, type RecurringTxn } from '../../src/analytics/recurringDetect'

let n = 0
const t = (date: string, merchant: string, amount: number): RecurringTxn => ({ id: `t${n++}`, date, merchant, amount })

describe('detectRecurring (#12b)', () => {
  it('flags a clean monthly series as monthly', () => {
    const txns = [
      t('2026-01-03', 'Netflix', -13.99),
      t('2026-02-03', 'Netflix', -13.99),
      t('2026-03-03', 'Netflix', -13.99),
      t('2026-04-03', 'Netflix', -13.99),
    ]
    const [c] = detectRecurring(txns)
    expect(c!.cadence).toBe('monthly')
    expect(c!.count).toBe(4)
    expect(c!.typicalAmount).toBe(13.99)
  })

  it('flags a yearly series as yearly', () => {
    const txns = [
      t('2024-06-10', 'Domain Registrar', -22),
      t('2025-06-11', 'Domain Registrar', -22),
      t('2026-06-10', 'Domain Registrar', -22),
    ]
    const [c] = detectRecurring(txns)
    expect(c!.cadence).toBe('yearly')
    expect(c!.count).toBe(3)
  })

  it('ignores a one-off and an irregular series', () => {
    const oneOff = [t('2026-01-03', 'Ikea', -240)]
    expect(detectRecurring(oneOff)).toEqual([])

    const irregular = [
      t('2026-01-03', 'Corner Shop', -12),
      t('2026-01-19', 'Corner Shop', -40),
      t('2026-03-25', 'Corner Shop', -8),
    ]
    expect(detectRecurring(irregular)).toEqual([]) // gaps not a cadence, amounts swing
  })

  it('ignores a series whose amount swings beyond tolerance', () => {
    const txns = [
      t('2026-01-03', 'Electric Co', -40),
      t('2026-02-03', 'Electric Co', -95),
      t('2026-03-03', 'Electric Co', -60),
    ]
    expect(detectRecurring(txns)).toEqual([]) // monthly cadence but not a fixed amount
  })

  it('groups merchants past a trailing reference token', () => {
    const txns = [
      t('2026-01-03', 'SPOTIFY #A1', -10.99),
      t('2026-02-03', 'SPOTIFY #B2', -10.99),
      t('2026-03-03', 'SPOTIFY #C3', -10.99),
    ]
    const [c] = detectRecurring(txns)
    expect(c!.cadence).toBe('monthly')
    expect(c!.count).toBe(3)
  })

  it('never treats income/refunds as recurring', () => {
    const txns = [
      t('2026-01-25', 'Employer', 3000),
      t('2026-02-25', 'Employer', 3000),
      t('2026-03-25', 'Employer', 3000),
    ]
    expect(detectRecurring(txns)).toEqual([])
  })
})
