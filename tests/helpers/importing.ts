import fs from 'node:fs'
import path from 'node:path'
import type { Vault } from '../../src/model/types'
import { applyOp } from '../../src/model/mutations'
import { toSourceFile } from '../../src/import/peek'
import { buildImportPlan, planToOp, type ImportChoices } from '../../src/import/pipeline'
import { isRefusal, type ImportPlan, type Refusal, type RowDecision, type SourceFile } from '../../src/import/types'

export const REAL_DIR = path.resolve('docs/examples')
export const FIXTURE_DIR = path.resolve('tests/fixtures')

export const REAL = {
  f1: path.join(REAL_DIR, 'revolut/account-statement_2026-02-04_2026-06-11_en-gb_e94930.xlsx'),
  f2: path.join(REAL_DIR, 'revolut/account-statement_2026-05-01_2026-07-09_en-gb_ebb571.xlsx'),
  b2024: path.join(REAL_DIR, 'pariba/releve_ZZ1H99UNONO4S0FYB_260709_153217.pdf'),
  b2026: path.join(REAL_DIR, 'pariba/releve_ZZ1KNGXG64KMFYEIV_260709_153132.pdf'),
  bxls: path.join(REAL_DIR, 'pariba/export_24_07_2026_22_07_45.xls'),
  // Livret A passbook — same bank, branch and holder as b2024/b2026, different account number.
  blva: path.join(REAL_DIR, 'pariba/RLV_LVA_2023-07-13.pdf'),
  // 2023-vintage mabanque export: unmasked preamble number, no year after `DU`, `VIREMENT VERS`
  // without `EMIS`. Same account (…2101) as a later export, so it also pins account binding.
  bxls2023: path.join(REAL_DIR, 'pariba/export_2023-06-10.xls'),
  // PrivatBank card exports. `privat24.csv` is TAB-delimited despite the name, and carries two
  // cards; the xlsx carries one, restating an earlier period of the same card as the csv's first.
  privatCsv: path.join(REAL_DIR, 'privat/privat24.csv'),
  privatXlsx: path.join(REAL_DIR, 'privat/privat-uah.xlsx'),
  // PUMB card-account statement (PDF). One IBAN, two cards, Feb 2025; prints its own opening and
  // closing balance plus both period totals, so it reconciles twice over.
  pumb: path.join(REAL_DIR, 'pumb/statement_17513756414081390631600654988633.pdf'),
  // Monobank card export. Comma-delimited, NEWEST FIRST, and the only identity it carries is the
  // account currency printed inside a header cell.
  mono: path.join(REAL_DIR, 'monobank/mono-white.csv'),
}

export function loadFile(p: string, name?: string): SourceFile {
  return toSourceFile(name ?? path.basename(p), new Uint8Array(fs.readFileSync(p)))
}

/**
 * Values a real statement asserts on: the holder's surname, the account number, the masked tail.
 * They live beside the files they describe, in gitignored `docs/examples/`, because committing
 * them would publish exactly what that gitignore exists to keep out. See `expectations.json.example`.
 */
export interface RealExpectations {
  /** Compte chèques fingerprint, e.g. `bnp:xxxxx-xxxxx-xxxxxxxxxxx-xx`. */
  rib: string
  /** Livret A fingerprint — same bank, branch and holder, different account number. */
  livretRib: string
  /** Masked tail the mabanque XLS export carries instead of a RIB. */
  mask: string
  /** Holder surname as it appears in a `VIR /DE` transfer-in. */
  holder: string
  /** Beneficiary surname in an `EMIS /BEN` transfer-out. */
  beneficiary: string
  /** Motif tokens that must NEVER be read as the counterparty (regex alternation). */
  motif: string
  /** Suggested account name for the Livret A passbook. */
  livretAccountName: string
  /** Suggested account name for the PUMB statement. */
  pumbAccountName: string
}

export function realExpect(): RealExpectations | null {
  const p = path.join(REAL_DIR, 'expectations.json')
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as RealExpectations) : null
}

/** Inside a `haveReal()`-gated suite the file is guaranteed present, so this cannot throw. */
export function expectations(): RealExpectations {
  const e = realExpect()
  if (!e) throw new Error('docs/examples/expectations.json is missing — see expectations.json.example')
  return e
}

export function haveReal(): boolean {
  return fs.existsSync(REAL.f1) && fs.existsSync(REAL.b2024) && realExpect() !== null
}

/** Gate a suite on its own inputs. `docs/examples` is gitignored and files land in it over
 *  time, so a checkout can be missing any individual one. */
export function have(...paths: string[]): boolean {
  return paths.every((p) => fs.existsSync(p))
}

export async function planFor(vault: Vault, file: SourceFile, choices?: ImportChoices): Promise<ImportPlan | Refusal> {
  return buildImportPlan(file, vault, choices)
}

export interface ImportOutcome {
  vault: Vault
  plan: ImportPlan
}

/** Build a plan and commit it in one shot; throws if the pipeline refuses. */
export async function importFile(
  vault: Vault,
  file: SourceFile,
  choices?: ImportChoices,
  decisions?: RowDecision[],
): Promise<ImportOutcome> {
  const plan = await buildImportPlan(file, vault, choices)
  if (isRefusal(plan)) throw new Error(`refused: ${plan.refusal} — ${plan.message}`)
  const op = planToOp(plan, decisions)
  const { vault: next } = applyOp(vault, op)
  return { vault: next, plan }
}

/** Strip volatile ids so two independently-imported vaults can be compared (§5.3). */
export function stripIds(vault: Vault): unknown {
  const clean = <T extends { id: string; updatedAt: string }>(arr: T[], keys: (keyof T)[]) =>
    arr
      .map((r) => {
        const o: Record<string, unknown> = {}
        for (const k of keys) o[k as string] = r[k]
        return o
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    transactions: clean(vault.transactions, ['date', 'merchant', 'amount', 'accountId', 'categoryId'] as never).length,
    txnHashes: vault.transactions
      .map((t) => t.importMeta?.hash)
      .filter(Boolean)
      .sort(),
    snapshots: vault.snapshots.map((s) => `${s.date}|${s.amount}`).sort(),
    statements: vault.statements.map((s) => `${s.fileHash}|${s.rowsImported}`).sort(),
  }
}
