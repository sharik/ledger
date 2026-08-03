import type {
  Account,
  Category,
  SavedComparison,
  StatementRecord,
  Tracking,
  TrackingAssignment,
  Transaction,
  Vault,
} from './types'
import { CAT_HOUSING, CAT_TRANSFERS, SCHEMA_VERSION } from './types'
import { SEED_CATEGORIES } from './categories'
import { now, uuidv7 } from './clock'
import { addMonths, currentMonthKey, round2 } from './selectors'

/**
 * Deterministic demo dataset for the Ledger analytics design. Anchored to the
 * current month (via clock.now(), so ?now= fixes it). It synthesizes a coherent
 * EUR household — two imported bank accounts (BNP joint, Revolut), a Livret A and
 * a mortgage — with 24 months of categorized, import-provenanced transactions,
 * balance snapshots for the net-worth series, three trips with curation, two
 * balance-linked goals, five budgets, two pinned comparisons and a couple of
 * unreviewed notes. Numbers are illustrative, not the real statements.
 */

const HISTORY_MONTHS = 18

interface AcctSpec {
  key: string
  name: string
  institution: string
  institutionId?: string
  last4?: string
  fingerprint?: string
  currency?: string
  liab: boolean
  liquid: boolean
  apr?: number
  monthlyPayment?: number
  startBal: number // balance 24 months ago
  endBal: number // balance now
}

const ACCOUNTS: AcctSpec[] = [
  { key: 'bnp', name: 'BNP Joint', institution: 'BNP Paribas', institutionId: 'bnp', last4: '4242',
    fingerprint: 'bnp:demo-current', currency: 'EUR', liab: false, liquid: true, startBal: 5800, endBal: 8450 },
  { key: 'rev', name: 'Revolut · EUR', institution: 'Revolut', institutionId: 'revolut',
    fingerprint: 'revolut:current:eur', currency: 'EUR', liab: false, liquid: true, startBal: 1600, endBal: 2372.54 },
  { key: 'livret', name: 'Livret A', institution: 'BNP Paribas', liab: false, liquid: true, startBal: 24500, endBal: 35000 },
  { key: 'mortgage', name: 'Mortgage', institution: 'BNP Paribas', liab: true, liquid: false, apr: 1.7,
    monthlyPayment: 980, startBal: 55600, endBal: 44000 },
]

const BUDGETS: [string, number, boolean][] = [
  ['Groceries', 560, false],
  ['Dining out', 320, false],
  ['Transport', 200, false],
  ['Shopping', 260, false],
]

// Per-category monthly expense bases (EUR), varied per month via hash01.
const CAT_BASES: [string, string[], number][] = [
  ['Groceries', ['Carrefour', 'Monoprix'], 545],
  ['Dining out', ['Le Comptoir', 'Big Mamma'], 305],
  ['Shopping', ['Uniqlo', 'Zalando'], 245],
  ['Transport', ['Île-de-France Mobilités', 'TotalEnergies'], 185],
]

// Current-month (MTD) transactions: [day, merchant, category, amount, accountKey].
const MTD_TXNS: [number, string, string, number, string][] = [
  [1, 'Salaire DURAND', 'Income', 3000, 'bnp'],
  [3, 'BNP Immobilier', 'Housing', -980, 'bnp'],
  [3, 'Carrefour', 'Groceries', -132.4, 'bnp'],
  [4, 'Zalando', 'Shopping', -78.3, 'rev'],
  [5, 'Le Comptoir', 'Dining out', -64.5, 'rev'],
  [6, 'Île-de-France Mobilités', 'Transport', -75.2, 'bnp'],
  [7, 'Monoprix', 'Groceries', -58.1, 'bnp'],
  [8, 'Netflix', 'Entertainment', -13.49, 'rev'],
  [9, 'Big Mamma', 'Dining out', -88.0, 'rev'],
  [10, 'Spotify', 'Entertainment', -11.99, 'rev'],
  [11, 'Uniqlo', 'Shopping', -49.9, 'bnp'],
  [12, 'TotalEnergies', 'Transport', -61.3, 'bnp'],
]

// 24 months of net (income, expense) totals, oldest first, tuned around the bases.
const FLOWS: [number, number][] = Array.from({ length: HISTORY_MONTHS }, (_, i) => {
  const income = i < 12 ? 5600 : 5800
  const expense = round2(4550 + 380 * hash01(`flow-${i}`) + (i % 6 === 3 ? 620 : 0))
  return [income, expense] as [number, number]
})

