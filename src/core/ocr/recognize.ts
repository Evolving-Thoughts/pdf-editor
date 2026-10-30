// Core module: local text recognition (T25). Nothing here runs by itself: the engine
// starts only through createOcrEngine, and that is reached only from the dialog's button.
import { gunzipSync } from 'fflate'
import assets from './ocrAssets.json'

export type OcrLanguage = keyof typeof assets.models
export const OCR_LANGUAGES: { value: OcrLanguage[]; label: string }[] = [
  { value: ['deu'], label: 'Deutsch' },
  { value: ['eng'], label: 'Englisch' },
  { value: ['deu', 'eng'], label: 'Deutsch und Englisch' },
]
export const OCR_PAGE_TIMEOUT_MS = 3 * 60 * 1000
export const UNCERTAIN_CONFIDENCE = 60

/** Displayed page points, top-left origin. */
export interface OcrWord { text: string; confidence: number; left: number; top: number; right: number; bottom: number }
export interface OcrRecognition { words: OcrWord[]; text: string }
export interface OcrEngine { recognize(image: Blob, scale: number): Promise<OcrRecognition>; terminate(): Promise<void> }

interface TesseractWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TesseractBlock { paragraphs?: { lines?: { words?: TesseractWord[] }[] }[] }

export function wordsFromBlocks(blocks: TesseractBlock[] | null | undefined, scale: number): OcrWord[] {
  const words: OcrWord[] = []
  for (const block of blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) for (const word of line.words ?? []) {
    const text = word.text.trim()
    if (!text) continue
    words.push({ text, confidence: word.confidence, left: word.bbox.x0 / scale, top: word.bbox.y0 / scale, right: word.bbox.x1 / scale, bottom: word.bbox.y1 / scale })
  }
  return words
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** A damaged or swapped model must never reach the engine. */
export async function verifyModel(language: OcrLanguage, baseUrl: string, load: typeof fetch = fetch): Promise<void> {
  const model = assets.models[language]
  let response: Response
  // Revalidates, so a damaged copy in the HTTP cache cannot fail every later attempt.
  try { response = await load(`${baseUrl}${model.target}`, { cache: 'no-cache' }) }
  catch { throw new Error('Das Sprachmodell konnte nicht geladen werden. Bitte die Verbindung zur App prüfen.') }
  if (!response.ok) throw new Error('Das Sprachmodell konnte nicht geladen werden. Bitte die Verbindung zur App prüfen.')
  // Servers differ: some send the .gz as it is, others mark it as encoded and the
  // browser unpacks it on the way. The unpacked content is the same in both cases.
  const received = new Uint8Array(await response.arrayBuffer())
  let content: Uint8Array
  try { content = received[0] === 0x1f && received[1] === 0x8b ? gunzipSync(received) : received }
  catch { content = received }
  if (hex(await crypto.subtle.digest('SHA-256', new Uint8Array(content))) !== model.contentSha256)
    throw new Error('Das Sprachmodell ist beschädigt und wurde nicht verwendet.')
}

/** Everything comes from this app's own address; tesseract's CDN defaults are all overridden. */
export async function createOcrEngine(languages: OcrLanguage[], baseUrl: string, onProgress: (share: number) => void): Promise<OcrEngine> {
  await Promise.all(languages.map(language => verifyModel(language, baseUrl)))
  const { createWorker, OEM } = await import('tesseract.js')
  const worker = await createWorker(languages.join('+'), OEM.LSTM_ONLY, {
    workerPath: `${baseUrl}worker.min.js`,
    corePath: `${baseUrl}core/`,
    langPath: `${baseUrl}lang`,
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: message => { if (message.status === 'recognizing text') onProgress(message.progress) },
  })
  return {
    async recognize(image, scale) {
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true })
      return { words: wordsFromBlocks(data.blocks as TesseractBlock[] | null, scale), text: data.text ?? '' }
    },
    terminate: async () => { await worker.terminate() },
  }
}

/** Ends a stuck page instead of leaving the dialog waiting forever. */
export function withTimeout<T>(work: Promise<T>, milliseconds: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('Die Erkennung hat zu lange gedauert und wurde beendet.'))
    }, milliseconds)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
