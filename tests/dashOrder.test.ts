import { describe, expect, it } from 'vitest'
import { applyOrder, applyOrderAnchored, clampSpan, migrateTiles, moveId, packRows, rowTracks, type Span } from '../src/ui/dashOrder'

describe('applyOrder', () => {
  it('keeps the saved relative order', () => {
    expect(applyOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('drops stale ids and appends new ones in default position', () => {
    expect(applyOrder(['a', 'b', 'new'], ['b', 'gone', 'a'])).toEqual(['b', 'a', 'new'])
  })

  it('no saved order → default order', () => {
    expect(applyOrder(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(applyOrder(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('moveId', () => {
  it('moves up and down, clamped at the edges', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'x', 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('applyOrderAnchored', () => {
  it('inserts a new id after its default predecessor, not at the end', () => {
    // The case that matters: `plan` is the last tile now, so a plain append would bury a new pin.
    const defaults = ['hero', 'changed', 'pin:new', 'worth', 'plan']
    expect(applyOrderAnchored(defaults, ['hero', 'changed', 'worth', 'plan'])).toEqual(defaults)
  })

  it('a new id with no placed predecessor goes first', () => {
    expect(applyOrderAnchored(['new', 'a', 'b'], ['b', 'a'])).toEqual(['new', 'b', 'a'])
  })

  it('still drops stale ids and honours the saved order', () => {
    expect(applyOrderAnchored(['a', 'b'], ['b', 'gone', 'a'])).toEqual(['b', 'a'])
    expect(applyOrderAnchored(['a', 'b'], undefined)).toEqual(['a', 'b'])
  })
})

describe('migrateTiles', () => {
  const SECS = ['hero', 'cards', 'plan']

  it('splices the saved card order into the saved section order', () => {
    const order = { sections: ['plan', 'hero', 'cards'], cards: ['worth', 'changed'] }
    expect(migrateTiles(order, SECS, 'cards')).toEqual(['plan', 'hero', 'worth', 'changed'])
  })

  it('a layout that only nudged cards keeps the default section stack', () => {
    expect(migrateTiles({ cards: ['worth', 'changed'] }, SECS, 'cards')).toEqual(['hero', 'worth', 'changed', 'plan'])
  })

  it('an already-migrated preference passes straight through', () => {
    expect(migrateTiles({ tiles: ['a', 'b'], cards: ['x'] }, SECS, 'cards')).toEqual(['a', 'b'])
  })

  it('nothing saved → nothing to migrate', () => {
    expect(migrateTiles({}, SECS, 'cards')).toBeUndefined()
  })
})

describe('clampSpan', () => {
  it('holds to whole columns, at least 1 and at most the column count', () => {
    expect(clampSpan(2, 3)).toBe(2)
    expect(clampSpan(3, 2)).toBe(2)
    expect(clampSpan(3, 1)).toBe(1) // phone: every tile is full width
    expect(clampSpan(0, 3)).toBe(1)
    expect(clampSpan(1.6, 3)).toBe(2)
  })
})

describe('packRows', () => {
  const spans: Record<string, Span> = { hero: 3, wide: 2, a: 1, b: 1, c: 1, plan: 3 }
  const spanOf = (id: string) => spans[id] ?? 1

  it('fills a row greedily, then wraps', () => {
    expect(packRows(['a', 'b', 'c', 'plan'], spanOf, 3)).toEqual([['a', 'b', 'c'], ['plan']])
  })

  it('a full-width tile takes its own row and pushes the rest down', () => {
    expect(packRows(['a', 'hero', 'b'], spanOf, 3)).toEqual([['a'], ['hero'], ['b']])
  })

  it('a 2-span leaves exactly one column beside it', () => {
    expect(packRows(['wide', 'a', 'b'], spanOf, 3)).toEqual([['wide', 'a'], ['b']])
  })

  it('one column per row on a phone, whatever the stored spans say', () => {
    expect(packRows(['hero', 'a', 'wide'], spanOf, 1)).toEqual([['hero'], ['a'], ['wide']])
  })

  it('two columns on a tablet clamp the 3-spans', () => {
    expect(packRows(['hero', 'a', 'b'], spanOf, 2)).toEqual([['hero'], ['a', 'b']])
  })
})

describe('rowTracks', () => {
  const spanOf = (id: string) => (id === 'wide' ? 2 : 1)

  it('a lone tile fills the whole width whatever its span', () => {
    expect(rowTracks(['a'], spanOf, 3)).toBe('1fr')
  })

  it('keeps the ratio between tiles sharing a row', () => {
    expect(rowTracks(['a', 'b'], spanOf, 3)).toBe('1fr 1fr')
    expect(rowTracks(['wide', 'a'], spanOf, 3)).toBe('2fr 1fr')
  })
})
