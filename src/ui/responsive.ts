import { useCallback, useSyncExternalStore } from 'react'

/**
 * Breakpoints for an app with no stylesheet.
 *
 * Styling here is inline `style={{}}` objects (Convention #6), which no `@media` rule can reach.
 * The cross-cutting *value* floors that CSS can express live in one block in `index.html`;
 * everything structural — stacking a grid, turning a row into a card, swapping a popover for a
 * sheet — needs a different DOM tree, so it has to be a conditional render. That is what these
 * hooks are for.
 *
 * Built on `matchMedia`, not a `resize` listener, and that is a real difference rather than a
 * style preference: a resize listener fires on every pixel of a window drag (1280→400 is ~200
 * full-tree renders across the nine always-mounted panes), while a media query fires only when
 * a boundary is crossed — at most three for the same drag.
 *
 * Two rules keep it that way:
 *   - the snapshot is always a boolean, never a width. A `useViewportSize()` would re-render on
 *     every pixel again and undo the whole point. Code that needs real numbers (`noRoomBelow`,
 *     the tooltip clamps) reads `window.innerWidth` imperatively inside an event handler, which
 *     is what it already does.
 *   - subscribe at a pane root and pass the value down where one value drives a subtree; leaf
 *     subscription is fine only where it stays local to that leaf.
 */

export type Bp = 'phone' | 'tablet' | 'desktop'

/** ≤719: phone. 720–1023: tablet. ≥1024: desktop. */
export const PHONE_Q = '(max-width: 719px)'
export const DESKTOP_Q = '(min-width: 1024px)'

/**
 * 720, not 768: 768 is iPad portrait, and a portrait iPad should get the tablet layout — the
 * side-by-side comparison columns of BRIEF §229 still fit there. 719 also sits clear of the
 * 430px of the widest phone.
 */

/**
 * A touch-first pointer. The width term is not redundant with the pointer terms: it keeps a
 * narrow desktop window honest, and it is the fallback if `(pointer: coarse)` ever stops being
 * reported (audit rule R0 asserts that it currently is).
 */
export const COARSE_Q = '(pointer: coarse), (hover: none), (max-width: 719px)'

/** Wide enough that reserving the assistant drawer still leaves a usable content column. */
export const WIDE_Q = '(min-width: 900px)'

interface Entry {
  mql: MediaQueryList
  subs: Set<() => void>
}

/** One MediaQueryList and one listener per distinct query, shared by every subscriber. */
const registry = new Map<string, Entry>()

function entry(query: string): Entry {
  let e = registry.get(query)
  if (!e) {
    const mql = window.matchMedia(query)
    const created: Entry = { mql, subs: new Set() }
    mql.addEventListener('change', () => {
      for (const fn of created.subs) fn()
    })
    registry.set(query, created)
    e = created
  }
  return e
}

/**
 * Subscribe to a media query.
 *
 * No `getServerSnapshot`: this app never server-renders, and supplying one would mean inventing
 * a default that is right for `max-width` queries and wrong for `min-width` ones.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const e = entry(query)
      e.subs.add(onChange)
      return () => {
        e.subs.delete(onChange)
      }
    },
    [query],
  )
  const getSnapshot = useCallback(() => entry(query).mql.matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Imperative read, for the positioning code that runs outside React. */
export function matchNow(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(query).matches
}

export function useBp(): Bp {
  const phone = useMediaQuery(PHONE_Q)
  const desktop = useMediaQuery(DESKTOP_Q)
  return phone ? 'phone' : desktop ? 'desktop' : 'tablet'
}

/** Phone width — the breakpoint that changes layout structure. */
export function useNarrow(): boolean {
  return useMediaQuery(PHONE_Q)
}

/** Touch-first input — the breakpoint that changes control sizing. */
export function useCoarse(): boolean {
  return useMediaQuery(COARSE_Q)
}

/** Wide enough to reserve room for the assistant drawer instead of overlaying the content. */
export function useWideEnough(): boolean {
  return useMediaQuery(WIDE_Q)
}

/**
 * Choose a value for the current breakpoint, falling back upward.
 *
 * `desktop` is required so that every call site states the value that is live today; a phone or
 * tablet entry is an addition to it, never a replacement that could silently change the desktop
 * rendering.
 */
export function pick<T>(bp: Bp, v: { phone?: T; tablet?: T; desktop: T }): T {
  if (bp === 'phone') return v.phone ?? v.tablet ?? v.desktop
  if (bp === 'tablet') return v.tablet ?? v.desktop
  return v.desktop
}
