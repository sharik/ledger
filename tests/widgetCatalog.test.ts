import { describe, expect, it } from 'vitest'
import { WIDGETS, WIDGET_IDS, isWidgetId, paramKey, widgetParams, widgetsByScreen } from '../src/ui/widgets/catalog'

describe('widget catalogue', () => {
  it('every entry names a screen, a title and a blurb', () => {
    expect(WIDGET_IDS.length).toBeGreaterThan(0)
    for (const id of WIDGET_IDS) {
      const w = WIDGETS[id]
      expect(w.title, id).toBeTruthy()
      expect(w.blurb, id).toBeTruthy()
      expect([1, 2, 3], id).toContain(w.defaultSpan)
    }
  })

  it('ids are screen-prefixed, matching the EXPLAIN convention', () => {
    for (const id of WIDGET_IDS) expect(id, id).toMatch(/^[a-z]+\.[a-z-]+$/)
  })

  it('recognises its own ids and nothing else', () => {
    expect(isWidgetId('accounts.net-worth')).toBe(true)
    // A pin written by a newer peer must be rejectable rather than rendered blank.
    expect(isWidgetId('accounts.invented-later')).toBe(false)
  })

  it('groups every widget under exactly one screen', () => {
    const grouped = widgetsByScreen().flatMap(([, ids]) => ids)
    expect(grouped.sort()).toEqual([...WIDGET_IDS].sort())
  })
})

describe('widgetParams', () => {
  it('fills in defaults a pin was saved without', () => {
    // The case that matters: a widget grows a control, and the pins already stored predate it.
    expect(widgetParams('trends.monthly', { monthMode: 'cat' })).toEqual({
      monthMode: 'cat',
      monthWindow: '18M',
      rollOn: true,
      hiddenCats: [],
    })
  })

  it('a pin with nothing stored renders at the catalogue defaults', () => {
    expect(widgetParams('accounts.net-worth', undefined)).toEqual({ range: '1y' })
  })
})

describe('paramKey', () => {
  it('is insensitive to key order, so both sides of a pin check agree', () => {
    expect(paramKey({ a: 1, b: 'x' })).toBe(paramKey({ b: 'x', a: 1 }))
  })

  it('still tells different views of the same chart apart', () => {
    expect(paramKey({ range: '1y' })).not.toBe(paramKey({ range: 'all' }))
    expect(paramKey({ hiddenCats: ['a'] })).not.toBe(paramKey({ hiddenCats: [] }))
  })
})
