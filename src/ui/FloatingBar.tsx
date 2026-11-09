import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { floatingBarPosition, type Rect } from '../core/barPosition'

interface Props {
  /** The element the bar belongs to; the bar sits above it, or below when there is no room. */
  anchor: RefObject<HTMLElement | null>
  barRef?: RefObject<HTMLDivElement | null>
  className: string
  label: string
  children: ReactNode
}

type Placement = { left: number; top: number; hidden: boolean }

function place(target: HTMLElement | null, bar: HTMLElement | null, set: (update: (previous: Placement | null) => Placement | null) => void) {
  if (!target || !bar) return
  const box = target.getBoundingClientRect()
  const next = floatingBarPosition(
      { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      { width: bar.offsetWidth, height: bar.offsetHeight },
      visibleArea(target),
    )
  set(previous => previous && previous.left === next.left && previous.top === next.top && previous.hidden === next.hidden ? previous : next)
}

const viewport = (): Rect => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })

/** The visible part of the page scroller: bars stay inside it, never under app chrome such as the save notice. */
function visibleArea(anchor: HTMLElement): Rect {
  const screen = viewport()
  const scroller = anchor.closest('.pages')?.getBoundingClientRect()
  if (!scroller) return screen
  return {
    left: Math.max(screen.left, scroller.left), top: Math.max(screen.top, scroller.top),
    right: Math.min(screen.right, scroller.right), bottom: Math.min(screen.bottom, scroller.bottom),
  }
}

/**
 * A toolbar for one element, rendered on top of everything (portal, fixed
 * position). It follows the element while scrolling and zooming and is not
 * rotated or clipped with the page.
 */
export function FloatingBar({ anchor, barRef, className, label, children }: Props) {
  const ownRef = useRef<HTMLDivElement>(null)
  const ref = barRef ?? ownRef
  const [position, setPosition] = useState<Placement | null>(null)

  // Layout can change with every render of the owner (text, zoom, rotation).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- every render on purpose; place() only sets a changed position
  useLayoutEffect(() => place(anchor.current, ref.current, setPosition))
  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => place(anchor.current, ref.current, setPosition))
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    if (anchor.current) observer.observe(anchor.current)
    if (ref.current) observer.observe(ref.current)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [anchor, ref])
  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      className={`floating-bar ${className}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        // Before the first measurement the bar is only transparent: its fields must already take focus.
        opacity: position ? undefined : 0,
        visibility: position?.hidden ? 'hidden' : undefined,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
