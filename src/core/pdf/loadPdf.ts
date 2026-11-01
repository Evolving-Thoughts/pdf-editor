// Core module: load, render and release PDFs (PDF.js).
// The UI only ever talks to the PdfHandle, never to pdfjs-dist directly
// (core/UI boundary, ADR-004).
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { OverlayFont } from '../model'
import type { Redaction } from '../redactions'
import { MAX_RENDER_PIXELS, renderPlan, validatePageSize } from './renderBudget'
import { RenderQueue } from './renderQueue'
import type { SearchFragment } from '../search'

GlobalWorkerOptions.workerSrc = workerUrl
const OCR_DPI = 300

export interface PageSize {
  width: number
  height: number
}
export interface SourcePageGeometry extends PageSize {
  /** Source-PDF to displayed page coordinates, including native CropBox. */
  sourceTransform: number[]
}

export interface RasterizedPage { png: Uint8Array; replacements: {markId:string;x:number;y:number;fontSize:number;font:OverlayFont;rotation:number}[] }
export interface PdfHandle {
  readonly fileName: string
  readonly pageCount: number
  /** Renders a page (1-based) into the canvas. Per canvas in order; all canvases share a parallelism limit. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, zoom: number, signal?: AbortSignal): Promise<void>
  /** Page size in PDF points (1-based page number), cached after first call. */
  getPageSize(pageNumber: number): Promise<PageSize>
  /** Opt-in source mapping; keep the existing size-only contract unchanged. */
  getPageGeometry(pageNumber: number): Promise<SourcePageGeometry>
  /** Fills the container with transparent, selectable spans over the page. Says whether the page has text. */
  renderTextLayer(pageNumber: number, container: HTMLElement, zoom: number, signal: AbortSignal): Promise<boolean>
  /** Text and geometry from PDF.js; raster/image pages return no text. */
  getSearchText(pageNumber: number): Promise<SearchFragment[]>
  /** The displayed page as a picture for text recognition. `scale` is pixels per page point. */
  renderForOcr(pageNumber: number): Promise<{ image: Blob; scale: number }>
  /** Lossless 300-dpi pixels with outward-rounded opaque masks; never returns source content. */
  rasterizePage(pageNumber:number, marks:Redaction[]):Promise<RasterizedPage>
  /** Releases worker resources; call when switching or closing documents. */
  destroy(): Promise<void>
}

