// Shared limit for page rendering. One PDF.js document decodes all its pages in
// one worker, so unbounded parallel renders only cost memory, not time.
export const MAX_PARALLEL_RENDERS = 3

function aborted() {
  return new DOMException('Darstellung abgebrochen.', 'AbortError')
}

interface QueuedJob {
  start: () => void
  reject: (reason: unknown) => void
}

export class RenderQueue {
  private readonly limit: number
  private readonly waiting: QueuedJob[] = []
  private active = 0
  private peak = 0

  constructor(limit = MAX_PARALLEL_RENDERS) {
    this.limit = limit
  }

  run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted())
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const abort = () => {
        controller.abort()
        const index = this.waiting.indexOf(job)
        if (index >= 0) {
          this.waiting.splice(index, 1)
          reject(aborted())
        }
      }
      const job: QueuedJob = {
        reject,
        start: () => {
          this.active += 1
          this.peak = Math.max(this.peak, this.active)
          work(controller.signal).then(resolve, reject).finally(() => {
            signal?.removeEventListener('abort', abort)
            this.active -= 1
            this.next()
          })
        },
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiting.push(job)
      this.next()
    })
  }

  /** Drops work that has not started; a replaced document must not render later. */
  clear(): void {
    for (const job of this.waiting.splice(0)) job.reject(aborted())
  }

  stats() {
    return { active: this.active, queued: this.waiting.length, peak: this.peak }
  }

  private next(): void {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start()
  }
}
