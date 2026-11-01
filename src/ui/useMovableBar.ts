import { useEffect, useRef, useState, type RefObject } from 'react'
import { BAR_HOME, barKeyTarget, boundBar, type BarPosition } from '../core/barPosition'

const fit = (next: BarPosition, workspace: HTMLElement, bar: HTMLElement) => boundBar(next,
  { width: workspace.clientWidth, height: workspace.clientHeight }, { width: bar.offsetWidth, height: bar.offsetHeight })

/** A toolbar that stays outside the scrolling PDF surface; only its grip moves it. */
export function useMovableBar(workspaceRef: RefObject<HTMLDivElement | null>) {
  const barRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; from: BarPosition } | null>(null)
  const [position, setPosition] = useState(BAR_HOME)

  const bounded = (next: BarPosition) => {
    const workspace = workspaceRef.current, bar = barRef.current
    return workspace && bar ? fit(next, workspace, bar) : next
  }

  // A smaller viewport or differently sized options must not strand the grip.
  useEffect(() => {
    const workspace = workspaceRef.current
    const bar = barRef.current
    if (!workspace || !bar) return
    const observer = new ResizeObserver(() => {
      if (bar.hidden) return
      setPosition((current) => {
        const next = fit(current, workspace, bar)
        return next.x === current.x && next.y === current.y ? current : next
      })
    })
    observer.observe(workspace)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [workspaceRef])

  const stopDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (cancelled) setPosition(bounded(drag.from))
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const grip = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) return
      event.currentTarget.focus()
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: position }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      setPosition(bounded({ x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y }))
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => stopDrag(event),
    onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => stopDrag(event, true),
    onLostPointerCapture: (event: React.PointerEvent<HTMLButtonElement>) => stopDrag(event, true),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const target = barKeyTarget(event, position)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      setPosition(bounded(target))
    },
  }
  return { barRef, position, grip, reset: () => setPosition(bounded(BAR_HOME)) }
}
