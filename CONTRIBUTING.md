# Contributing to Ledger

Thanks for considering it. This document covers the things that are specific to this project —
the conventions, and the two or three places where a reasonable-looking change breaks something
quietly.

## The one rule that is not negotiable

**No real personal data enters this repository.** Not a real surname — yours or anyone else's —
and not a real IBAN, RIB, account number or card number. Not in source, not in the demo vault, not
in fixtures, not in test assertions, not in screenshots, not in an issue comment.

`tests/no-pii.test.ts` enforces this on every CI run. It checks for identifier *shapes* and for
hashes of known names, so it can fail your PR without the repo ever containing the values it is
looking for. If it fails, it is not a false positive to route around — replace the value.

When you file an issue, **do not paste a real statement**. Describe the shape of the problem, or
attach a file you have redacted yourself.

## Setup

```sh
npm install
npm run dev            # http://localhost:5173
```

Optional: `cp .env.local.example .env.local` to enable Google Drive sync locally. Nothing in the
test suite needs it.

## Tests

```sh
npm test               # Vitest — unit + integration, fast
npm run test:e2e       # Playwright — desktop, mobile (390px), mobile-sm (360px)
npm run test:all       # typecheck + both
```

`npm run test:live` is separate and opt-in: it calls a **real, paid** AI provider and needs a key in
`.env.test`. It is excluded from `test:all` and from CI. You will not normally run it.

A few things that surprise people:

- **CI reports fewer tests than your machine does.** Suites that need real bank statements are
  gated on files in the gitignored `docs/examples/` and skip when absent. That is by design, not a
  broken run.
- **e2e runs against the Vite dev server, not a production build.** The suite relies on hooks
  (`?kdf=test`, `?now=`, `?remote=test:`, `?drive=test:`) that are compiled out of production by
  `import.meta.env.DEV`. Please do not "fix" the config to serve `dist` — a separate smoke job
  covers the built artifact.

### Screenshots

Visual baselines live in `e2e/__screenshots__/<project>/` and are compared at a 2% pixel
tolerance. Font rendering differs between machines, so regenerate them in the same container CI
uses, never on your host:

```sh
# The tag must match the Playwright you have installed — CI reads it from the lockfile for the
# same reason, and a mismatched browser build renders differently enough to fail the comparison.
PW=$(node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version")
docker run --rm -v "$PWD":/w -w /w "mcr.microsoft.com/playwright:v${PW}-noble" \
  npx playwright test --update-snapshots
```

Update only the baselines your change actually affects (`-g` to narrow), and look at the resulting
PNGs before committing them.

### Fixtures

`tests/fixtures/` is generated, not hand-written. It is derived from real statements that never
enter git, by `scripts/make-fixtures.ts`, which rewrites names, account numbers and merchants
through a deterministic, length-preserving map — while holding amounts, dates and balances fixed so
its acceptance check can prove the rewrite did not disturb parsing.

You do not need real statements to work on this project. If you have your own and want to add an
institution, put them in `docs/examples/` (gitignored) and:

```sh
npm run fixtures:make      # rewrite identities → tests/fixtures/
npm run fixtures:goldens   # regenerate the parsed/normalized goldens
```

## Commits and pull requests

We use [Conventional Commits](https://www.conventionalcommits.org/) and squash-merge, so **the PR
title becomes the commit message** and is what CI lints:

```
feat(import): read PUMB card statements
fix(sync): keep the grant when a token refresh 5xxs
docs: explain the merge decision table
```

Types are checked and must be one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`. Breaking changes take a `!` or a `BREAKING CHANGE:` footer.

The scope is optional and not checked — name the area you touched (`import`, `sync`, `budgets`,
`trips`, `charts`, `assistant`, `deps`, …). The changelog groups by type, not scope, so the useful
thing is that it reads clearly, not that it matches a list.

Sign off your commits (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/). There is no CLA.

Keep PRs focused. A change that fixes a bug and also reformats a file is two PRs.

## Where to be careful

- **Money is integer minor units.** `amountMinor: -1815` is −€18.15. Never floats — balances have
  to reconcile exactly, and that reconciliation is what proves an import was read correctly.
- **Sync.** Read [docs/sync.md](docs/sync.md) first. The merge decision table is pinned by
  `tests/merge.decision-table.test.ts` and convergence by `tests/sync.property.test.ts`. If your
  change makes those fail, change them deliberately and explain why in the PR — they are not tests
  to make green.
- **Adapters must be deterministic.** Parsing a file twice must produce identical rows and
  identical hashes, because those hashes are what stop a re-imported statement from duplicating.
- **Migrations must be deterministic too.** Two devices migrating the same vault independently must
  produce identical records, ids included. See [docs/architecture.md](docs/architecture.md).

## Dependencies

Dependabot proposes weekly updates and CI decides them, so most of this takes care of itself. One
dependency is different and needs a person.

**`xlsx` does not come from npm.** SheetJS stopped publishing there after 0.18.5, and that version
carries two advisories — prototype pollution ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6))
and a ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)) — which the
registry copy will carry forever. Releases live on `cdn.sheetjs.com` instead, and `package.json`
points at a tarball there.

The consequence worth knowing: **Dependabot cannot see it and `npm audit` will not warn about it.**
No tooling watches this one. To check and bump it:

```sh
# what is available: https://cdn.sheetjs.com/
npm install "https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz"
npm test          # the golden fixtures are the proof — see below
```

The golden tests are what make such a bump safe to trust: they assert byte-exact parse output for
every committed fixture across the four institutions that have them, so a version that reads files
differently
fails immediately rather than silently changing what people's statements mean. The lockfile still
records an integrity hash, so `npm ci` verifies the tarball as it would any registry package.

## Releases

Maintainer only. [release-please](https://github.com/googleapis/release-please) reads Conventional
Commits on `main` and keeps a release PR open with the next version and changelog. Merging that PR
tags the release and deploys to GitHub Pages in the same workflow run.
