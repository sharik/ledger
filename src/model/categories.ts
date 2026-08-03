// The canonical category taxonomy (Lean 14, Plaid-informed). Single source of truth
// shared by emptyVault (new vaults) and the schema 3→4 migration (existing vaults), so
// the two can never drift. Ids are fixed constants (Convention #4) so a migration mints
// deterministic records; new-vault seeding reuses the same ids harmlessly (a fresh vault
// runs the seed once). `role` marks the four categories that carry special logic, keyed
// off the role rather than the display name so names stay free to rename/localize.
import {
  CAT_TRANSFERS,
  CAT_INCOME,
  CAT_HOUSING,
  CAT_OTHER,
  CAT_UTILITIES,
  CAT_TRAVEL,
  CAT_HEALTH,
  CAT_ENTERTAINMENT,
  CAT_INSURANCE,
  CAT_TAXES_FEES,
  type CategoryRole,
} from './types'

export interface SeedCategory {
  id: string
  name: string
  color: string
  role?: CategoryRole
}

/** The 14 categories every vault gets. Spending buckets first, then Income/Other/Transfers. */
export const SEED_CATEGORIES: SeedCategory[] = [
  { id: CAT_HOUSING, name: 'Housing', color: 'var(--c-house)', role: 'housing' },
  { id: CAT_UTILITIES, name: 'Utilities', color: 'var(--c-util)' },
  { id: 'cat-groceries', name: 'Groceries', color: 'var(--c-groc)' },
  { id: 'cat-dining', name: 'Dining out', color: 'var(--c-rest)' },
  { id: 'cat-transport', name: 'Transport', color: 'var(--c-trans)' },
  { id: CAT_TRAVEL, name: 'Travel', color: 'var(--c-travel)' },
  { id: 'cat-shopping', name: 'Shopping', color: 'var(--c-shop)' },
  { id: CAT_HEALTH, name: 'Health', color: 'var(--c-health)' },
  { id: CAT_ENTERTAINMENT, name: 'Entertainment', color: 'var(--c-ent)' },
  { id: CAT_INSURANCE, name: 'Insurance', color: 'var(--c-ins)' },
  { id: CAT_TAXES_FEES, name: 'Taxes & fees', color: 'var(--c-tax)' },
  { id: CAT_INCOME, name: 'Income', color: 'var(--pos)', role: 'income' },
  { id: CAT_OTHER, name: 'Other', color: 'var(--c-other)', role: 'other' },
  { id: CAT_TRANSFERS, name: 'Transfers', color: 'var(--c-other)', role: 'transfers' },
]
