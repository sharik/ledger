/**
 * Turn the raw audit output into `specs/Mobile-Audit.md` and a committed `baseline.json`.
 *
 *   npx playwright test e2e/mobile/audit.spec.ts   # writes .mobile-audit/*.json
 *   npx vitest run tests/mobile-static.test.ts     # writes static-inventory.json alongside
 *   npm run mobile:report
 *
 * The report groups findings into defects — one per (rule, surface-shape) — because a list of
 * 900 individual measurements is data, not a work plan. Ranking is by reach and severity, so
 * the top of the file is the order the fixes should land in.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { RULE_TITLES, type RuleId } from '../e2e/mobile/probes'

const RESULTS = '.mobile-audit'
const BASELINE = 'e2e/mobile/__audit__/baseline.json'

interface Finding {
  rule: RuleId
  surface: string
  viewport: string
  severity: 'P1' | 'P2' | 'P3'
  selector: string
  testid?: string
  label?: string
  measured: string
  expected: string
}

interface SurfaceReport {
  surface: string
  group: string
  project: string
  viewport: string
  reachable: boolean
  error?: string
  findings: Finding[]
}

interface Site {
  file: string
  line: number
  text: string
}

/** Surfaces on the "glance on the phone" path the Design Brief names as canonical (§17). */
const CANONICAL = /^(tab-dash|tab-txns|tab-trips|dash-|txns-|overlay-trip-mode)/

/** The source patterns behind each rule, for the file:line column. */
const RULE_SOURCES: Partial<Record<RuleId, keyof StaticInventory>> = {
  R1: 'fixedGridTracks',
  R4: 'touchActionNone',
  R5: 'titleAttributes',
  R6: 'hoverClasses',
  R7: 'fixedGridTracks',
}

interface StaticInventory {
  viewportHeight: Site[]
  fixedGridTracks: Site[]
  touchActionNone: Site[]
  titleAttributes: Site[]
  hoverClasses: Site[]
  safeAreaInsets: Site[]
  mediaQueries: Site[]
}

function load(): { reports: SurfaceReport[]; statics: StaticInventory | null } {
  if (!existsSync(RESULTS)) {
    throw new Error(`No audit output in ${RESULTS}. Run the audit spec first.`)
  }
  const reports: SurfaceReport[] = []
  let statics: StaticInventory | null = null
  for (const name of readdirSync(RESULTS)) {
    if (!name.endsWith('.json')) continue
    const body = JSON.parse(readFileSync(join(RESULTS, name), 'utf8'))
    if (name === 'static-inventory.json') statics = body as StaticInventory
    else reports.push(body as SurfaceReport)
  }
  return { reports, statics }
}

/**
 * Collapse findings into defects.
 *
 * The grouping key is (rule, selector-shape) rather than (rule, element): a 6-column grid that
 * overflows on 200 transaction rows is one defect with one fix, and reporting it 200 times
 * would bury the 12 other things that are also wrong.
 */
interface Defect {
  id: string
  rule: RuleId
  severity: 'P1' | 'P2' | 'P3'
  shape: string
  surfaces: string[]
  viewports: string[]
  count: number
  examples: Finding[]
  score: number
}

/** Strip nth-of-type indices so sibling rows of the same list collapse together. */
const shapeOf = (f: Finding): string =>
  f.testid ? `[data-testid="${f.testid}"]` : f.selector.replace(/:nth-of-type\(\d+\)/g, '')

const RANK = { P1: 9, P2: 3, P3: 1 } as const

function group(findings: Finding[]): Defect[] {
  const byKey = new Map<string, Finding[]>()
  for (const f of findings) {
    const k = `${f.rule}::${shapeOf(f)}`
    const list = byKey.get(k)
    if (list) list.push(f)
    else byKey.set(k, [f])
  }

  const defects: Defect[] = []
  for (const [k, list] of byKey) {
    const first = list[0]!
    const surfaces = [...new Set(list.map((f) => f.surface))].sort()
    const severity = list.some((f) => f.severity === 'P1')
      ? 'P1'
      : list.some((f) => f.severity === 'P2')
        ? 'P2'
        : 'P3'
    const canonical = surfaces.some((s) => CANONICAL.test(s)) ? 1.5 : 1
    defects.push({
      id: '',
      rule: first.rule,
      severity,
      shape: k.split('::')[1] ?? first.selector,
      surfaces,
      viewports: [...new Set(list.map((f) => f.viewport))].sort(),
      count: list.length,
      examples: list.slice(0, 3),
      score: RANK[severity] * Math.log2(1 + surfaces.length) * canonical,
    })
  }
  defects.sort((a, b) => b.score - a.score || b.count - a.count)
  defects.forEach((d, i) => {
    d.id = `M-${String(i + 1).padStart(2, '0')}`
  })
  return defects
}

