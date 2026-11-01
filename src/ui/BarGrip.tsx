import type { useMovableBar } from './useMovableBar'

export function BarGrip({ label, handlers }: { label: string; handlers: ReturnType<typeof useMovableBar>['grip'] }) {
  return (
    <button type="button" className="drawing-grip" aria-label={label}
      title="Ziehen zum Verschieben · Pfeiltasten bewegen · Pos1 setzt zurück" {...handlers}>
      <svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true">
        {[5, 11, 17].flatMap((y) => [5, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" />))}
      </svg>
      Leiste ziehen
    </button>
  )
}