export async function loadPdf(fileName: string, bytes: Uint8Array): Promise<PdfHandle> {
  // getDocument transfers the buffer to the worker, which detaches it —
  // so PDF.js gets a copy and the original stays usable for export.
  const loadingTask = getDocument({ data: bytes.slice() })
  const pdfDocument = await loadingTask.promise

  // Per-canvas promise chain: PDF.js throws when a canvas is rendered
  // concurrently, and cancel-then-register leaves a race window across the
  // getPage await (triggered e.g. by StrictMode double effects). Registering
  // the chain synchronously serializes all renders on the same canvas.
  // Offscreen thumbnails unmount their canvases; do not retain those canvases here.
  const renderQueues = new WeakMap<HTMLCanvasElement, Promise<void>>()
  const sizeCache = new Map<number, PageSize>()
  const queue = new RenderQueue()

  return {
    fileName,
    pageCount: pdfDocument.numPages,

    renderPage(pageNumber, canvas, zoom, signal) {
      canvas.dataset.renderState = 'loading'
      const queued = renderQueues.get(canvas) ?? Promise.resolve()
      const run = queued.catch(() => undefined).then(() => queue.run(async active => {
        const page = await pdfDocument.getPage(pageNumber)
        const base = page.getViewport({ scale: 1 })
        const plan = renderPlan(base.width, base.height, zoom, window.devicePixelRatio ?? 1)
        const viewport = page.getViewport({ scale: plan.scale })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        canvas.style.width = `${Math.floor(plan.cssWidth)}px`
        canvas.style.height = `${Math.floor(plan.cssHeight)}px`
        const task = page.render({ canvas, viewport })
        const cancel = () => task.cancel()
        if (active.aborted) cancel()
        active.addEventListener('abort', cancel, { once: true })
        try { await task.promise } finally { active.removeEventListener('abort', cancel) }
        if (renderQueues.get(canvas) === run) canvas.dataset.renderState = 'ready'
      }, signal))
      renderQueues.set(canvas, run)
      return run
    },


    renderForOcr: pageNumber => queue.run(async () => {
      const page = await pdfDocument.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(OCR_DPI / 72, Math.sqrt(MAX_RENDER_PIXELS / base.width / base.height))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      try {
        await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
        const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Die Seite konnte nicht für die Erkennung vorbereitet werden.')), 'image/png'))
        return { image, scale }
      } finally { canvas.width = 1; canvas.height = 1; page.cleanup() }
    }),

    async renderTextLayer(pageNumber, container, zoom, signal) {
      const page = await pdfDocument.getPage(pageNumber)
      if (signal.aborted) return false
      const viewport = page.getViewport({ scale: zoom })
      const content = await page.getTextContent()
      if (signal.aborted) return false
      container.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
      const layer = new TextLayer({ textContentSource: content, container, viewport })
      const cancel = () => layer.cancel()
      signal.addEventListener('abort', cancel, { once: true })
      try { await layer.render() } finally { signal.removeEventListener('abort', cancel) }
      return content.items.some(item => 'str' in item && item.str.trim().length > 0)
    },

    async getPageSize(pageNumber) {
      const cached = sizeCache.get(pageNumber)
      if (cached) return cached
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      validatePageSize(viewport.width, viewport.height)
      const size = { width: viewport.width, height: viewport.height }
      sizeCache.set(pageNumber, size)
      return size
    },

    async getPageGeometry(pageNumber) {
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      validatePageSize(viewport.width, viewport.height)
      return { width: viewport.width, height: viewport.height, sourceTransform: [...viewport.transform] }
    },

    async getSearchText(pageNumber) {
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({scale:1})
      const content = await page.getTextContent()
      const measure=document.createElement('canvas').getContext('2d')
      return content.items.filter(item => 'str' in item && item.str.length > 0).map(item => {
        if (!('str' in item)) throw new Error('Ungültiges Textelement')
        const [a,b,c,d,x,y] = item.transform
        const advance = Math.hypot(a,b) || 1
        const style = content.styles[item.fontName]
        const ascent = style?.ascent ?? .8, descent = style?.descent ?? -.2
        let advances:number[]|undefined
        if(measure && item.str.length){
          measure.font=`${Math.hypot(c,d)||item.height||12}px ${style?.fontFamily??'sans-serif'}`
          const width=measure.measureText(item.str).width
          if(width>0)advances=Array.from({length:item.str.length+1},(_,i)=>measure.measureText(item.str.slice(0,i)).width/width)
        }
        const corners = [[x+c*ascent,y+d*ascent],[x+a/advance*item.width+c*ascent,y+b/advance*item.width+d*ascent],
          [x+a/advance*item.width+c*descent,y+b/advance*item.width+d*descent],[x+c*descent,y+d*descent]]
        return {text:item.str,breakAfter:item.hasEOL,advances,quad:corners.map(([px,py])=>{const [x,y]=viewport.convertToViewportPoint(px,py);return {x,y}})}
      })
    },

    async rasterizePage(pageNumber, marks) {
      const page=await pdfDocument.getPage(pageNumber),view=page.getViewport({scale:1}),scale=300/72
      const viewport=page.getViewport({scale}),width=Math.ceil(viewport.width),height=Math.ceil(viewport.height)
      if(!Number.isFinite(width*height)||width*height>32_000_000)throw new Error('Die Seite ist für eine sichere Rasterung mit 300 dpi zu groß. Der Stand bleibt unverändert.')
      if(!marks.length||marks.some(mark=>![mark.x,mark.y,mark.width,mark.height].every(Number.isFinite)||mark.x<0||mark.y<0||mark.width<2||mark.height<2||mark.x+mark.width>view.width+1e-6||mark.y+mark.height>view.height+1e-6||!['black','white'].includes(mark.fill)))throw new Error('Ungültiger Schwärzungsbereich.')
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
      const context=canvas.getContext('2d',{alpha:false})
      if(!context)throw new Error('Die Seite konnte nicht gerastert werden.')
      try {
        await page.render({canvas,viewport,background:'rgb(255,255,255)'}).promise
        // Masks must be opaque regardless of the renderer's last graphics state.
        context.setTransform(1,0,0,1,0,0);context.globalAlpha=1;context.globalCompositeOperation='source-over';context.filter='none';context.shadowBlur=0;context.shadowColor='transparent'
        for(const mark of marks) {
          const left=Math.max(0,Math.floor(mark.x/view.width*width)),top=Math.max(0,Math.floor((view.height-mark.y-mark.height)/view.height*height))
          const right=Math.min(width,Math.ceil((mark.x+mark.width)/view.width*width)),bottom=Math.min(height,Math.ceil((view.height-mark.y)/view.height*height))
          context.fillStyle=mark.fill==='white'?'#ffffff':'#000000';context.fillRect(left,top,right-left,bottom-top)
        }
        const replacements:RasterizedPage['replacements']=[]
        if(marks.some(mark=>mark.fill==='white')) {
          const content=await page.getTextContent()
          for(const mark of marks.filter(mark=>mark.fill==='white')) {
            let suggestion={markId:mark.id,x:mark.x,y:mark.y+Math.max(2,mark.height*.2),fontSize:Math.min(14,mark.height*.75),font:'helvetica' as OverlayFont,rotation:0}
            for(const item of content.items) {
              if(!('str' in item)||!item.str.trim())continue
              const [a,b,c,d,x,y]=item.transform,size=Math.hypot(a,b)||1,height=Math.hypot(c,d)||item.height
              const corners=[[x,y],[x+a/size*item.width,y+b/size*item.width],[x+c,y+d],[x+a/size*item.width+c,y+b/size*item.width+d]].map(([px,py])=>view.convertToViewportPoint(px,py))
              const left=Math.min(...corners.map(p=>p[0])),right=Math.max(...corners.map(p=>p[0])),bottom=view.height-Math.max(...corners.map(p=>p[1])),top=view.height-Math.min(...corners.map(p=>p[1]))
              if(right<=mark.x||left>=mark.x+mark.width||top<=mark.y||bottom>=mark.y+mark.height)continue
              const baseline=view.convertToViewportPoint(x,y),end=view.convertToViewportPoint(x+a,y+b),rotation=Math.atan2(end[1]-baseline[1],end[0]-baseline[0])*180/Math.PI,family=content.styles[item.fontName]?.fontFamily??''
              suggestion={markId:mark.id,x:Math.max(mark.x,Math.min(mark.x+mark.width-2,baseline[0])),y:Math.max(mark.y,Math.min(mark.y+mark.height-2,view.height-baseline[1])),fontSize:Math.max(4,Math.min(200,height*page.userUnit)),rotation,font:/mono/i.test(family)?'courier':/serif/i.test(family)&&!/sans/i.test(family)?'times':'helvetica'}
              break
            }
            replacements.push(suggestion)
          }
        }
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Die Rasterseite konnte nicht gespeichert werden.')),'image/png'))
        return {png:new Uint8Array(await blob.arrayBuffer()),replacements}
      } finally {canvas.width=1;canvas.height=1;page.cleanup()}
    },

    destroy() {
      queue.clear()
      return loadingTask.destroy()
    },
  }
}
