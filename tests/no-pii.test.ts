import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The repo is public. No real surname — the author's or anyone else's — and no real IBAN, RIB,
 * account number or card number may appear in it: not in source, not in the demo vault every user
 * sees, not in fixtures, not in docs.
 *
 * A plain denylist cannot enforce that, because the denylist would itself publish the names it
 * exists to remove. So this runs two checks that need no secret to state:
 *
 *   1. SHAPE. Anything that looks like a financial identifier fails, whatever its value. This
 *      catches identifiers nobody thought to list, including ones added later.
 *   2. HASH. `sha256` of each real surname, lowercased. A reader learns nothing from a digest,
 *      but a regression still fails the build. The plaintext lives in gitignored
 *      `docs/examples/scrub-names.json`, beside the statements the names came from.
 *
 * Fixture binaries (.xlsx/.pdf) are scanned as raw bytes, which is best-effort — a compressed
 * archive can hide a string from this. The real coverage for them is the committed `*.parsed.json`
 * / `*.normalized.json` goldens, which ARE scanned and contain everything the adapters read out.
 */

const SURNAME_HASHES = new Set([
  '10b66e2bd553d4f4eda3427d4988a830c60860a8a025f7dbb7e61cc75d7f63a8',
  '1950bc89dfe3812b941fae5b348193a75b355d7a1840ee1ed9f207579ef6494e',
  '2df2e7308e292cb587457fc26cd8e055614fce048aa5ae817d06ffc9194bdeb6',
  '3e549808fc922a11d5e0072acf2fef34ab36ba398c2725625743167245c829b2',
  '42918bcc531588a6ba0387bc1ddc30176c08c390532074a8685f118bdea05a48',
  '7438506e544c7a645983130da115d55d974644f0513c6e257cac4a4f2c90e745',
  '8e518a7ee7a9e6504b9b093ef73ee6c191e3bb3a96b1590f06508e6e40c0c3f6',
  'a52ed50b233ea5292a257cbf9d6a8af2fd2d7aa2c44d0a36d14d99bef796b269',
  'cc7d9553c6a70be8cbd47d606a9f21f46becaf184ea9fcb1da24092a47bd07e6',
  'd92b6a8c0b50ec2006da77edb6f27450ad3a350fc1c83aef4adb8f4a44fd9932',
  'e9675e79783c26a8a1d5cb049d80d3fec6a0117fadeb4ffa06585ad63f0009ba',
  'eff4ef2e2125d943c886491c94e46d511469223135a63e538158ca94b1c47bb0',
  'f53460b9de6984cf22b7b59a4840990274e365af78c4c96d80159123c11e2874',
  'fa3628e3bdad3d554242215a1b1cbc24eb8041cd4ac429491d8822476a7efc50',
  'facafee0eff6761fe2601fa85b54a90baa0a1fa1e6ff383d1dba2ceda7466452',
  'fdb01e74222f06ad3e2c201e152c9915631f5aa8a4c48792532bb8d680f20eac',
])

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * Shapes, not values. Each is anchored on the structure a real identifier has, so a fixture that
 * merely *looks* like one still fails — which is the point: a synthetic value that is
 * indistinguishable from a real one is not safe to publish either.
 */
const SHAPES: { name: string; re: RegExp }[] = [
  { name: 'IBAN', re: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/g },
  // French RIB: 5-digit bank + 5-digit branch + 11-char account + 2-digit key.
  { name: 'RIB', re: /\b\d{5}[ -]\d{5}[ -][A-Z0-9]{11}[ -]\d{2}\b/g },
  { name: 'long digit run', re: /\b\d{13,}\b/g },
]