function sourceLines(rule: RuleId, statics: StaticInventory | null): Site[] {
  const key = RULE_SOURCES[rule]
  if (!key || !statics) return []
  return statics[key]
}

const RULE_NOTES: Record<RuleId, string> = {
  R1: 'The main scroller (`[data-main-scroll]`) is wider than its own column, so the screen scrolls sideways. `document.body.scrollWidth` cannot detect this — the scroller absorbs the overflow — which is why the one pre-existing mobile assertion never fired.',
  R2: 'Below the ≥44-pt floor BRIEF §275 already requires. `<30px` is P1, `30–43px` is P2.',
  R3: 'iOS Safari zooms the whole page when a field smaller than 16px takes focus, and does not zoom back out.',
  R4: '`touch-action: none` over a large area traps every gesture that starts on it, so a finger landing there cannot scroll the page at all.',
  R5: '`title` is invisible on touch, unreachable by keyboard, and cannot hold structure. Already logged as **C8** in UX-Comprehension-Audit.md — "the single largest cause of P1 rows in this document".',
  R6: 'A census, not a verdict: `:hover` never fires on touch, and these classes carry `!important`, so on iOS the state also sticks after a tap.',
  R7: 'A grid whose tracks are fixed pixels cannot reflow; it can only overflow.',
  R8: 'Fixed chrome extending past the visual viewport — the safe-area / home-indicator case.',
  R9: '`position: fixed` is viewport-relative only while no ancestor establishes a containing block; a `transform`, `filter`, `perspective` or `will-change` on any ancestor silently re-anchors the overlay to that ancestor instead. The `.rise` entrance animation does exactly this to several dialogs for the 0.34s it runs — which is also why `e2e/visual.spec.ts › year in review` flakes by exactly 26px (MainArea\'s top padding) under load. Every drawer that becomes a bottom sheet anchored with `env(safe-area-inset-bottom)` depends on this being clean.',
}

const ORDER: RuleId[] = ['R1', 'R7', 'R9', 'R2', 'R3', 'R4', 'R5', 'R8', 'R6']

