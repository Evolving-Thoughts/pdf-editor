import type { ShapeKind } from '../core/model'
export type Tool = 'redact' | 'select' | 'text' | 'symbol' | 'pen' | 'eraser' | ShapeKind
export const SHAPE_TOOLS: { tool: ShapeKind; label: string; path: string }[] = [
  { tool: 'rect', label: 'Rechteck', path: 'M 4 5 H 20 V 19 H 4 Z' },
  { tool: 'ellipse', label: 'Ellipse', path: 'M 21 12 A 9 7 0 1 1 3 12 A 9 7 0 1 1 21 12' },
  { tool: 'line', label: 'Linie', path: 'M 4 20 L 20 4' },
  { tool: 'arrow', label: 'Pfeil', path: 'M 4 20 L 20 4 M 8 4 H 20 V 16' },
  { tool: 'marker', label: 'Textmarker', path: 'M 5 14 L 14 4 L 21 11 L 12 21 H 7 Z M 4 22 H 12' },
]
export const isShapeTool = (tool: Tool): tool is ShapeKind =>
  SHAPE_TOOLS.some((option) => option.tool === tool)
