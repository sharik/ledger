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
docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.61.1-noble \
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

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. Scopes follow the codebase: `import`, `sync`, `analytics`, `assistant`, `ui`, `persist`,
`model`, `e2e`, `deps`. Breaking changes take a `!` or a `BREAKING CHANGE:` footer.

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

## Releases

Maintainer only. [release-please](https://github.com/googleapis/release-please) reads Conventional
Commits on `main` and keeps a release PR open with the next version and changelog. Merging that PR
tags the release and deploys to GitHub Pages in the same workflow run.
