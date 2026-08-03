// "Pin this chart to the dashboard", for every chart that is not a saved comparison.
//
// A toggle that reflects state rather than a fire-and-forget action, for the reason
// `CompareScreen`'s `pin-toggle` is one: pinning twice used to accumulate identical cards with no
// way to tell them apart. Here the match is on the widget id plus its parameters, so the same
// chart pinned with two different filters is two pins — which is the point — while pinning the
// same view twice is not.
import type { PinnedWidget } from '../../model/types'
import { now, uuidv7 } from '../../model/clock'
import { useStore, useStoreState } from '../store'
import { paramKey, WIDGETS, type WidgetId, type WidgetParams } from './catalog'
import { ACCENT, FAINT, HAIR, SURFACE } from '../theme'

/** The record this widget+params is pinned as, if it is. */
export function findPin(pins: PinnedWidget[], widget: WidgetId, params: WidgetParams): PinnedWidget | undefined {
  const key = paramKey(params)
  return pins.find((p) => p.widget === widget && paramKey(p.params ?? {}) === key)
}

/**
 * `name` overrides the catalogue title on the pinned record. A per-trip chart needs it: two trips
 * pinned from the same widget are two tiles, and "Trip category breakdown" twice tells you nothing
 * about which is which.
 */
export function PinButton({ widget, params, name }: { widget: WidgetId; params: WidgetParams; name?: string }) {
  const { vault } = useStoreState()
  const store = useStore()
  const pinned = findPin(vault.pinnedWidgets, widget, params)
  const label = name ?? WIDGETS[widget].title

  const toggle = () => {
    if (pinned) {
      // Deleted, not flagged: unlike a SavedComparison there is nothing left behind a
      // `pinned: false` worth keeping — the record IS the pin. `delete` inverts to `restore`,
      // so the undo still works.
      store.commit({ kind: 'delete', collection: 'pinnedWidgets', ids: [pinned.id] }, { msg: 'Unpinned from dashboard', undoable: true })
      return
    }
    const rec: PinnedWidget = {
      id: uuidv7(),
      updatedAt: now(),
      widget,
      params,
      name: label,
      order: vault.pinnedWidgets.length,
    }
    store.commit({ kind: 'restore', collection: 'pinnedWidgets', records: [rec] }, { msg: 'Pinned to dashboard', undoable: true })
  }

  return (
    <button
      data-testid={`pin-${widget}`}
      aria-pressed={!!pinned}
      onClick={toggle}
      // `aria-label` rather than `title`: a tooltip is meaning a touch device never shows
      // (mobile audit rule R5), and the visible label already carries the state.
      aria-label={pinned ? `Remove ${label} from the dashboard` : `Pin ${label} to the dashboard`}
      style={{
        flex: 'none', fontSize: 12, lineHeight: 1, cursor: 'pointer',
        color: pinned ? ACCENT : FAINT,
        border: `1px solid ${pinned ? ACCENT : HAIR}`,
        borderRadius: 5, padding: '4px 8px', background: pinned ? 'none' : SURFACE,
      }}
    >
      {pinned ? '📌 Pinned' : '📌 Pin'}
    </button>
  )
}