/** A 13–19 digit run that satisfies Luhn is a card number, whatever else it might be. */
function luhnOk(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Lines that must keep an identifier-shaped string to do their job: the adapters' own detection
 * regexes, and the lookup query-scrubber that exists precisely to strip these. Each entry is
 * `path:substring` — narrow on purpose, so a new occurrence elsewhere still fails.
 */
const ALLOW: { file: string; contains: string }[] = [
  { file: 'src/import/lookup.ts', contains: 'IBAN' },
  { file: 'src/import/adapters/pumb.ts', contains: 'UA' },
  { file: 'src/import/adapters/bnp.ts', contains: 'RIB' },
  { file: 'tests/no-pii.test.ts', contains: '' },
]

/**
 * The one place the author's own name belongs: the copyright line. A licence needs a holder, and
 * naming them is the point of it — unlike a fixture or a demo vault, where a real name is only
 * ever an accident. Scoped to that single line so the check still fires everywhere else,
 * including elsewhere in the same file.
 */
const COPYRIGHT_LINE = /^Copyright \(C\) \d{4} /

const TEXT = /\.(ts|tsx|js|jsx|json|md|html|css|yml|yaml|csv|txt|example)$/
const BINARY_FIXTURE = /\.(xlsx|xls|pdf)$/

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
}

function allowed(file: string, line: string): boolean {
  return ALLOW.some((a) => file === a.file && (a.contains === '' || line.includes(a.contains)))
}

describe('no personal data in the repo', () => {
  const files = trackedFiles()

  it('finds tracked files to scan (the scan itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('src/model/seed.ts')
  })

  it('no real surname, in any tracked text file', () => {
    const hits: string[] = []
    for (const f of files.filter((f) => TEXT.test(f))) {
      const text = fs.readFileSync(f, 'utf8')
      text.split('\n').forEach((line, i) => {
        if (COPYRIGHT_LINE.test(line)) return
        for (const tok of line.match(/[A-Za-zÀ-ÿЀ-ӿ]{4,}/g) ?? []) {
          if (SURNAME_HASHES.has(sha256(tok.toLowerCase()))) hits.push(`${f}:${i + 1}`)
        }
      })
    }
    expect(hits).toEqual([])
  })

  it('no real surname in the fixture binaries', () => {
    const hits: string[] = []
    for (const f of files.filter((f) => BINARY_FIXTURE.test(f))) {
      // latin1 keeps every byte addressable as a character; Cyrillic will not survive it, which is
      // why the goldens above are the real net for those.
      for (const tok of fs.readFileSync(f).toString('latin1').match(/[A-Za-z]{4,}/g) ?? []) {
        if (SURNAME_HASHES.has(sha256(tok.toLowerCase()))) hits.push(`${f}: ${tok}`)
      }
    }
    expect(hits).toEqual([])
  })

  /**
   * Shipping code and published prose only. Tests and fixtures are excluded on purpose: parsing an
   * IBAN or a RIB is a thing this app *does*, so its suites must be free to write one down, and the
   * fixtures are machine-generated by `scripts/make-fixtures.ts`, which rewrites every digit run it
   * finds. Those files stay covered by the surname-hash checks above.
   */
  it('nothing shaped like an IBAN, RIB, card number or account number ships to users', () => {
    const shipped = (f: string) => f.startsWith('src/') || f.startsWith('docs/') || !f.includes('/')
    const hits: string[] = []
    for (const f of files.filter((f) => TEXT.test(f) && shipped(f))) {
      const text = fs.readFileSync(f, 'utf8')
      text.split('\n').forEach((line, i) => {
        if (allowed(f, line)) return
        for (const { name, re } of SHAPES) {
          for (const m of line.match(new RegExp(re.source, 'g')) ?? []) {
            const digits = m.replace(/\D/g, '')
            if (name === 'long digit run' && !(digits.length >= 13 && digits.length <= 19 && luhnOk(digits))) continue
            hits.push(`${f}:${i + 1} ${name} → ${m.trim()}`)
          }
        }
      })
    }
    expect(hits).toEqual([])
  })

  it('the real statements and their expectations are never tracked', () => {
    const leaked = files.filter((f) => f.startsWith('docs/examples/') && !f.endsWith('.example'))
    expect(leaked).toEqual([])
  })

  it('the demo vault every user sees carries no real identity', () => {
    const seed = fs.readFileSync(path.resolve('src/model/seed.ts'), 'utf8')
    for (const tok of seed.match(/[A-Za-zÀ-ÿЀ-ӿ]{4,}/g) ?? []) {
      expect(SURNAME_HASHES.has(sha256(tok.toLowerCase()))).toBe(false)
    }
    expect(seed).not.toMatch(/\b\d{5}[ -]\d{5}[ -][A-Z0-9]{11}[ -]\d{2}\b/)
  })
})
