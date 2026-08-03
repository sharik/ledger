import { v7 as uuid7 } from 'uuid'

export type Iso = string

let offsetMs = 0

/** Fix the clock (tests, and the ?now= dev hook). Pass null to restore real time. */
export function setFixedNow(iso: string | null): void {
  offsetMs = iso === null ? 0 : Date.parse(iso) - Date.now()
}

// Dev/test determinism: ?now=<ISO> fixes the clock's epoch at boot.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const p = new URLSearchParams(window.location.search).get('now')
  if (p && !Number.isNaN(Date.parse(p))) setFixedNow(p)
}

export function nowMs(): number {
  return Date.now() + offsetMs
}

export function now(): Iso {
  return new Date(nowMs()).toISOString()
}

export function nowDate(): Date {
  return new Date(nowMs())
}

export function uuidv7(): string {
  return uuid7()
}

/**
 * The single timestamp comparator (SYNC §4.5). Everything routes through here so
 * a Hybrid Logical Clock upgrade is a one-file change. Within 2 s the order is
 * treated as unknowable ('tie') — callers must flag, not silently order.
 */
export function isNewer(a: Iso, b: Iso): 'a' | 'b' | 'tie' {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Math.abs(ta - tb) < 2000) return 'tie'
  return ta > tb ? 'a' : 'b'
}
