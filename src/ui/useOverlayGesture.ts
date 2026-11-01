import { useState } from 'react'
import { PointerGesture, sameScene, type GestureScene, type GestureStep } from '../core/overlayGesture'

/** Connects a pointer drag to an overlay view: a preview while it runs, one commit at the end. */
export function useOverlayGesture<Data, Result>(
  scene: () => GestureScene,
  next: (step: GestureStep<Data>) => Result,
  commit: (result: Result) => void,
) {
  const [gesture] = useState(() => new PointerGesture<Data>())
  const [preview, setPreview] = useState<{ result: Result; scene: GestureScene } | null>(null)
  const cancel = () => {
    gesture.cancel()
    setPreview(null)
  }
  const begin = (event: React.PointerEvent<HTMLElement>, data: Data) => {
    if (!event.isPrimary || event.button !== 0 || !gesture.begin(event, scene(), data)) return false
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    return true
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const step = gesture.step(event, scene())
    if (!step) return
    event.stopPropagation()
    if (step.valid) setPreview({ result: next(step), scene: step.scene })
    else cancel()
  }
  const onPointerUp = (event: React.PointerEvent) => {
    const step = gesture.step(event, scene())
    if (!step) return
    event.stopPropagation()
    const result = next(step)
    cancel()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (step.valid) commit(result)
  }
  return {
    /** The running gesture's result, unless the scene has moved on. */
    shown: preview && sameScene(preview.scene, scene()) ? preview.result : null,
    begin,
    cancel,
    pointer: { onPointerMove, onPointerUp, onPointerCancel: cancel, onLostPointerCapture: cancel },
  }
}
