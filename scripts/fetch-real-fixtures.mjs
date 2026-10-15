// Explicit network step. A changed upstream form requires a reviewed hash update.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const manifest = JSON.parse(
  readFileSync(new URL('./real-fixtures.json', import.meta.url), 'utf8'),
)
const dir = new URL('../tests/fixtures/real/', import.meta.url)
mkdirSync(dir, { recursive: true })
for (const fixture of manifest.fixtures) {
  const file = join(fileURLToPath(dir), fixture.file)
  let bytes
  if (existsSync(file)) bytes = readFileSync(file)
  else {
    if (process.argv.includes('--verify-only'))
      throw new Error('Real fixtures missing. Run npm run fixtures:real first.')
    const response = await fetch(fixture.url, {
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok)
      throw new Error(`${fixture.file}: HTTP ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 15 * 1024 * 1024)
        throw new Error('Fixture exceeds 15 MiB limit')
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
  }
  if (bytes.subarray(0, 5).toString() !== '%PDF-')
    throw new Error(`${fixture.file}: not a PDF`)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== fixture.sha256)
    throw new Error(
      `${fixture.file}: hash changed (${hash}); review the new form, do not silently accept it`,
    )
  writeFileSync(file, bytes)
  console.log(`VERIFIED ${fixture.file} ${hash}`)
}