function md(defects: Defect[], reports: SurfaceReport[], statics: StaticInventory | null): string {
  const projects = [...new Set(reports.map((r) => r.project))].sort()
  const surfaces = [...new Set(reports.map((r) => r.surface))]
  const unreachable = reports.filter((r) => !r.reachable)
  const findings = reports.flatMap((r) => r.findings)

  const L: string[] = []
  L.push('# Mobile Audit')
  L.push('')
  L.push('> Generated by `npm run mobile:audit && npm run mobile:report`. Do not hand-edit —')
  L.push('> record fixes by re-running, and track the delta in `e2e/mobile/__audit__/baseline.json`.')
  L.push('')
  L.push(
    'Measured from the running app, not read off the source. Every number below was taken by a',
    'probe at phone width; the file:line lists come from a source scan (`tests/mobile-static.test.ts`)',
    'that runs in the same gate.',
  )
  L.push('')
  L.push(
    `**Coverage:** ${surfaces.length} surfaces × ${projects.length} widths ` +
      `(${projects.join(', ')}) = ${reports.length} runs · ` +
      `${findings.length.toLocaleString('en-US')} raw findings · ${defects.length} distinct defects.`,
  )
  L.push('')
  L.push(
    'The sweep runs in **record** mode: it reports without failing, which is what lets the harness',
    'land before any UI changes. The final phase sets `MOBILE_AUDIT_MODE=enforce` and this same',
    'spec becomes the permanent regression gate.',
  )
  L.push('')
  L.push(
    '**Screenshots** of every surface are written to `.mobile-audit/shots/mobile/`',
    '(git-ignored, full-height). They are evidence, not baselines: a baseline is a comparison',
    'target, and committing one per surface now would mean rebaselining all of them in each of',
    'the phases that follow. Committed baselines start per surface, in the phase that reshapes it.',
  )
  L.push('')
  if (unreachable.length) {
    L.push('### Surfaces that could not be opened')
    L.push('')
    L.push('Read these as findings, not as harness noise: a surface that cannot be driven under')
    L.push('touch emulation is, by definition, a surface a phone user may not be able to reach.')
    L.push('')
    for (const r of unreachable) L.push(`- \`${r.surface}\` (${r.project}) — ${r.error}`)
    L.push('')
  }
  L.push('---')
  L.push('')

  // ── the work plan ───────────────────────────────────────────────────────────────────────
  L.push('## Fix these first')
  L.push('')
  L.push('Ranked by `severity × log2(1 + surfaces affected)`, ×1.5 on the "glance on the phone"')
  L.push('path the Design Brief calls canonical (§17). This is the order the fixes should land in.')
  L.push('')
  L.push('| # | Rule | Sev | Element | Surfaces | Instances |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const d of defects.slice(0, 15)) {
    L.push(
      `| ${d.id} | ${d.rule} | ${d.severity} | \`${d.shape}\` | ${d.surfaces.length} | ${d.count} |`,
    )
  }
  L.push('')
  L.push('---')
  L.push('')

  // ── per-rule totals ─────────────────────────────────────────────────────────────────────
  L.push('## By rule')
  L.push('')
  L.push('| Rule | What | Instances | Surfaces | Distinct elements |')
  L.push('| --- | --- | --- | --- | --- |')
  for (const rule of ORDER) {
    const fs_ = findings.filter((f) => f.rule === rule)
    if (!fs_.length) continue
    const shapes = new Set(fs_.map(shapeOf)).size
    const surf = new Set(fs_.map((f) => f.surface)).size
    L.push(
      `| [${rule}](#${rule.toLowerCase()}--${RULE_TITLES[rule].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}) | ${RULE_TITLES[rule]} | ${fs_.length.toLocaleString('en-US')} | ${surf} | ${shapes} |`,
    )
  }
  L.push('')

  // ── worst surfaces ──────────────────────────────────────────────────────────────────────
  L.push('## By surface')
  L.push('')
  L.push('Instances per surface, worst first. A high count is usually one repeated row, not many')
  L.push('separate problems — read it as "how much of this screen is affected".')
  L.push('')
  L.push('| Surface | P1 | P2 | P3 | Rules hit |')
  L.push('| --- | --- | --- | --- | --- |')
  const bySurface = new Map<string, Finding[]>()
  for (const f of findings) {
    const l = bySurface.get(f.surface)
    if (l) l.push(f)
    else bySurface.set(f.surface, [f])
  }
  const rows = [...bySurface.entries()]
    .map(([s, fs_]) => ({
      s,
      p1: fs_.filter((f) => f.severity === 'P1').length,
      p2: fs_.filter((f) => f.severity === 'P2').length,
      p3: fs_.filter((f) => f.severity === 'P3').length,
      rules: [...new Set(fs_.map((f) => f.rule))].sort().join(' '),
    }))
    .sort((a, b) => b.p1 - a.p1 || b.p2 - a.p2)
  for (const r of rows) L.push(`| \`${r.s}\` | ${r.p1} | ${r.p2} | ${r.p3} | ${r.rules} |`)
  L.push('')
  L.push('---')
  L.push('')

  // ── the detail, one section per rule ────────────────────────────────────────────────────
  for (const rule of ORDER) {
    const mine = defects.filter((d) => d.rule === rule)
    if (!mine.length) continue
    const total = findings.filter((f) => f.rule === rule).length
    L.push(`## ${rule} · ${RULE_TITLES[rule]}`)
    L.push('')
    L.push(RULE_NOTES[rule])
    L.push('')
    L.push(
      `**${total.toLocaleString('en-US')} instance(s)** over **${mine.length} distinct element(s)**, ` +
        `across ${new Set(mine.flatMap((d) => d.surfaces)).size} surface(s).`,
    )
    L.push('')
    L.push('| # | Sev | Element | Measured | Surfaces | Instances |')
    L.push('| --- | --- | --- | --- | --- | --- |')
    for (const d of mine.slice(0, 20)) {
      const ex = d.examples[0]!
      const where =
        d.surfaces.length <= 3 ? d.surfaces.join(', ') : `${d.surfaces.slice(0, 2).join(', ')} +${d.surfaces.length - 2}`
      L.push(
        `| ${d.id} | ${d.severity} | \`${d.shape}\`${ex.label ? `<br>“${ex.label}”` : ''} | ${ex.measured.replace(/\|/g, '\\|')} | ${where} | ${d.count} |`,
      )
    }
    if (mine.length > 20) L.push(`| | | *…and ${mine.length - 20} more elements* | | | |`)
    L.push('')
    const src = sourceLines(rule, statics)
    if (src.length) {
      L.push(`<details><summary><b>Source sites (${src.length})</b></summary>`)
      L.push('')
      for (const s of src) L.push(`- [\`${s.file}:${s.line}\`](../${s.file}#L${s.line})`)
      L.push('')
      L.push('</details>')
      L.push('')
    }
    L.push('**Status:** open')
    L.push('')
    L.push('---')
    L.push('')
  }

  if (statics) {
    L.push('## Source inventory')
    L.push('')
    L.push('Counts asserted as ceilings by `tests/mobile-static.test.ts`, so this debt cannot grow')
    L.push('while the work is in flight.')
    L.push('')
    L.push('| Pattern | Sites |')
    L.push('| --- | --- |')
    for (const [k, v] of Object.entries(statics)) L.push(`| \`${k}\` | ${v.length} |`)
    L.push('')
    L.push('---')
    L.push('')
  }

  L.push(MANUAL_CHECKLIST)
  return L.join('\n')
}

