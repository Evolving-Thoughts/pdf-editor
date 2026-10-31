/** Draws a stamp as a transparent PNG. High resolution, because it may be scaled up. */
export function renderStampImage(lines: string[], color: string) {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
  if (!context) throw new Error('Stempel lassen sich in diesem Browser nicht erzeugen.')
  const fontSize = 72, lineHeight = fontSize * 1.2, padding = 40, border = 8
  const font = `bold ${fontSize}px Helvetica, Arial, sans-serif`
  context.font = font
  const width = Math.ceil(Math.max(...lines.map(line => context.measureText(line).width))) + (padding + border) * 2
  const height = Math.ceil(lines.length * lineHeight) + (padding + border) * 2 - 20
  canvas.width = width
  canvas.height = height
  context.font = font
  context.strokeStyle = context.fillStyle = color
  context.lineWidth = border
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.beginPath()
  context.roundRect(border / 2, border / 2, width - border, height - border, 24)
  context.stroke()
  lines.forEach((line, index) => context.fillText(line, width / 2, height / 2 + (index - (lines.length - 1) / 2) * lineHeight))
  return { dataUrl: canvas.toDataURL('image/png'), pixelWidth: width, pixelHeight: height }
}
