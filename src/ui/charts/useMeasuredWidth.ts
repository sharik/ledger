// Measure a container and hand real pixel widths to a chart.
//
// Extracted from ChartCard, which needed it twice (inline + fullscreen) and now shares it with
// the budget detail panel. A panel inside a list row cannot use ChartCard itself — a card
// nested in a card — but it needs the same measurement, and charts here render <svg width
// height> at true px so "wider" is bigger geometry rather than a scaled viewBox.
import { useCallback, useRef, useState } from 'react'

export function useMeasuredWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  // Callback ref: the fullscreen body mounts in a portal AFTER first render, and a detail panel
  // mounts on expand, so a mount-time effect would observe nothing — attach whenever the node
  // appears.
  const attach = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0
      setW((prev) => (Math.abs(prev - cw) > 1 ? cw : prev))
    })
    ro.observe(el)
    roRef.current = ro
    setW(el.clientWidth)
  }, [])
  return [attach, w]
}
