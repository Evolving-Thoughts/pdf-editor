import { afterEach, expect, test, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { encryptInWorker, exportInWorker, type ExportJob, type ExportJobMessage, type JobWorker } from '../../src/core/pdf/exportJob'
import { executeJob } from '../../src/core/pdf/exportWorkerCore'
import type { ExportRequest } from '../../src/core/pdf/exportPipeline'
import { inspectPages } from '../../src/core/pdf/pageOperations'
import type { Textbox } from '../../src/core/model'

afterEach(() => vi.useRealTimers())

class FakeWorker implements JobWorker {
  onmessage: JobWorker['onmessage'] = null
  onerror: JobWorker['onerror'] = null
  onmessageerror: JobWorker['onmessageerror'] = null
  posted: ExportJob[] = []
  terminated = 0
  postMessage(message: ExportJob) { this.posted.push(message) }
  terminate() { this.terminated += 1 }
  emit(message: ExportJobMessage) { this.onmessage?.({ data: message } as MessageEvent<ExportJobMessage>) }
}

const request = { original: new Uint8Array([1]), state: { pages: [], overlays: [] }, size: { mode: 'none' } } satisfies ExportRequest

test('a finished job hands over its result and ends the worker', async () => {
  const worker = new FakeWorker()
  const run = exportInWorker(request, { spawn: () => worker })
  const result = { original: new Uint8Array([9]) }
  worker.emit({ jobId: worker.posted[0].jobId, type: 'done', result })
  await expect(run).resolves.toBe(result)
  expect(worker.terminated).toBe(1)
})

test('aborting ends the worker at once and later messages change nothing', async () => {
  const worker = new FakeWorker(), controller = new AbortController()
  const run = exportInWorker(request, { spawn: () => worker, signal: controller.signal })
  controller.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(worker.terminated).toBe(1)
  expect(worker.onmessage).toBe(null)
})

test('an already aborted job starts no worker', async () => {
  const controller = new AbortController(), spawn = vi.fn(() => new FakeWorker())
  controller.abort()
  await expect(exportInWorker(request, { spawn, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(spawn).not.toHaveBeenCalled()
})

test('a time limit ends the job with a clear message and no file', async () => {
  vi.useFakeTimers()
  const worker = new FakeWorker()
  const run = exportInWorker(request, { spawn: () => worker, timeoutMs: 1000 })
  const failed = expect(run).rejects.toThrow(/zu lange gedauert/)
  await vi.advanceTimersByTimeAsync(1000)
  await failed
  expect(worker.terminated).toBe(1)
})

test('a crashed worker ends the job', async () => {
  const worker = new FakeWorker()
  const run = exportInWorker(request, { spawn: () => worker })
  worker.onerror?.({} as ErrorEvent)
  await expect(run).rejects.toThrow(/fehlgeschlagen/)
  expect(worker.terminated).toBe(1)
})

test('an error reported by the worker reaches the caller', async () => {
  const worker = new FakeWorker()
  const run = exportInWorker(request, { spawn: () => worker })
  worker.emit({ jobId: worker.posted[0].jobId, type: 'error', message: 'Kaputte Seite.' })
  await expect(run).rejects.toThrow('Kaputte Seite.')
})

test('messages of another job are ignored', async () => {
  const worker = new FakeWorker(), progress = vi.fn()
  const run = exportInWorker(request, { spawn: () => worker, onProgress: progress })
  const own = worker.posted[0].jobId
  worker.emit({ jobId: 'fremd', type: 'done', result: { original: new Uint8Array([7]) } })
  worker.emit({ jobId: 'fremd', type: 'progress', progress: { stage: 'structure' } })
  expect(worker.terminated).toBe(0)
  expect(progress).not.toHaveBeenCalled()
  const result = { original: new Uint8Array([1]) }
  worker.emit({ jobId: own, type: 'done', result })
  await expect(run).resolves.toBe(result)
})

test('two jobs have separate identities and workers', async () => {
  const first = new FakeWorker(), second = new FakeWorker()
  const runs = [exportInWorker(request, { spawn: () => first }), exportInWorker(request, { spawn: () => second })]
  expect(first.posted[0].jobId).not.toBe(second.posted[0].jobId)
  first.emit({ jobId: first.posted[0].jobId, type: 'done', result: { original: new Uint8Array([1]) } })
  second.emit({ jobId: second.posted[0].jobId, type: 'done', result: { original: new Uint8Array([2]) } })
  expect((await Promise.all(runs)).map(item => item.original[0])).toEqual([1, 2])
})

test('after a cancelled job the next one runs normally', async () => {
  const cancelled = new FakeWorker(), next = new FakeWorker(), controller = new AbortController()
  const run = exportInWorker(request, { spawn: () => cancelled, signal: controller.signal })
  controller.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  const again = exportInWorker(request, { spawn: () => next })
  next.emit({ jobId: next.posted[0].jobId, type: 'done', result: { original: new Uint8Array([5]) } })
  expect((await again).original[0]).toBe(5)
})

test('encryption carries the password only in the job itself', async () => {
  const worker = new FakeWorker()
  const run = encryptInWorker(new Uint8Array([1]), 'geheim', { spawn: () => worker })
  expect(worker.posted[0]).toMatchObject({ kind: 'encrypt', password: 'geheim' })
  worker.emit({ jobId: worker.posted[0].jobId, type: 'done', result: new Uint8Array([2]) })
  await expect(run).resolves.toEqual(new Uint8Array([2]))
})

async function source() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([300, 300])
  page.drawText('Original', { x: 20, y: 250, size: 12, font })
  doc.getForm().createTextField('name').addToPage(page, { x: 20, y: 20, width: 100, height: 20 })
  return doc.save()
}
const box: Textbox = { id: 't', pageIndex: 0, x: 20, y: 200, text: 'Zusatz', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false }

test('the worker side writes a real export and reports its stages', async () => {
  const original = await source(), messages: ExportJobMessage[] = [], before = original.slice()
  const job: ExportJob = { jobId: 'j', kind: 'export', request: { original, state: { pages: await inspectPages(original, 'a.pdf'), overlays: [box] }, size: { mode: 'structure' } } }
  await executeJob(job, message => messages.push(message))
  expect(messages.map(message => message.type === 'progress' ? message.progress.stage : message.type)).toEqual(['compose', 'structure', 'done'])
  const done = messages.at(-1)
  if (done?.type !== 'done' || done.result instanceof Uint8Array) throw new Error('Kein Ergebnis')
  const task = getDocument({ data: done.result.original.slice() })
  const text = (await (await (await task.promise).getPage(1)).getTextContent()).items.map(item => ('str' in item ? item.str : '')).join(' ')
  await task.destroy()
  expect(text).toContain('Original')
  expect(text).toContain('Zusatz')
  expect((await PDFDocument.load(done.result.original)).getForm().getFields()).toHaveLength(1)
  expect(original).toEqual(before)
})

test('the result buffers are handed over, not copied', async () => {
  const original = await source(), transfers: (ArrayBuffer[] | undefined)[] = []
  await executeJob({ jobId: 'j', kind: 'export', request: { ...request, original, state: { pages: await inspectPages(original, 'a.pdf'), overlays: [] } } }, (_, transfer) => { transfers.push(transfer) })
  expect(transfers.at(-1)).toHaveLength(1)
})

test('a failing export reports only its message, never document content', async () => {
  const messages: ExportJobMessage[] = []
  await executeJob({ jobId: 'j', kind: 'export', request: { ...request, original: new TextEncoder().encode('geheimer Inhalt'), state: { overlays: [], pages: [{ id: 'p', name: 'a', sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width: 10, height: 10 }, unit: 1, rotation: 0 }] } } }, message => messages.push(message))
  const last = messages.at(-1)!
  expect(last.type).toBe('error')
  expect(JSON.stringify(last)).not.toContain('geheimer Inhalt')
})

test('the worker side answers a check with a plain report', async () => {
  const messages: ExportJobMessage[] = [], transfers: (ArrayBuffer[] | undefined)[] = [], original = await source()
  await executeJob({ jobId: 'j', kind: 'preflight', input: { original, state: { pages: await inspectPages(original, 'a.pdf'), overlays: [{ ...box, text: 'Ω' }] } } }, (message, transfer) => { messages.push(message); transfers.push(transfer) })
  const done = messages.at(-1)
  if (done?.type !== 'done' || !('assessments' in done.result)) throw new Error('Kein Bericht')
  expect(done.result.textIssues[0].characters).toEqual(['Ω'])
  expect(transfers.at(-1)).toEqual([])
})

test('the worker side encrypts', async () => {
  const messages: ExportJobMessage[] = [], original = await source()
  await executeJob({ jobId: 'j', kind: 'encrypt', bytes: original, password: 'geheim' }, message => messages.push(message))
  const done = messages.at(-1)
  if (done?.type !== 'done' || !(done.result instanceof Uint8Array)) throw new Error('Kein Ergebnis')
  await expect(getDocument({ data: done.result.slice() }).promise).rejects.toMatchObject({ name: 'PasswordException' })
})
