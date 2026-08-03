# Security Policy

Ledger holds people's financial records and encrypts them with a password only they know. Security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. That
opens a draft advisory visible only to you and the maintainer.

Please include what you were able to do, how to reproduce it, and the browser and version. If a
proof of concept involves a statement file, **redact it first** — see the data rule in
[CONTRIBUTING.md](CONTRIBUTING.md).

You can expect an acknowledgement within a few days. This is a small project maintained in spare
time, so please allow reasonable time for a fix before disclosing publicly.

## Supported versions

The latest release, and the deployed site at <https://sharik.github.io/ledger/>. There are no
maintained older branches.

## What is in scope

The interesting surface, given there is no backend:

- **Crypto and key handling** — Argon2id parameters, AES-256-GCM usage, anything that could weaken
  the vault or leak the key or password.
- **Plaintext leaving the device** — any path where unencrypted vault content reaches the network,
  `localStorage`, a URL, or a log.
- **Sync** — anything that could corrupt or destroy a vault, defeat the compare-and-swap guard, or
  let one device silently overwrite another's data.
- **The Google Drive integration** — OAuth handling, token storage, scope escalation beyond
  `drive.file`.
- **The assistant** — an AI provider key reaching anywhere other than the provider the user chose,
  or vault content being sent that the user did not ask to send.
- **XSS and injection** — particularly via imported statement content, which is untrusted input
  rendered back to the user.

## Known and accepted

Stated here so they are not reported as findings:

- **There is no password recovery.** The password is never stored or transmitted. Losing it means
  losing the vault. This is the design, not a defect.
- **The Google OAuth client secret ships in the bundle.** A browser client cannot keep a secret;
  this is Google's documented posture for public clients. What limits it is the registered redirect
  URI allowlist, and the grant it can produce reaches nothing but the `drive.file` files this app
  created.
- **The Drive access token is stored unencrypted in IndexedDB.** It must survive without the vault
  being unlocked. It grants access only to the ciphertext file this app created.
- **`connect-src` in the Content-Security-Policy is unrestricted.** The assistant lets users point
  at any OpenAI-compatible endpoint, including one on their own machine, so an allowlist would
  break a supported feature. Everything executable is locked down instead.
- **No `frame-ancestors`.** It is ignored when delivered via `<meta>`, and a static host cannot set
  response headers.
