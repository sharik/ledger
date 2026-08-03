import type { BalanceSnapshot, Goal, MonthKey, Transaction, Vault } from '../model/types'
import { addMonths, monthKeyOf, round2, vaultOnlyBook } from '../model/selectors'
import { members } from '../model/trackings'
import { addDays, daysBetween } from './selections'
import { rowConverter, type RateBook } from '../import/fx'

/** Row amount in base currency; null ⇒ no rate, the row is excluded honestly. */
type Conv = (t: Transaction) => number | null

export interface GoalStatus {
  kind: 'legacy' | 'flow' | 'balance'
  progress: number
  target: number
  fraction: number // 0..1+ (may exceed 1 when over)
  eta: MonthKey | null // null ⇒ no trajectory / not projectable
  note?: 'no-trajectory' | 'account-removed'
  asOf?: string // balance goals: the snapshot date driving progress
  snapshots?: number[] // balance goals: recent balances for a sparkline
}

/**
 * What a goal row can honestly claim.
 *
 * It replaces a two-way `eta ? 'on schedule' : 'behind'`, which called a goal "behind" whenever
 * no ETA could be computed — including a goal created ten seconds ago, one whose account has a
 * single snapshot, and one with no contribution set. Those are three kinds of "we cannot tell",
 * not evidence of falling behind. And "on schedule" is only meaningful against a target date;
 * without one there is no schedule to be on, just a projection.
 */
export type GoalState = 'done' | 'on-schedule' | 'behind' | 'projected' | 'unknown' | 'account-removed'

export function goalState(goal: Goal, st: GoalStatus): GoalState {
  if (st.note === 'account-removed') return 'account-removed'
  if (st.fraction >= 1) return 'done'
  if (st.eta == null) return 'unknown'
  if (goal.targetDate) return st.eta > goal.targetDate ? 'behind' : 'on-schedule'
  return 'projected'
}

/** ANALYTICS §6.1 — source-based progress & ETA. `saved` is ignored for balance goals. */
export function goalStatus(vault: Vault, goal: Goal, today: string, rates?: RateBook): GoalStatus {
  const cm = today.slice(0, 7)
  const src = goal.source

  if (!src) {
    const target = goal.target
    const progress = goal.saved
    const remaining = Math.max(0, target - progress)
    let eta: MonthKey | null = remaining === 0 ? cm : null
    if (remaining > 0 && goal.monthly > 0) eta = addMonths(cm, Math.ceil(remaining / goal.monthly))
    return { kind: 'legacy', progress, target, fraction: frac(progress, target), eta }
  }

  if (src.kind === 'flow') {
    const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
    const progress = flowProgress(vault, goal, today, conv)
    const target = goal.target
    const remaining = Math.max(0, target - progress)
    const monthlyPace = trailingFlowPace(vault, goal, today, conv)
    let eta: MonthKey | null = remaining === 0 ? cm : null
    if (remaining > 0 && monthlyPace > 0) eta = addMonths(cm, Math.ceil(remaining / monthlyPace))
    return { kind: 'flow', progress: round2(progress), target, fraction: frac(progress, target), eta }
  }

  // balance
  const account = vault.accounts.find((a) => a.id === src.accountId)
  const snaps = vault.snapshots
    .filter((s) => s.accountId === src.accountId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
  if (snaps.length === 0) {
    return { kind: 'balance', progress: 0, target: src.target, fraction: 0, eta: null, note: account ? undefined : 'account-removed' }
  }
  const latest = snaps[snaps.length - 1]!
  const progress = latest.amount
  const fraction =
    src.direction === 'up'
      ? frac(progress, src.target)
      : (() => {
          const start = snaps[0]!.amount // baseline for payoff progress
          const span = start - src.target
          return span > 0 ? clamp((start - progress) / span) : progress <= src.target ? 1 : 0
        })()
  const eta = balanceEta(snaps, src.direction, src.target)
  return {
    kind: 'balance',
    progress: round2(progress),
    target: src.target,
    fraction,
    eta,
    note: account ? (eta ? undefined : 'no-trajectory') : 'account-removed',
    asOf: latest.date,
    snapshots: snaps.slice(-8).map((s) => s.amount),
  }
}

function frac(progress: number, target: number): number {
  return target > 0 ? Math.max(0, progress / target) : 0
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/** Contribution = −amount in base (an outflow toward the goal is +progress; a refund nets out). */
function flowProgress(vault: Vault, goal: Goal, today: string, conv: Conv): number {
  const src = goal.source
  if (src?.kind !== 'flow') return 0
  let sum = 0
  const mem = src.trackingId ? members(src.trackingId, vault) : null
  for (const t of vault.transactions) {
    if (mem ? !mem.has(t.id) : !src.categoryId || t.categoryId !== src.categoryId) continue
    if (t.date > today) continue
    const amt = conv(t)
    if (amt !== null) sum += -amt
  }
  return sum
}

/** Mean monthly contribution over the trailing 3 complete months. */
function trailingFlowPace(vault: Vault, goal: Goal, today: string, conv: Conv): number {
  const src = goal.source
  if (src?.kind !== 'flow') return 0
  const cm = today.slice(0, 7)
  const window = new Set([addMonths(cm, -1), addMonths(cm, -2), addMonths(cm, -3)])
  const mem = src.trackingId ? members(src.trackingId, vault) : null
  let sum = 0
  for (const t of vault.transactions) {
    if (mem ? !mem.has(t.id) : t.categoryId !== src.categoryId) continue
    if (!window.has(monthKeyOf(t.date))) continue
    const amt = conv(t)
    if (amt !== null) sum += -amt
  }
  return sum / 3
}

/** Linear fit over the last 180 days of snapshots; ≥2 required and must trend toward target. */
function balanceEta(snaps: BalanceSnapshot[], direction: 'up' | 'down', target: number): MonthKey | null {
  const latest = snaps[snaps.length - 1]!
  const cutoff = addDays(latest.date, -180)
  const window = snaps.filter((s) => s.date >= cutoff)
  if (window.length < 2) return null
  const x0 = window[0]!.date
  const xs = window.map((s) => daysBetween(x0, s.date))
  const ys = window.map((s) => s.amount)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  if (den === 0) return null
  const slope = num / den // amount per day
  const towardTarget = direction === 'down' ? slope < 0 && target < latest.amount : slope > 0 && target > latest.amount
  if (!towardTarget) return null
  const daysToTarget = (target - latest.amount) / slope
  if (!(daysToTarget > 0) || !Number.isFinite(daysToTarget)) return null
  return monthKeyOf(addDays(latest.date, Math.round(daysToTarget)))
}
