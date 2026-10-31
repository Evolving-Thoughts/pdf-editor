import type { ExportJob } from './exportJob'
import { executeJob } from './exportWorkerCore'

self.onmessage = (event: MessageEvent<ExportJob>) => {
  void executeJob(event.data, (message, transfer = []) => self.postMessage(message, { transfer }))
}
