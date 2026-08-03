# Ledger

**A personal finance tracker that keeps your finances on your device.**

Import the statements your bank already gives you, see where the money actually goes, and sync
across phone and laptop through your own Google Drive — encrypted, so the sync layer never sees
anything but ciphertext.

[![CI](https://github.com/sharik/ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/sharik/ledger/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**→ [Try it](https://sharik.github.io/ledger/)** — no signup, no account, nothing to install.

---

## What it does

- **Import** — BNP Paribas, Revolut, PrivatBank, PUMB and Monobank, in PDF, XLS/XLSX and CSV.
  Re-importing an overlapping statement does not duplicate anything.
- **Categorize** — rules you teach once and it applies thereafter, with a starter pack for common
  billers. Nothing is filed behind your back; you see every decision before it lands.
- **Analyze** — trends, period comparisons, merchant drill-downs, and plain-language explanations
  of what changed.
- **Plan** — budgets and goals, with pace measured against real spend.
- **Trips** — spending grouped by trip, with foreign-currency conversion.
- **Assistant** — optional. Ask questions about your own data using an AI provider *you* choose and
  a key *you* supply.

## Privacy

This is the part that shapes everything else.

- **No backend.** No server, no account, no telemetry. The app is a static bundle that runs
  entirely in your browser.
- **Encrypted on your device.** Your master password derives a key with Argon2id; the vault is
  sealed with AES-256-GCM. The password never leaves the device and is never stored — which also
  means **there is no password recovery**.
- **The sync layer only sees ciphertext.** Google Drive holds one opaque blob it cannot read.
- **No third-party requests.** Fonts are self-hosted; the app makes no network call you did not ask
  for, and it works offline.
- **Your AI key is yours.** If you use the assistant, the key lives in your encrypted vault and is
  sent only to the provider you picked — Anthropic, OpenAI, OpenRouter, or a local Ollama /
  LM Studio instance.

## Sync and browser support

| | Google Drive | Local vault file |
|---|:--:|:--:|
| Chrome / Edge / Chromium | ✅ | ✅ |
| Firefox / Safari | ✅ | ❌ |
| Phones | ✅ | ❌ |

Drive sync uses OAuth with the `drive.file` scope — the app can only touch files it created, never
the rest of your Drive.

Local-file sync needs the File System Access API, which only Chromium-based desktop browsers
implement. On Firefox and Safari you can open a vault file once, but it cannot be connected as a
sync remote, so **Drive is the sync path there**. The app feature-detects and says so rather than
offering a button that cannot work.

## Self-hosting

It is a static site — any host will do.

```sh
npm ci
npm run build     # → dist/
```

Serve `dist/` from anywhere. The base path is relative, so a subdirectory works with no
configuration.

Google Drive sync needs your own OAuth client:

```sh
cp .env.local.example .env.local   # then follow the console steps in that file
```

Without it the app builds and runs exactly the same, minus the Drive option.

## Development

```sh
npm install
npm run dev            # http://localhost:5173

npm test               # unit + integration (Vitest)
npm run test:e2e       # Playwright: desktop, mobile, small-mobile
npm run test:all       # typecheck + both
```

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening a PR, and
**[docs/architecture.md](docs/architecture.md)** / **[docs/sync.md](docs/sync.md)** for how it is
put together. Sync is the part most easily broken in ways tests do not catch — start there if you
are touching it.

## Known limitations

- **A first import from an unfamiliar bank lands mostly uncategorized.** The starter pack covers
  common French billers; outside it, the first statement arrives needing review. Rules you set are
  learned and applied from then on.
- No recurring-transaction automation, and no Dropbox/WebDAV adapters yet.
- Pre-1.0. The vault format is versioned and migrates forward automatically, but expect rough
  edges.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Oleksandr Melnykov

Licensed under the [GNU Affero General Public License v3.0](LICENSE). You may use, modify and
self-host this freely. If you run a modified version as a network service, you must publish your
source under the same license.
