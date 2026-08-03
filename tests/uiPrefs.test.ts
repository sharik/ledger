import { describe, expect, it } from 'vitest'
import { candidateKey, dismiss, dismissCandidate, isCandidateDismissed, isDismissed, resetIntros, type HelpPrefs } from '../src/ui/uiPrefs'

describe('help preferences', () => {
  it('starts with nothing dismissed', () => {
    expect(isDismissed({}, 'dash')).toBe(false)
  })

  it('dismisses one screen without touching the others', () => {
    const p = dismiss({}, 'dash')
    expect(isDismissed(p, 'dash')).toBe(true)
    expect(isDismissed(p, 'compare')).toBe(false)
  })

  it('is idempotent — dismissing twice does not duplicate', () => {
    const p = dismiss(dismiss({}, 'dash'), 'dash')
    expect(p.introDismissed).toEqual(['dash'])
  })

  it('does not mutate the input', () => {
    const before: HelpPrefs = { introDismissed: ['dash'] }
    dismiss(before, 'plan')
    expect(before.introDismissed).toEqual(['dash'])
  })

  it('reset brings every intro back', () => {
    const p = resetIntros(dismiss(dismiss({}, 'dash'), 'plan'))
    expect(isDismissed(p, 'dash')).toBe(false)
    expect(isDismissed(p, 'plan')).toBe(false)
  })
})

describe('dismissed trip candidates', () => {
  const c = { dateFrom: '2022-10-31', dateTo: '2022-12-17', currency: 'EUR' }

  it('starts undismissed and remembers a rejection', () => {
    expect(isCandidateDismissed({}, candidateKey(c))).toBe(false)
    const p = dismissCandidate({}, candidateKey(c))
    expect(isCandidateDismissed(p, candidateKey(c))).toBe(true)
  })

  it('is idempotent and does not mutate the input', () => {
    const once = dismissCandidate({}, candidateKey(c))
    const twice = dismissCandidate(once, candidateKey(c))
    expect(twice.dismissedTripCandidates).toEqual([candidateKey(c)])
    const before: HelpPrefs = { dismissedTripCandidates: ['x'] }
    dismissCandidate(before, candidateKey(c))
    expect(before.dismissedTripCandidates).toEqual(['x'])
  })

  it('keys on the window, so a different window is a different candidate', () => {
    const p = dismissCandidate({}, candidateKey(c))
    expect(isCandidateDismissed(p, candidateKey({ ...c, dateTo: '2022-12-18' }))).toBe(false)
  })

  it('is independent of the intro dismissals', () => {
    const p = dismissCandidate(dismiss({}, 'trips'), candidateKey(c))
    expect(isDismissed(p, 'trips')).toBe(true)
    expect(isCandidateDismissed(p, candidateKey(c))).toBe(true)
  })
})
