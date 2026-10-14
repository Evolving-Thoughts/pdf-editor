import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Keep the existing thumbnail footprint, but render only near the scroll viewport. */
export function PageThumbnail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: element.closest('.page-manager-list'),
      rootMargin: '100px 0px',
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <span ref={ref} className="page-miniature" aria-hidden="true">{visible ? children : null}</span>
}