export function hash01(str: string): number {
  let h = 0
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 997
  return h / 997
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function emptyVault(): Vault {
  const t = now()
  return {
    schema: SCHEMA_VERSION,
    vaultId: uuidv7(),
    createdAt: t,
    accounts: [],
    snapshots: [],
    transactions: [],
    // From the canonical table (fixed ids + roles) — born identical to a migrated vault (Convention #4).
    categories: SEED_CATEGORIES.map((c) => ({ id: c.id, updatedAt: t, name: c.name, color: c.color, role: c.role })),
    budgets: [],
    goals: [],
    statements: [],
    rules: [],
    fxOverrides: [],
    trackings: [],
    trackingAssignments: [],
    savedComparisons: [],
    pinnedWidgets: [],
    skills: [],
    params: { id: 'params', updatedAt: t, invReturn: 5, inflation: 2.5, srTarget: 20, efTarget: 6, baseCurrency: 'EUR', reconTolerance: 1.0 },
    settings: { id: 'settings', updatedAt: t, saveMode: 'onChange' },
    tombstones: [],
    syncNotes: [],
  }
}

export function seedVault(): Vault {
  const vault = emptyVault()
  const t = now()
  const cm = currentMonthKey()
  const today = nowDay()
  const catId = new Map(vault.categories.map((c: Category) => [c.name, c.id]))

  // --- accounts ---
  const accById = new Map<string, Account>()
  vault.accounts = ACCOUNTS.map((a) => {
    const acc: Account = {
      id: uuidv7(), updatedAt: t, name: a.name, institution: a.institution, last4: a.last4,
      liab: a.liab, liquid: a.liquid, apr: a.apr, monthlyPayment: a.monthlyPayment,
      institutionId: a.institutionId, fingerprint: a.fingerprint, currency: a.currency,
    }
    accById.set(a.key, acc)
    return acc
  })
  const acc = (key: string) => accById.get(key)!.id

  // --- statements: establish "data through 12 Jul" on the imported accounts ---
  const periodTo = `${cm}-${pad2(Math.min(28, today))}`
  const mkStatement = (key: string, from: string, opening: number, closing: number): StatementRecord => ({
    id: uuidv7(), updatedAt: t, accountId: acc(key),
    institutionId: ACCOUNTS.find((a) => a.key === key)!.institutionId!, variant: key === 'bnp' ? 'pdf' : 'xlsx',
    fileName: key === 'bnp' ? 'releve.pdf' : 'account-statement.xlsx', fileHash: `sha-${key}`,
    periodFrom: from, periodTo, openingBalance: opening, closingBalance: closing,
    rowsTotal: 120, rowsImported: 118, rowsSkipped: { duplicate: 2, pending: 0, reverted: 0, unparsed: 0 }, importedAt: t,
  })
  vault.statements = [
    mkStatement('bnp', addMonths(cm, -1) + '-13', 7900, specOf('bnp').endBal),
    mkStatement('rev', addMonths(cm, -2) + '-01', 703.55, specOf('rev').endBal),
  ]

  // --- snapshots: month-end interpolation + exact current balances ---
  for (let i = HISTORY_MONTHS; i >= 1; i--) {
    const mk = addMonths(cm, -i)
    const frac = (HISTORY_MONTHS - i) / HISTORY_MONTHS
    for (const a of ACCOUNTS) {
      const amount = round2(a.startBal + (a.endBal - a.startBal) * frac)
      vault.snapshots.push({
        id: uuidv7(), updatedAt: t, accountId: acc(a.key), date: `${mk}-28`, amount, createdAt: t,
        origin: a.institutionId ? { kind: 'anchor', statementId: vault.statements.find((s) => s.accountId === acc(a.key))!.id } : { kind: 'manual' },
      })
    }
  }
  for (const a of ACCOUNTS) {
    vault.snapshots.push({
      id: uuidv7(), updatedAt: t, accountId: acc(a.key), date: `${cm}-${pad2(Math.min(28, today))}`,
      amount: a.endBal, createdAt: t, origin: a.institutionId ? { kind: 'anchor', statementId: vault.statements.find((s) => s.accountId === acc(a.key))!.id } : { kind: 'manual' },
    })
  }

  // --- historical + current transactions ---
  const txns: Transaction[] = []
  let hashN = 0
  const addTxn = (date: string, merchant: string, cat: string, amount: number, accKey: string): Transaction => {
    const tx: Transaction = {
      id: uuidv7(), updatedAt: t, date, merchant, categoryId: catId.get(cat)!, amount: round2(amount),
      accountId: acc(accKey), currency: 'EUR',
      importMeta: { hash: `seed-${hashN++}`, source: accKey, statementId: vault.statements.find((s) => s.accountId === acc(accKey))?.id },
    }
    txns.push(tx)
    return tx
  }

  FLOWS.forEach(([inc, exp], i) => {
    const mk = addMonths(cm, i - HISTORY_MONTHS)
    // income → BNP (two salaries)
    const p1 = Math.round(inc * 0.52)
    addTxn(`${mk}-01`, 'Salaire DURAND', 'Income', p1, 'bnp')
    addTxn(`${mk}-15`, 'Salaire MARTIN', 'Income', inc - p1, 'bnp')
    // mortgage payment (Housing)
    addTxn(`${mk}-05`, 'BNP Immobilier', 'Housing', -980, 'bnp')
    let spent = 980
    CAT_BASES.forEach(([cat, merchants, base], ci) => {
      const total = round2(base * (0.85 + 0.3 * hash01(mk + cat)))
      const split = round2(total * (0.4 + 0.25 * hash01(mk + cat + 'x')))
      const k0 = ci % 2 === 0 ? 'bnp' : 'rev'
      addTxn(`${mk}-${pad2(3 + ci * 2)}`, merchants[0]!, cat, -split, k0)
      addTxn(`${mk}-${pad2((12 + ci * 3) % 28 || 28)}`, merchants[1]!, cat, -round2(total - split), k0 === 'bnp' ? 'rev' : 'bnp')
      spent += total
    })
    // fixed monthly-recurring debits — now filed under their real category, flagged recurring
    addTxn(`${mk}-08`, 'Netflix', 'Entertainment', -13.49, 'rev').recurring = 'monthly'
    addTxn(`${mk}-10`, 'Spotify', 'Entertainment', -11.99, 'rev').recurring = 'monthly'
    addTxn(`${mk}-12`, 'Free Mobile', 'Utilities', -19.99, 'bnp').recurring = 'monthly'
    spent += 45.47
    // balancer so the month's expense equals FLOWS exactly (day varies → not recurring)
    addTxn(`${mk}-${pad2(17 + Math.floor(hash01(mk + 'bal') * 9))}`, 'Divers', 'Other', -round2(exp - spent), 'bnp')
  })

  // current month (MTD)
  for (const [day, merchant, cat, amount, accKey] of MTD_TXNS) {
    if (day > today) continue
    const tx = addTxn(`${cm}-${pad2(day)}`, merchant, cat, amount, accKey)
    if (merchant === 'Netflix' || merchant === 'Spotify') tx.recurring = 'monthly'
  }
  if (today >= 15) addTxn(`${cm}-15`, 'Salaire MARTIN', 'Income', 2800, 'bnp')

  // --- trip transactions (in-window, so trackings auto-capture them) ---
  const tripTxns = (mk: string, day: number, rows: [string, string, number, string][]) =>
    rows.forEach(([m, c, a, k], j) => addTxn(`${mk}-${pad2(day + j)}`, m, c, a, k))
  tripTxns('2024-10', 6, [
    ['LOT Polish Airlines', 'Travel', -212.0, 'rev'],
    ['Hotel Kraków', 'Travel', -318.4, 'rev'],
    ['Restauracja Pod Aniołami', 'Dining out', -96.5, 'rev'],
  ])
  tripTxns('2025-04', 22, [
    ['ANA Airways', 'Travel', -742.0, 'rev'],
    ['Tokyo Capsule Hotel', 'Travel', -410.0, 'rev'],
    ['Ichiran Ramen', 'Dining out', -58.2, 'rev'],
  ])
  tripTxns('2026-06', 11, [
    ['Ryanair', 'Travel', -164.0, 'rev'],
    ['Airbnb Warszawa', 'Travel', -286.0, 'rev'],
    ['Zapiecek', 'Dining out', -71.4, 'rev'],
  ])
  vault.transactions = txns

  // --- trackings + assignments ---
  const trips: [string, string, string][] = [
    ['Poland · Oct 2024', '2024-10-05', '2024-10-16'],
    ['Japan · Apr 2025', '2025-04-21', '2025-05-05'],
    ['Poland · Jun 2026', '2026-06-10', '2026-06-18'],
  ]
  const trackings: Tracking[] = trips.map(([name, dateFrom, dateTo], i) => ({
    id: uuidv7(), updatedAt: t, name, kind: 'trip', color: ['var(--cmpa)', 'var(--cmpb)', 'var(--c-rest)'][i], dateFrom, dateTo,
  }))
  vault.trackings = trackings
  // one curation exclude: the recurring subscription that fell inside the Jun 2026
  // window is a home bill, not trip spend (demonstrates ANALYTICS §3 excludes).
  const junTrip = trackings[2]!
  const subInWindow = txns.find(
    (x) => x.merchant === 'Free Mobile' && x.date >= junTrip.dateFrom! && x.date <= junTrip.dateTo!,
  )
  const assignments: TrackingAssignment[] = []
  if (subInWindow) {
    assignments.push({ id: uuidv7(), updatedAt: t, trackingId: junTrip.id, txnId: subInWindow.id, dir: 'exclude' })
  }
  vault.trackingAssignments = assignments

  // --- budgets ---
  vault.budgets = BUDGETS.map(([cat, amount, fixed]) => ({
    id: uuidv7(), updatedAt: t, categoryId: catId.get(cat)!, amount, fixed: fixed || undefined,
  }))
  // A cross-category recurring budget (replaces the old "Subscriptions" category budget).
  // Housing is excluded so the recurring mortgage doesn't swell the subscriptions total.
  vault.budgets.push({
    id: uuidv7(), updatedAt: t, categoryId: CAT_TRANSFERS, amount: 70, fixed: true,
    scope: { kind: 'recurring', cadence: 'monthly', excludeCategoryIds: [CAT_HOUSING] },
  })

  // --- goals: balance-linked (emergency fund up, mortgage payoff down) + one legacy ---
  vault.goals = [
    { id: uuidv7(), updatedAt: t, name: 'Emergency fund', target: 40000, saved: 0, monthly: 0,
      source: { kind: 'balance', accountId: acc('livret'), direction: 'up', target: 40000 } },
    { id: uuidv7(), updatedAt: t, name: 'Mortgage payoff', target: 0, saved: 0, monthly: 0,
      source: { kind: 'balance', accountId: acc('mortgage'), direction: 'down', target: 0 } },
    { id: uuidv7(), updatedAt: t, name: 'New kitchen', target: 8000, saved: 3200, monthly: 400 },
  ]

  // --- pinned comparisons: this-vs-last month + a Dining-out watch ---
  const compA: SavedComparison = {
    id: uuidv7(), updatedAt: t, name: 'This vs last month',
    selections: [{ period: { rel: 'thisMonth' } }, { period: { rel: 'lastMonth' } }],
    normalize: 'total', pinned: true, order: 0,
  }
  const compB: SavedComparison = {
    id: uuidv7(), updatedAt: t, name: 'Dining out',
    selections: [{ period: { rel: 'thisMonth' }, categoryIds: [catId.get('Dining out')!] }],
    pinned: true, order: 1,
  }
  vault.savedComparisons = [compA, compB]

  // --- two unreviewed notes (the "2 NOTES" chip) ---
  vault.syncNotes = [
    { id: uuidv7(), createdAt: t, collection: 'statements', recordId: vault.statements[0]!.id,
      recordLabel: 'releve.pdf', keptFrom: 'local', keptAt: t, discardedAt: t, kind: 'stmt-gap' },
    { id: uuidv7(), createdAt: t, collection: 'budgets', recordId: vault.budgets[0]!.id,
      recordLabel: 'Groceries budget', field: 'amount', keptValue: 560, discardedValue: 520,
      keptFrom: 'local', keptAt: t, discardedAt: t, kind: 'dup-budget' },
  ]

  return vault
}

// ---- helpers ----

function specOf(key: string): AcctSpec {
  return ACCOUNTS.find((a) => a.key === key)!
}

function nowDay(): number {
  return Number(now().slice(8, 10))
}

export const SEED_HISTORY_MONTHS = HISTORY_MONTHS
export const SEED_FLOWS = FLOWS
