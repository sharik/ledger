import type { Account, BalanceSnapshot, Budget, Goal, Transaction, Vault } from '../../src/model/types'
import { emptyVault } from '../../src/model/seed'
import { now, uuidv7 } from '../../src/model/clock'

export function buildVault(mut?: (v: Vault) => void): Vault {
  const v = emptyVault()
  mut?.(v)
  return v
}

export function catId(v: Vault, name: string): string {
  const c = v.categories.find((c) => c.name === name)
  if (!c) throw new Error(`no category ${name}`)
  return c.id
}

export function acc(v: Vault, partial: Partial<Account> & { name: string }): Account {
  const a: Account = { id: uuidv7(), updatedAt: now(), liab: false, liquid: false, ...partial }
  v.accounts.push(a)
  return a
}

export function snap(v: Vault, accountId: string, date: string, amount: number, createdAt?: string): BalanceSnapshot {
  const s: BalanceSnapshot = { id: uuidv7(), updatedAt: now(), accountId, date, amount, createdAt: createdAt ?? now() }
  v.snapshots.push(s)
  return s
}

export function txn(v: Vault, date: string, merchant: string, cat: string, amount: number): Transaction {
  const t: Transaction = { id: uuidv7(), updatedAt: now(), date, merchant, categoryId: catId(v, cat), amount }
  v.transactions.push(t)
  return t
}

export function budget(v: Vault, cat: string, amount: number, fixed?: boolean): Budget {
  const b: Budget = { id: uuidv7(), updatedAt: now(), categoryId: catId(v, cat), amount, fixed }
  v.budgets.push(b)
  return b
}

export function goal(v: Vault, partial: Partial<Goal> & { name: string; target: number; saved: number; monthly: number }): Goal {
  const g: Goal = { id: uuidv7(), updatedAt: now(), ...partial }
  v.goals.push(g)
  return g
}
