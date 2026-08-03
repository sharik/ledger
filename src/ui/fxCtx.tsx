// App-level FX rate cache (IMPORT §4.5): holds provider tables in memory and in
// L1 KV (`fx.tables|{base}`) — NEVER in the vault. Compare/KPIs read a RateBook
// derived from (vault + these tables); Settings' Exchange-rates card refreshes
// them. Bank-derived rates and manual overrides live in the vault and resolve
// inside `fx.ts`, so this cache only carries the API tier.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { KV } from '../persist/idb'
import { buildRateBook, fetchRateTable, type FxProviderOpts, type RateBook, type RateTable, type RateTables } from '../import/fx'
import { useRawVault } from './store'

const KEY = (base: string) => `fx.tables|${base.toUpperCase()}`

interface FxContextValue {
  tables: RateTables
  refresh: (dates: string[], base: string, opts?: FxProviderOpts) => Promise<number>
}

const FxContext = createContext<FxContextValue | null>(null)

export function FxProvider({ children, base = 'EUR' }: { children: React.ReactNode; base?: string }) {
  const [tables, setTables] = useState<RateTables>(() => new Map())

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const kv = await KV.open()
        const stored = await kv.get<Record<string, RateTable>>(KEY(base))
        kv.close()
        if (live && stored) setTables(new Map(Object.entries(stored)))
      } catch {
        // cache is best-effort; absent tables just mean tier-5 exclusion
      }
    })()
    return () => {
      live = false
    }
  }, [base])

  const refresh = useCallback<FxContextValue['refresh']>(async (dates, b, opts) => {
    const next = new Map(tables)
    let fetched = 0
    for (const d of dates) {
      const t = await fetchRateTable(d, b, opts)
      if (t) {
        next.set(d, t)
        fetched++
      }
    }
    if (fetched > 0) {
      setTables(next)
      try {
        const kv = await KV.open()
        await kv.put(KEY(b), Object.fromEntries(next))
        kv.close()
      } catch {
        // persistence is best-effort
      }
    }
    return fetched
  }, [tables])

  const value = useMemo(() => ({ tables, refresh }), [tables, refresh])
  return <FxContext.Provider value={value}>{children}</FxContext.Provider>
}

export function useFx(): FxContextValue {
  return useContext(FxContext) ?? { tables: new Map(), refresh: async () => 0 }
}

/**
 * A RateBook over (RAW vault, cached tables) — recomputed only when either changes.
 * Raw on purpose: a bank-derived rate is a fact about the market, not about an account, so
 * hiding the account that happened to evidence a EUR→JPY rate must not degrade a visible
 * account's conversion — and the Accounts screen still converts a hidden account's balance.
 */
export function useRateBook(): RateBook {
  const { tables } = useFx()
  const vault = useRawVault()
  return useMemo(() => buildRateBook(vault, tables), [vault, tables])
}
