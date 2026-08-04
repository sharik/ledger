import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// `.env.test` (git-ignored) carries a real provider key for the `live` project below. Optional:
// with no such file the live spec skips itself and nothing else in the suite reads these vars.
// `process.loadEnvFile` is built into Node — no dotenv dependency for one optional file.
if (existsSync('.env.test')) process.loadEnvFile('.env.test')

export default defineConfig({
  testDir: './e2e',
  // Raised with the suite: promoting specs to a second viewport roughly doubled the tests run
  // against one dev server, and page loads under that contention were tripping the old 45s.
  timeout: 60_000,
  fullyParallel: true,
  // 3, not 4: the suite roughly doubled when specs were promoted to a second viewport, and four
  // workers cold-loading modules against one vite dev server intermittently starved a page load
  // past its timeout. The failures were never the same test twice — the signature of contention
  // rather than a defect. CI runners are smaller still, so they get 2.
  workers: process.env.CI ? 2 : 3,
  // The same contention is why CI retries: a starved page load is not a defect, and without this a
  // single one fails the whole run. Locally 0, so a flake stays visible instead of being papered over.
  retries: process.env.CI ? 2 : 0,
  // A stray `.only` narrows the run silently — locally that is convenient, in CI it is a green
  // build that tested almost nothing.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    // 'retain-on-failure' RECORDS a trace for every test and deletes it on success — a DOM snapshot
    // per action, zipped and thrown away, once per test on a green run. Retries are 2 in CI, so a
    // real failure still yields a trace on attempt 2; what is given up is the trace of a flake that
    // passes on retry, which was never the interesting one.
    trace: 'on-first-retry',
    timezoneId: 'UTC',
  },
  projects: [
    // Everything runs at 1280×800 except the mobile specs (trip-detail + the e2e/mobile suite).
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
      // `live-*` is opt-in (see the `live` project): it spends real money against a real provider,
      // so it must never ride along on an ordinary run just because a key happens to be present.
      testIgnore: [/trip-detail\.spec\.ts/, /mobile\//, /live-.*\.spec\.ts/],
    },
    // 390×844 with real touch emulation. `viewport` alone does NOT make the page touch-capable:
    // `hasTouch` is what turns on TouchEvent and (pointer: coarse), which is the whole point of a
    // mobile project — a width-only project silently passes every touch-affordance assertion.
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
      // `.spec.ts`, not the whole directory: an explicit testMatch REPLACES Playwright's default
      // glob, so a bare `mobile/` would classify probes.ts/surfaces.ts/shot.ts as test files and
      // then refuse to let the spec import them.
      //
      // The promoted specs are the layout-bearing ones. `sync`, `openfile`, `import`, `fx`,
      // `duplicates`, `assist`, `assistant` and `failures` are deliberately NOT here: they drive
      // engine paths — merge, CAS, File System Access, provider wire — where a second viewport
      // proves nothing and only doubles the runtime.
      testMatch: [
        /trip-detail\.spec\.ts/,
        /mobile\/.*\.spec\.ts/,
        /e2e\/(navigation|transactions|trips|drill|explain|plan|subscriptions)\.spec\.ts/,
      ],
    },
    // The narrow Android floor. Assertions only — the audit spec skips screenshots off `mobile`,
    // so this project doubles the width coverage without doubling the baseline count.
    {
      name: 'mobile-sm',
      use: { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
      testMatch: [/mobile\/audit\.spec\.ts/],
    },
    // Opt-in only — `npx playwright test --project=live`. Talks to a real provider with the key in
    // `.env.test`, which is what makes it worth having: every other assistant spec stubs the
    // provider, so they prove the plumbing but never that a real model CHOOSES the right tool.
    // One worker: these are network-bound and paid for by the request, not CPU-bound.
    {
      name: 'live',
      use: { viewport: { width: 1280, height: 800 } },
      testMatch: [/live-.*\.spec\.ts/],
    },
  ],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  // `{projectName}` is load-bearing: without it a mobile and a desktop shot of the same name
  // collide on one path, and whichever project runs second silently overwrites the other's
  // comparison target.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    // Locally, attach to the dev server you already have running. In CI there is nothing to
    // reuse, and silently adopting a stray process on 5199 would test the wrong build.
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
