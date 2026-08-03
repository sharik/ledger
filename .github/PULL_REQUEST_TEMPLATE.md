## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one: Closes #123 -->

## How it was verified

<!-- What you actually ran or clicked. "npm run test:all passes" plus anything manual. -->

## Checklist

- [ ] **No real personal data** — no real surname, account number, IBAN, card number or statement
      content in code, fixtures, tests or screenshots. (`tests/no-pii.test.ts` checks this.)
- [ ] Tests cover the change, and `npm run test:all` passes.
- [ ] Visual baselines regenerated **in the Playwright container** if the UI changed
      (see CONTRIBUTING.md), and the resulting PNGs were looked at.
- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) — it becomes
      the commit message on squash-merge.
- [ ] Commits signed off (`git commit -s`).

<!--
If you changed src/sync/, say so here and explain the reasoning. The merge decision table and the
convergence property test are load-bearing; they are not tests to make green.
-->
