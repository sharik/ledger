import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { collectFindings, type Finding, type RawFinding } from './probes'
import { SURFACES } from './surfaces'
import { attachShot } from './shot'

/**
 * The mobile audit sweep.
 *
 * Two modes, chosen by `MOBILE_AUDIT_MODE`:
 *
 *   enforce (default) — fail on any finding not listed in `accepted.json`. This is the
 *                       permanent regression gate.
 *   record            — measure everything, write it out, always pass. Used to build the report
 *                       and to regenerate `accepted.json` once a phase has closed some of it.
 *
 * One `test()` per surface, so a surface that cannot be opened localises to itself instead of
 * taking the run down, and `fullyParallel` still applies.
 */

// Enforce by default now that the fixes have landed: `accepted.json` holds exactly what is
// still outstanding, so the gate fails on anything NEW while the known residue stays visible
// and countable. `MOBILE_AUDIT_MODE=record` re-measures without failing, which is how that file
// gets regenerated after a phase closes some of it.
const MODE = process.env.MOBILE_AUDIT_MODE === 'record' ? 'record' : 'enforce'
const OUT = '.mobile-audit'

interface SurfaceReport {
  surface: string
  group: string
  project: string
  viewport: string
  reachable: boolean
  error?: string
  findings: Finding[]
}

/**
 * The identity of a finding, for the accepted-list.
 *
 * UUIDs are stripped: several test ids embed a record id (`trip-chip-019fb51b-…`), and the
 * seeded vault mints fresh ones on every run, so an un-normalised key could never match twice.
 * Row indices go the same way, for the same reason.
 */
const key = (f: { rule: string; surface: string; selector: string }): string =>
  `${f.rule}|${f.surface}|${f.selector
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/:nth-of-type\(\d+\)/g, ':nth-of-type(n)')}`
// Read rather than `import`: a JSON import would mean turning on `resolveJsonModule` for the
// whole project, which is a bigger change than this one file deserves.
const ACCEPTED = new Set(
  (JSON.parse(readFileSync(new URL('./accepted.json', import.meta.url), 'utf8')) as {
    rule: string
    surface: string
    selector: string
  }[]).map(key),
)

/**
 * Surfaces that cannot currently be driven under touch emulation, with the reason.
 *
 * This is a finding, not a suppression: the entry below says something real about the app, and
 * it is on the manual device checklist precisely because emulation cannot settle it.
 */
const UNREACHABLE = new Map([
  [
    'transient-chart-tip',
    "LineChart's crosshair tooltip does not appear from a synthetic tap. It is raised by " +
      'onPointerDown, so it should — whether a real finger raises it is an open question for the ' +
      'device checklist. The tap-to-drill affordance on the same chart is covered by drill.spec.',
  ],
])

test.describe('mobile audit', () => {
  /**
   * R0 — the harness self-test.
   *
   * Playwright's `hasTouch` is what should make `(pointer: coarse)` match; nothing guarantees it
   * does in headless Chromium. The production `useCoarse()` hook ORs a width query precisely
   * because of that uncertainty, so this test records which half is actually load-bearing. If it
   * fails, hover-suppression cannot be validated by emulation and moves to the device checklist.
   */
  test('R0 · touch emulation reaches the page', async ({ page }, info) => {
    const { appUrl } = await import('../helpers')
    await page.goto(appUrl())
    const probe = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      noHover: matchMedia('(hover: none)').matches,
      touchEvents: 'ontouchstart' in window,
      maxTouchPoints: navigator.maxTouchPoints,
      width: window.innerWidth,
    }))
    await info.attach('touch-emulation.json', {
      body: JSON.stringify(probe, null, 2),
      contentType: 'application/json',
    })
    expect(probe.touchEvents, 'hasTouch should install TouchEvent').toBe(true)
    expect(probe.coarse, '(pointer: coarse) should match under hasTouch').toBe(true)
  })

  for (const surface of SURFACES) {
    test(`${surface.group} · ${surface.id}`, async ({ page }, info) => {
      const project = info.project.name
      const vp = page.viewportSize()
      const viewport = vp ? `${vp.width}×${vp.height}` : 'unknown'

      const report: SurfaceReport = {
        surface: surface.id,
        group: surface.group,
        project,
        viewport,
        reachable: true,
        findings: [],
      }

      try {
        // Bounded well inside the 45s test timeout. Without this a single wrong selector burns
        // the whole budget and reports as "timed out" with nothing measured — the failure mode
        // this sweep exists to avoid.
        await Promise.race([
          surface.open(page),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('surface did not open within 25s')), 25_000),
          ),
        ])
      } catch (e) {
        // An unreachable surface is itself a finding worth reporting, but it must not fail the
        // sweep — one bad selector would otherwise hide every measurement behind it.
        report.reachable = false
        report.error = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }

      if (report.reachable) {
        // Entrance animations move real geometry: a bottom sheet starts below the fold and
        // slides up, so a probe that samples mid-flight reports an overflow that is gone 180ms
        // later. Wait for them to finish rather than measure a frame nobody sees.
        await page.waitForTimeout(300)
        const raw: RawFinding[] = await page.evaluate(collectFindings)
        report.findings = raw.map((f) => ({ ...f, surface: surface.id, viewport }))
        // Pictures only from the 390-wide project; `mobile-sm` is assertions only, and shooting
        // it would double the artefacts for a width nobody reviews by eye.
        if (project === 'mobile') {
          await attachShot(page, info, surface.id, surface.shot, surface.shotTarget)
        }
      }

      mkdirSync(OUT, { recursive: true })
      writeFileSync(`${OUT}/${project}-${surface.id}.json`, JSON.stringify(report, null, 2))
      await info.attach('findings.json', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      })

      if (MODE === 'enforce') {
        if (!UNREACHABLE.has(surface.id)) {
          expect(report.reachable, `surface unreachable: ${report.error}`).toBe(true)
        }
        const unaccepted = report.findings.filter((f) => !ACCEPTED.has(key(f)))
        expect(
          unaccepted.map((f) => `${f.rule} ${f.selector} — ${f.measured}`),
          `${unaccepted.length} mobile violation(s) on ${surface.id}`,
        ).toEqual([])
      }
    })
  }
})
