/** Search geometry is in displayed page points, with a top-left origin. */
export interface SearchPoint {
  x: number
  y: number
}
export interface SearchFragment {
  text: string
  quad: SearchPoint[]
  breakAfter?: boolean
  clips?: SearchPoint[][]
  advances?: number[]
}
export interface SearchGroup {
  pageIndex: number
  fragments: SearchFragment[]
}
export interface SearchHit {
  pageIndex: number
  polygons: SearchPoint[][]
}

function normalize(text: string) {
  let value = ''
  const offsets: number[] = []
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!)
    const folded = /\s/u.test(char) ? ' ' : char.toLocaleLowerCase('de')
    if (!(folded === ' ' && value.endsWith(' '))) {
      value += folded
      for (let n = 0; n < folded.length; n++) offsets.push(i)
    }
    i += char.length
  }
  offsets.push(text.length)
  return { value, offsets }
}
function lerp(a: SearchPoint, b: SearchPoint, t: number): SearchPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
export function fragmentRange(
  fragment: SearchFragment,
  from: number,
  to: number,
) {
  const [tl, tr, br, bl] = fragment.quad
  const start = fragment.advances?.[from] ?? from / fragment.text.length,
    end = fragment.advances?.[to] ?? to / fragment.text.length
  return [
    lerp(tl, tr, start),
    lerp(tl, tr, end),
    lerp(bl, br, end),
    lerp(bl, br, start),
  ]
}
/** Literal, case-insensitive search. Whitespace may span PDF text items/lines.
 * Separate groups prevent matches crossing independent textboxes or pages. */
export function searchDocument(
  groups: SearchGroup[],
  query: string,
): SearchHit[] {
  const needle = normalize(query.trim()).value
  if (!needle) return []
  const hits: SearchHit[] = []
  for (const group of groups) {
    let text = ''
    const spans = group.fragments.map((fragment) => {
      const start = text.length
      text += fragment.text
      const end = text.length
      if (fragment.breakAfter) text += '\n'
      return { fragment, start, end }
    })
    const folded = normalize(text)
    let spanCursor = 0
    for (
      let at = folded.value.indexOf(needle);
      at !== -1;
      at = folded.value.indexOf(needle, at + needle.length)
    ) {
      const start = folded.offsets[at],
        end =
          folded.offsets[at + needle.length - 1] +
          String.fromCodePoint(
            text.codePointAt(folded.offsets[at + needle.length - 1])!,
          ).length
      while (spanCursor < spans.length && spans[spanCursor].end <= start)
        spanCursor++
      const visiblePolygons: SearchPoint[][] = []
      for (let i = spanCursor; i < spans.length && spans[i].start < end; i++) {
        const span = spans[i]
        if (!span.fragment.text.length) continue
        const polygon = fragmentRange(
          span.fragment,
          Math.max(0, start - span.start),
          Math.min(span.fragment.text.length, end - span.start),
        )
        const visible = (span.fragment.clips ?? []).reduce(
          (points, clip) => clipPolygon(points, clip),
          polygon,
        )
        if (visible.length > 2) visiblePolygons.push(visible)
      }
      if (visiblePolygons.length)
        hits.push({ pageIndex: group.pageIndex, polygons: visiblePolygons })
    }
  }
  return hits.sort((a, b) => a.pageIndex - b.pageIndex)
}

/** Convex clipping, used by page crops and the editor's captured overlay clips. */
function clipPolygon(
  subject: SearchPoint[],
  clip: SearchPoint[],
): SearchPoint[] {
  const area = clip.reduce(
    (sum, p, i) =>
      sum +
      p.x * clip[(i + 1) % clip.length].y -
      clip[(i + 1) % clip.length].x * p.y,
    0,
  )
  let output = subject
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length],
      input = output
    output = []
    const cross = (p: SearchPoint) =>
      (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    const inside = (p: SearchPoint) => cross(p) * (area >= 0 ? 1 : -1) >= -1e-8
    for (let j = 0; j < input.length; j++) {
      const p = input[j],
        q = input[(j + input.length - 1) % input.length],
        pIn = inside(p),
        qIn = inside(q)
      if (pIn !== qIn) {
        const t = cross(q) / (cross(q) - cross(p))
        output.push(lerp(q, p, t))
      }
      if (pIn) output.push(p)
    }
  }
  return output
}
export function visibleFragments(
  fragments: SearchFragment[],
  size: { width: number; height: number },
  clips: SearchPoint[][] = [],
): SearchFragment[] {
  const bounds = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ]
  return fragments.flatMap((fragment) => {
    if (!fragment.text.length) return []
    const allClips = [bounds, ...clips]
    // Do not break ordinary items into glyphs unless clipping actually matters.
    const fullyInside = allClips.every((clip) => {
      const clipped = clipPolygon(fragment.quad, clip)
      return (
        clipped.length === 4 &&
        fragment.quad.every((p) =>
          clipped.some(
            (q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6,
          ),
        )
      )
    })
    if (fullyInside) return [fragment]
    const result: SearchFragment[] = []
    for (let i = 0; i < fragment.text.length;) {
      const char = String.fromCodePoint(fragment.text.codePointAt(i)!),
        quad = fragmentRange(fragment, i, i + char.length)
      const polygon = allClips.reduce((p, clip) => clipPolygon(p, clip), quad)
      const area = Math.abs(
        polygon.reduce(
          (sum, p, j) =>
            sum +
            p.x * polygon[(j + 1) % polygon.length].y -
            polygon[(j + 1) % polygon.length].x * p.y,
          0,
        ),
      )
      // A barrier prevents a phrase from joining across hidden characters.
      result.push({
        text: area > 1e-6 ? char : '\0',
        quad,
        clips: allClips,
        breakAfter:
          i + char.length === fragment.text.length && fragment.breakAfter,
      })
      i += char.length
    }
    return result
  })
}
