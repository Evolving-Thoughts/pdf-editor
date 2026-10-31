import { expect, test } from 'vitest'
import { RenderQueue } from '../../src/core/pdf/renderQueue'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('never runs more jobs at once than its limit and finishes every job', async () => {
  const queue = new RenderQueue(2), gates = [deferred(), deferred(), deferred(), deferred(), deferred()]
  const started: number[] = []
  const runs = gates.map((gate, index) => queue.run(async () => { started.push(index); await gate.promise; return index }))
  await Promise.resolve()
  expect(started).toEqual([0, 1])
  expect(queue.stats()).toEqual({ active: 2, queued: 3, peak: 2 })
  gates.forEach(gate => gate.resolve())
  expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4])
  expect(queue.stats()).toEqual({ active: 0, queued: 0, peak: 2 })
})

test('aborted work leaves the queue without ever starting', async () => {
  const queue = new RenderQueue(1), gate = deferred(), controller = new AbortController()
  let ran = false
  const first = queue.run(() => gate.promise)
  const second = queue.run(async () => { ran = true }, controller.signal)
  controller.abort()
  await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  expect(queue.stats().queued).toBe(0)
  gate.resolve()
  await first
  expect(ran).toBe(false)
})

test('an already aborted signal never reaches the renderer', async () => {
  const queue = new RenderQueue(1), controller = new AbortController()
  controller.abort()
  let ran = false
  await expect(queue.run(async () => { ran = true }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(ran).toBe(false)
})

test('the signal reaches running work, so the renderer can cancel it', async () => {
  const queue = new RenderQueue(1), controller = new AbortController()
  const run = queue.run(signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))), controller.signal)
  await Promise.resolve()
  controller.abort()
  await expect(run).rejects.toThrow('cancelled')
  expect(queue.stats().active).toBe(0)
})

test('clearing drops queued work from a replaced document and a failed job frees its slot', async () => {
  const queue = new RenderQueue(1), gate = deferred()
  const running = queue.run(() => gate.promise)
  const stale = queue.run(async () => 'stale')
  queue.clear()
  await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
  gate.resolve()
  await running
  await expect(queue.run(async () => { throw new Error('kaputt') })).rejects.toThrow('kaputt')
  expect(await queue.run(async () => 'weiter')).toBe('weiter')
})
