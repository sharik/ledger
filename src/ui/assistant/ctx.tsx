// Assistant conversation state (ASSISTANT §9).
//
// The transcript lives here and nowhere else: in memory, for this session only. It is deliberately
// not a vault collection — a chat log is the most sensitive by-product of the whole feature, it
// would have to merge across devices, and nobody asked for a searchable history of their questions.
// `App` clears it on lock, next to `stripHashQuery()`.
//
// Open/closed is not in the hash either. A conversation is not a location; the route stays the
// single source of truth for which *screen* is visible, and the assistant drives that route.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Selection } from '../../model/types'
import { runChat } from '../../assistant/chat'
import { chatAccess, type Access } from '../../assistant/config'
import { visibleSkills, type PendingEdit, type ToolCtx } from '../../assistant/tools'
import { BUILTIN_SKILLS, skillsOff } from '../../assistant/skills'
import type { Turn } from '../../assistant/wire'
import { todayStr } from '../../model/selectors'
import { useDerived, useRawVault, useStore } from '../store'
import { useRateBook } from '../fxCtx'
import { useView } from '../view'
import { selectionToParam, type TxnFilter } from '../route'

/** A proposal awaiting the user's click, plus what became of it. */
export interface Proposal extends PendingEdit {
  id: number
  state: 'pending' | 'applied' | 'dismissed'
  /**
   * Index of the tool turn that raised it, so the card renders where it was proposed instead of
   * collecting at the end of the transcript. A card is about one specific answer; three questions
   * later, a stack of them at the bottom no longer says which.
   */
  afterTurn: number
}

export interface AssistantCtx {
  open: boolean
  setOpen: (open: boolean) => void
  turns: Turn[]
  running: boolean
  error: string | null
  /** The stored access level (§2.2), so the panel can say what this assistant can be asked. */
  access: Access
  proposals: Proposal[]
  send: (text: string) => void
  stop: () => void
  clear: () => void
  apply: (id: number) => void
  dismiss: (id: number) => void
}

const Ctx = createContext<AssistantCtx | null>(null)

export function useAssistant(): AssistantCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('AssistantContext missing')
  return v
}

/**
 * For shared primitives that may render outside the provider (the <Explain> panel is used
 * by ChartCard, which has no way to know where it sits). Returns null instead of throwing.
 */
export function useAssistantOptional(): AssistantCtx | null {
  return useContext(Ctx)
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const store = useStore()
  const vault = useRawVault() // hidden accounts are in scope on purpose (§5)
  const derived = useDerived()
  const rates = useRateBook()
  const view = useView()

  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const abort = useRef<AbortController | null>(null)
  const nextId = useRef(1)
  // A ref shadow of `turns`, because `onTurn` fires several times inside one run and each append
  // needs the result of the previous one — a state updater cannot be read back synchronously.
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns

  // Latest vault/router on every tool call, not the values captured when `send` was created: a run
  // spans several seconds and may itself navigate, and a stale closure would answer from a stale
  // vault right after the user applied a proposal.
  const live = useRef({ vault, derived, rates, view })
  live.current = { vault, derived, rates, view }

  const send = useCallback(
    (text: string) => {
      const message = text.trim()
      if (!message || abort.current) return
      setError(null)
      const seeded: Turn[] = [...turnsRef.current, { role: 'user', text: message }]
      turnsRef.current = seeded
      setTurns(seeded)
      setRunning(true)

      const ac = new AbortController()
      abort.current = ac

      const ctx: ToolCtx = {
        get vault() {
          return live.current.vault
        },
        get derived() {
          return live.current.derived
        },
        get rates() {
          return live.current.rates
        },
        today: todayStr(),
        // `runChat` sets this again from the same settings before every call — it is the authority, not
        // this object. Read live, so switching to full access mid-conversation takes effect at once.
        get access() {
          return chatAccess(live.current.vault.settings.assist)
        },
        nav: {
          goTab: (tab) => live.current.view.goTab(tab),
          goTxns: (filter: TxnFilter) => live.current.view.goTxns(filter),
          goCompare: (a: Selection, b: Selection, normalize?: string, mode?: string) =>
            live.current.view.go('compare', {
              cmpA: selectionToParam(a),
              cmpB: selectionToParam(b),
              ...(normalize ? { norm: normalize } : {}),
              ...(mode ? { mode } : {}),
            }),
        },
        skills: visibleSkills(BUILTIN_SKILLS, live.current.vault.skills, skillsOff(live.current.vault.settings.assist)),
        propose: (edit) => {
          const id = nextId.current++
          // `propose` fires inside `execTool`, before the tool turn carrying that result is pushed —
          // so the turn it belongs to is the one about to land at the current length.
          const afterTurn = turnsRef.current.length
          setProposals((p) => [...p, { ...edit, id, state: 'pending', afterTurn }])
        },
      }

      void runChat(vault.settings, seeded, ctx, {
        signal: ac.signal,
        onTurn: (t) => {
          turnsRef.current = [...turnsRef.current, t]
          setTurns(turnsRef.current)
        },
      }).then((res) => {
        turnsRef.current = res.turns
        setTurns(res.turns)
        setError(res.error ?? null)
        setRunning(false)
        abort.current = null
      })
    },
    // `vault.settings` is read at send time for provider config; the rest comes through `live`.
    [vault.settings],
  )

  const stop = useCallback(() => abort.current?.abort(), [])

  const clear = useCallback(() => {
    abort.current?.abort()
    abort.current = null
    turnsRef.current = []
    setTurns([])
    setProposals([])
    setError(null)
    setRunning(false)
  }, [])

  const apply = useCallback(
    (id: number) => {
      const p = proposals.find((x) => x.id === id)
      if (!p || p.state !== 'pending') return
      store.commit(p.op, { msg: p.summary, undoable: true })
      setProposals((list) => list.map((x) => (x.id === id ? { ...x, state: 'applied' } : x)))
    },
    [proposals, store],
  )

  const dismiss = useCallback(
    (id: number) => setProposals((list) => list.map((x) => (x.id === id ? { ...x, state: 'dismissed' } : x))),
    [],
  )

  const access = chatAccess(vault.settings.assist)
  const value = useMemo<AssistantCtx>(
    () => ({ open, setOpen, turns, running, error, access, proposals, send, stop, clear, apply, dismiss }),
    [open, turns, running, error, access, proposals, send, stop, clear, apply, dismiss],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
