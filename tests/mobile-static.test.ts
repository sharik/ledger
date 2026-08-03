import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The source half of the mobile audit.
 *
 * The Playwright probes measure what a phone actually renders; they cannot say which line
 * wrote it. This walks `src/` for the patterns behind those measurements so every runtime
 * finding can be reported with a file:line to fix, and so the counts have a committed
 * baseline that later phases visibly drive down.
 *
 * Runs in the node environment like every other suite here — no jsdom, no rendering. It reads
 * text, which is exactly the level at which these particular defects live: they are all
 * literals in inline style objects.
 */

const SRC = new URL('../src/', import.meta.url).pathname
const OUT = new URL('../.mobile-audit/', import.meta.url).pathname

interface Site {
  file: string
  line: number
  text: string
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.tsx?$/.test(name)) acc.push(p)
  }
  return acc
}

const INDEX_HTML = new URL('../index.html', import.meta.url).pathname
const FILES = walk(SRC).sort()

/** Every line matching `re`, as repo-relative file:line sites. */
function scan(re: RegExp, extra: string[] = []): Site[] {
  const out: Site[] = []
  for (const path of [...FILES, ...extra]) {
    const rel = path === INDEX_HTML ? 'index.html' : `src/${path.slice(SRC.length)}`
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (re.test(text)) out.push({ file: rel, line: i + 1, text: text.trim().slice(0, 200) })
      })
  }
  return out
}

/**
 * The inventory. Each entry is a class of source-level mobile defect, its current sites, and
 * the ceiling a later phase must not exceed. The ceilings are assertions, not documentation:
 * they fail if the debt grows while the work is in flight.
 */
const INVENTORY = {
  /**
   * Viewport units the iOS URL bar invalidates. Phase 2 moved all three shell heights to
   * `100svh`; the ceiling is 0 so a `100vh` cannot creep back into a full-height container.
   * (`100vw`/`calc(100vw - …)` clamps are a separate, legitimate case and are not counted.)
   */
  viewportHeight: { sites: scan(/\b100vh\b/), ceiling: 0 },
  /**
   * Grid tracks in fixed px — the reason lists need 600px on a 390px screen. `minmax()` tracks
   * are excluded on purpose: those already reflow, so counting them would inflate the debt with
   * the three sites that are not broken.
   */
  fixedGridTracks: {
    sites: scan(/gridTemplateColumns:.*\d+px/).filter((s) => !s.text.includes('minmax(')),
    ceiling: 16,
  },
  /** `touch-action:none` swallows the page scroll wherever it covers real estate. */
  touchActionNone: { sites: scan(/touchAction:\s*'none'/), ceiling: 0 },
  /** Meaning carried by a tooltip that touch devices never show. Audit finding C8. */
  titleAttributes: { sites: scan(/\btitle=/), ceiling: 104 },
  /**
   * Hover-only affordances; `:hover` never fires on touch. Raised 46 → 48 for the three
   * Google Drive connect buttons (Settings → Sync connect and switch, and the boot screen's
   * Open tab), which carry the same `hov-invert` as every button beside them. All three are
   * ordinary tap targets; the class only adds a hover effect on top.
   */
  hoverClasses: { sites: scan(/className="hov-/), ceiling: 48 },
  /** Any use at all is progress — the app starts with zero. */
  safeAreaInsets: { sites: scan(/env\(safe-area-inset/, [INDEX_HTML]), ceiling: Infinity },
  /** Width-based media queries. Also starts at zero. The one that exists is reduced-motion. */
  mediaQueries: { sites: scan(/@media[^{]*(min-width|max-width)/, [INDEX_HTML]), ceiling: Infinity },
}

describe('mobile source inventory', () => {
  it('writes the inventory for the audit report', () => {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(
      join(OUT, 'static-inventory.json'),
      JSON.stringify(
        Object.fromEntries(Object.entries(INVENTORY).map(([k, v]) => [k, v.sites])),
        null,
        2,
      ),
    )
    expect(FILES.length).toBeGreaterThan(40)
  })

  for (const [name, { sites, ceiling }] of Object.entries(INVENTORY)) {
    if (ceiling === Infinity) continue
    it(`${name}: ${sites.length} site(s), must not exceed ${ceiling}`, () => {
      expect(sites.length, sites.map((s) => `${s.file}:${s.line}`).join('\n')).toBeLessThanOrEqual(
        ceiling,
      )
    })
  }

  it('keeps the responsive floor in place', () => {
    // Phase 1 asserted these were both zero — the shape of the problem. Phase 2 earned the
    // rewrite: there is now a phone breakpoint and safe-area handling, and the assertion flips
    // from "none of this exists" to "this must not be removed".
    expect(INVENTORY.mediaQueries.sites.length).toBeGreaterThan(0)
    expect(INVENTORY.safeAreaInsets.sites.length).toBeGreaterThan(0)
  })
})