const MANUAL_CHECKLIST = `## Manual device checklist

Emulation reaches none of the following. Run against a real phone on the LAN dev server
(\`npx vite --host\`, then \`http://<lan-ip>:5173/?now=2026-07-12T14:32:00Z&kdf=test\`).

### iOS Safari — portrait and landscape

- [ ] URL bar collapses on scroll: the shell must not jump, and nothing must slide under the toolbar. (This is the whole reason the shell uses \`svh\` and not \`vh\` or \`dvh\`.)
- [ ] Tap an input inside a bottom sheet — does the virtual keyboard cover it? \`visualViewport\` resizing is not emulated.
- [ ] Focus every text field: no zoom. Only a device enforces the 16px rule.
- [ ] Rubber-band overscroll at the top and bottom of the main scroller, and scroll chaining out of an open sheet.
- [ ] Tap the status bar: does it scroll the document (which is inert here) or the inner scroller?
- [ ] Sticky \`:hover\` after tapping a button — confirms the \`@media (hover:hover)\` gating actually took.
- [ ] Notch and home indicator with \`viewport-fit=cover\`, in both orientations.
- [ ] **Durability:** iOS evicts IndexedDB for non-installed sites after ~7 days unused. \`navigator.storage.persist()\` is requested but does not fully apply on iOS. For a vault with no file connected, L1 is the only copy — confirm the Settings nudge is visible and says so.

### Android Chrome

- [ ] Back gesture and hardware back against hash routing with a sheet open — dismissing a sheet must not eject you from the app.
- [ ] Mid-range device: first paint and tab-switch latency with all nine panes mounted and charts live.

### Both

- [ ] Touch-scrub every chart: scrub horizontally, scroll vertically, and attempt both at once.
- [ ] Font loading over real 3G/4G (fonts.googleapis.com) — how long is the FOUT?
- [ ] Hairline borders at DPR 3.
- [ ] The \`<input type=file>\` vault-open path: what the iOS Files / Android picker actually offers, and that the "cannot connect as a sync remote" degradation is explained rather than silently broken.
`

function main(): void {
  const { reports, statics } = load()
  const findings = reports.flatMap((r) => r.findings)
  const defects = group(findings)
  writeFileSync('specs/Mobile-Audit.md', md(defects, reports, statics))
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        surfaces: reports.length,
        findings: findings.length,
        defects: defects.map((d) => ({
          id: d.id,
          rule: d.rule,
          severity: d.severity,
          shape: d.shape,
          surfaces: d.surfaces,
          count: d.count,
        })),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    `specs/Mobile-Audit.md — ${defects.length} defects from ${findings.length} findings across ${reports.length} surface runs`,
  )
}

main()
