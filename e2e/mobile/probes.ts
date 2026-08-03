/**
 * Mobile audit probes.
 *
 * `collectFindings` is serialized into the page by `page.evaluate`, so its body must be
 * self-contained: no imports, no closure over anything in this module. Everything it needs
 * is defined inside it.
 *
 * Why these rules and not a generic a11y scanner: the defects this app actually has are
 * layout-metric ones (a 600px grid on a 390px screen, a 24px tap target, a 12.5px input),
 * and no off-the-shelf checker measures those against a phone viewport. The rules below are
 * each falsifiable from the DOM, which is what makes the output a defect list rather than an
 * opinion.
 */

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9'

export const RULE_TITLES: Record<RuleId, string> = {
  R1: 'Horizontal overflow',
  R2: 'Touch target below 44px',
  R3: 'Input font below 16px (iOS zooms on focus)',
  R4: 'touch-action blocks page scroll',
  R5: 'Meaning carried only by title= (invisible on touch)',
  R6: 'Hover-only affordance',
  R7: 'Fixed-pixel grid that cannot fit',
  R8: 'Fixed chrome outside the visual viewport',
  R9: 'Fixed overlay trapped in a transformed ancestor',
}

/** One violation, as measured in the page. `surface`/`viewport` are stamped by the caller. */
export interface RawFinding {
  rule: RuleId
  severity: 'P1' | 'P2' | 'P3'
  selector: string
  testid?: string
  label?: string
  measured: string
  expected: string
}

export interface Finding extends RawFinding {
  surface: string
  viewport: string
}

/**
 * Runs every rule against the current DOM and returns what it found.
 *
 * Hidden panes: the shell keeps all nine mounted behind `display:none` (Convention #7), so a
 * naive querySelectorAll would report the same violation nine times over and drown the real
 * one. Every rule filters on `getClientRects().length` first — a `display:none` subtree has
 * no rects, so the eight inactive panes drop out without the app needing to know a test exists.
 */
