import { useEffect, useRef, useState, type ReactNode } from 'react'

const INITIAL_PAGES = 3

/** Keeps the page's place in the scroll area; only pages near the view hold a canvas.
 * The placeholder is a `.page` too, so search jumps and page lookups find it. */
export function VirtualPage({ index, size, zoom, keepMounted, children }: {
  index: number
  size?: { width: number; height: number }
  zoom: number
  /** A selected overlay stays editable while its page scrolls away. */
  keepMounted: boolean
  children: ReactNode
}) {
  const slot = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(index < INITIAL_PAGES)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const element = slot.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: element.closest('.pages'),
      rootMargin: '100% 0px',
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const mounted = near || keepMounted || focused || !size
  const style = size ? { width: size.width * zoom, height: size.height * zoom } : undefined
  return (
    <div
      ref={slot}
      className="page-slot"
      style={style}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >
      {mounted ? children : <div className="page page-placeholder" data-page-index={index} style={style} />}
    </div>
  )
}
