// Copies the OCR engine and language models into public/ocr with their pinned hashes,
// so the app serves them itself and needs no third-party CDN at runtime.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const assets = JSON.parse(readFileSync(join(root, 'src/core/ocr/ocrAssets.json'), 'utf8'))
const target = join(root, 'public/ocr')

rmSync(target, { recursive: true, force: true })
for (const asset of [...assets.files, ...Object.values(assets.models)]) {
  const from = join(root, 'node_modules', asset.source), to = join(target, asset.target)
  const hash = createHash('sha256').update(readFileSync(from)).digest('hex')
  if (hash !== asset.sha256) throw new Error(`${asset.source}: SHA-256 ${hash} differs from the pinned value`)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

const notices = [
  ['tesseract.js', 'node_modules/tesseract.js/LICENSE.md'],
  ['tesseract.js-core', 'node_modules/tesseract.js-core/LICENSE'],
  ['tesseract.js worker bundle', 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt'],
  ['Third-party components of the OCR engine', 'docs/third-party-ocr.md'],
]
writeFileSync(join(target, 'LICENSES.txt'), notices.map(([name, file]) => `===== ${name} =====\n\n${readFileSync(join(root, file), 'utf8')}\n`).join('\n'))
console.log(`OCR assets: ${assets.files.length} files and ${Object.keys(assets.models).length} models verified`)