export function collectFindings(): RawFinding[] {
  const out: RawFinding[] = []
  const vw = window.innerWidth
  const vh = window.visualViewport?.height ?? window.innerHeight

  const visible = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.opacity !== '0'
  }

  /** A short, human-readable path. Prefers a test id or a data-tab, else tag + nth-of-type. */
  const sel = (el: Element): string => {
    const parts: string[] = []
    let cur: Element | null = el
    for (let depth = 0; cur && depth < 4 && cur !== document.body; depth++) {
      const tid = cur.getAttribute('data-testid')
      if (tid) {
        parts.unshift(`[data-testid="${tid}"]`)
        break
      }
      const pane = cur.getAttribute('data-pane')
      if (pane) {
        parts.unshift(`[data-pane="${pane}"]`)
        break
      }
      const parent: Element | null = cur.parentElement
      if (!parent) break
      const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
      const tag = cur.tagName.toLowerCase()
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag)
      cur = parent
    }
    return parts.join(' > ') || el.tagName.toLowerCase()
  }

  const label = (el: Element): string => {
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim()
    return t.length > 60 ? `${t.slice(0, 57)}…` : t
  }

  const add = (f: RawFinding): void => {
    out.push(f)
  }
  const tid = (el: Element): string | undefined => el.getAttribute('data-testid') ?? undefined

  // ── R1 — horizontal overflow ────────────────────────────────────────────────────────────
  // `document.body.scrollWidth <= innerWidth` is worthless in this app: MainArea carries
  // `overflowX:'auto'`, so it absorbs any overflow into a sideways scroll and the body never
  // grows. The honest measurement is the scroller's own scrollWidth against its clientWidth.
  const scroller = document.querySelector('[data-main-scroll]')
  if (scroller) {
    const over = scroller.scrollWidth - scroller.clientWidth
    if (over > 1) {
      const box = scroller.getBoundingClientRect()
      const limit = scroller.clientWidth
      // Report the TOPMOST offender on each branch — one 600px grid should yield one finding,
      // not one per descendant that inherits its width.
      const walk = (el: Element): void => {
        for (const child of Array.from(el.children)) {
          if (!visible(child)) continue
          const cs = getComputedStyle(child)
          if (cs.position === 'fixed') continue // measured separately, below
          const r = child.getBoundingClientRect()
          const right = r.left - box.left + scroller.scrollLeft + r.width
          if (right > limit + 1) {
            add({
              rule: 'R1',
              severity: right > limit * 1.25 ? 'P1' : 'P2',
              selector: sel(child),
              testid: tid(child),
              label: label(child),
              measured: `${Math.round(right)}px wide inside a ${limit}px column (overflows by ${Math.round(right - limit)}px)`,
              expected: `≤ ${limit}px`,
            })
            continue // do not descend — the children are victims, not causes
          }
          walk(child)
        }
      }
      walk(scroller)
      if (out.every((f) => f.rule !== 'R1')) {
        // Overflow exists but no single child owns it (e.g. a wide text node or a negative margin).
        add({
          rule: 'R1',
          severity: 'P2',
          selector: '[data-main-scroll]',
          measured: `scrollWidth ${scroller.scrollWidth}px vs clientWidth ${limit}px`,
          expected: `≤ ${limit}px`,
        })
      }
    }
  }

  // Fixed-position chrome is outside the scroller, so it needs its own horizontal check.
  const fixed = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(
    (el) => visible(el) && getComputedStyle(el).position === 'fixed',
  )
  for (const el of fixed) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > vw + 1 || r.left < -1) {
      add({
        rule: 'R1',
        severity: 'P1',
        selector: sel(el),
        testid: tid(el),
        label: label(el),
        measured: `fixed element spans ${Math.round(r.left)}→${Math.round(r.right)} in a ${vw}px viewport`,
        expected: `within 0→${vw}`,
      })
    }
    // ── R8 — fixed chrome below the visual viewport (the safe-area / home-indicator case) ──
    if (r.height > 0 && r.top < vh && r.bottom > vh + 1) {
      add({
        rule: 'R8',
        severity: 'P2',
        selector: sel(el),
        testid: tid(el),
        label: label(el),
        measured: `bottom edge at ${Math.round(r.bottom)}px, visual viewport ends at ${Math.round(vh)}px`,
        expected: `≤ ${Math.round(vh)}px, or padded by env(safe-area-inset-bottom)`,
      })
    }
  }

  // ── R9 — a fixed overlay whose containing block is not the viewport ─────────────────────
  // `position: fixed` is only viewport-relative while no ancestor establishes a containing
  // block. A `transform`, `filter`, `perspective`, `will-change: transform` or `contain: paint`
  // on any ancestor silently re-anchors the overlay to that ancestor's box instead.
  //
  // This app hits it for real: `.rise` (index.html) animates `translateY(6px) → none`, and
  // several screens wrap their whole pane in it while rendering a fixed dialog inside. For the
  // 0.34s the animation runs, the dialog is positioned against the pane — which starts at
  // MainArea's 26px top padding — and then snaps to the viewport when the animation ends.
  //
  // `animation-name` is treated as disqualifying even when the animation has finished, because
  // the defect is the transient state, not the resting one, and the resting one is what a probe
  // would otherwise sample. Every keyframe set in this app animates `transform`.
  for (const el of fixed) {
    let anc: Element | null = el.parentElement
    while (anc && anc !== document.documentElement) {
      const cs = getComputedStyle(anc)
      const cause =
        cs.transform !== 'none'
          ? `transform: ${cs.transform}`
          : cs.filter !== 'none'
            ? `filter: ${cs.filter}`
            : cs.perspective !== 'none'
              ? `perspective: ${cs.perspective}`
              : /transform|filter/.test(cs.willChange)
                ? `will-change: ${cs.willChange}`
                : cs.animationName !== 'none'
                  ? `animation: ${cs.animationName} (animates transform)`
                  : null
      if (cause) {
        add({
          rule: 'R9',
          severity: 'P1',
          selector: sel(el),
          testid: tid(el),
          label: label(el),
          measured: `containing block is \`${sel(anc)}\` — ${cause}`,
          expected: 'no transformed ancestor, or render the overlay through a portal',
        })
        break
      }
      anc = anc.parentElement
    }
  }

  // ── R2 — touch targets ──────────────────────────────────────────────────────────────────
  const focusables = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => visible(el) && !el.hasAttribute('disabled'))
  for (const el of focusables) {
    const r = el.getBoundingClientRect()
    let w = r.width
    let h = r.height

    // What matters is the size of the TARGET, not of the drawing. Two ways a control can be
    // bigger than it looks, both of them deliberate:
    //
    //  · an `::after` overlay centred on it (how every small button gets to 44px without the
    //    design turning into a row of 44px slabs);
    //  · a wrapping <label>, which is what a 22px checkbox sits inside.
    //
    // Measuring the glyph instead would push the app toward comically large controls to satisfy
    // a number — the opposite of what the rule is for.
    const after = getComputedStyle(el, '::after')
    if (after.content !== 'none' && after.position === 'absolute') {
      const aw = parseFloat(after.width)
      const ah = parseFloat(after.height)
      if (!Number.isNaN(aw)) w = Math.max(w, aw)
      if (!Number.isNaN(ah)) h = Math.max(h, ah)
    }
    if (el.tagName === 'INPUT') {
      const lab = el.closest('label')
      if (lab) {
        const lr = lab.getBoundingClientRect()
        w = Math.max(w, lr.width)
        h = Math.max(h, lr.height)
      }
    }
    const min = Math.min(w, h)
    // Half a pixel of tolerance: sub-pixel layout routinely lands a 44px control on 43.98, and
    // reporting that as a violation (rendered "44×44px") reads as a probe bug, not a finding.
    if (min >= 43.5) continue
    // A chart mark's size IS the datum — a bar 8px wide is 8px wide because that is what the
    // value says. Padding it to 44 would be drawing a lie. These stay on the report so the
    // decision is visible rather than silently filtered, but they are not a debt to pay down;
    // the touch affordance for a chart is the tap-to-drill on the mark's real area.
    const chartMark = el.namespaceURI === 'http://www.w3.org/2000/svg'
    add({
      rule: 'R2',
      severity: chartMark ? 'P3' : min < 30 ? 'P1' : 'P2',
      selector: sel(el),
      testid: tid(el),
      label: label(el),
      measured: `${Math.round(r.width)}×${Math.round(r.height)}px${chartMark ? ' — chart mark, size encodes the value' : ''}`,
      expected: chartMark ? 'exempt: size is essential (WCAG 2.5.8)' : '≥ 44×44px (BRIEF §275)',
    })
  }

  // ── R3 — input font size (iOS zooms the page on focus below 16px) ───────────────────────
  const typables = Array.from(
    document.querySelectorAll<HTMLElement>(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea',
    ),
  ).filter(visible)
  for (const el of typables) {
    const fs = parseFloat(getComputedStyle(el).fontSize)
    if (fs < 16) {
      add({
        rule: 'R3',
        severity: 'P1',
        selector: sel(el),
        testid: tid(el),
        label: el.getAttribute('placeholder') ?? label(el),
        measured: `font-size ${fs}px`,
        expected: '≥ 16px',
      })
    }
  }

  // ── R4 — touch-action that swallows the page scroll ─────────────────────────────────────
  // A large element with `touch-action: none` traps every gesture that starts on it, so a
  // finger landing there cannot scroll the page at all.
  const area = vw * vh
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(visible)) {
    if (getComputedStyle(el).touchAction !== 'none') continue
    const r = el.getBoundingClientRect()
    // Either a big share of the screen, or a full-width band tall enough that a thumb will
    // land on it during an ordinary scroll. A phone is tall, so a chart can trap every swipe
    // while still being well under 15% of the viewport area.
    const wide = r.width > vw * 0.6 && r.height > 90
    if (r.width * r.height > area * 0.08 || wide) {
      add({
        rule: 'R4',
        severity: 'P1',
        selector: sel(el),
        testid: tid(el),
        label: label(el),
        measured: `touch-action:none over ${Math.round(r.width)}×${Math.round(r.height)}px (${Math.round((r.width * r.height * 100) / area)}% of the viewport)`,
        expected: "'pan-y' so vertical scrolling still works",
      })
    }
  }

  // ── R5 — meaning that lives only in title= ──────────────────────────────────────────────
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[title]')).filter(visible)) {
    if (el.getAttribute('aria-label')) continue
    const clickable =
      el.tagName === 'BUTTON' || el.tagName === 'A' || getComputedStyle(el).cursor === 'pointer'
    add({
      rule: 'R5',
      severity: clickable ? 'P1' : 'P2',
      selector: sel(el),
      testid: tid(el),
      label: label(el),
      measured: `title="${el.getAttribute('title')}"${clickable ? ' on a clickable element' : ''}`,
      expected: clickable
        ? 'a visible affordance plus aria-label'
        : 'visible text, or the Explain panel',
    })
  }

  // ── R6 — hover-only affordance (census; :hover never fires on touch) ────────────────────
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="hov-"]')).filter(visible)) {
    add({
      rule: 'R6',
      severity: 'P3',
      selector: sel(el),
      testid: tid(el),
      label: label(el),
      measured: `class="${el.getAttribute('class')}"`,
      expected: 'hover styles gated behind @media (hover:hover)',
    })
  }

  // ── R7 — fixed-pixel grid tracks that cannot fit ────────────────────────────────────────
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(visible)) {
    const cs = getComputedStyle(el)
    if (cs.display !== 'grid') continue
    if (el.scrollWidth <= el.clientWidth + 1) continue
    add({
      rule: 'R7',
      severity: 'P1',
      selector: sel(el),
      testid: tid(el),
      label: label(el),
      measured: `grid-template-columns: ${cs.gridTemplateColumns} — needs ${el.scrollWidth}px, has ${el.clientWidth}px`,
      expected: 'stacked, or minmax() tracks that reflow',
    })
  }

  return out
}
