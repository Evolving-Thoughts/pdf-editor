// Run from the repository root. Never converts a failed test into a green run.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chromiumPath } from './browser-helper.mjs'
import { runQaStep } from './qa-step.mjs'
const root = resolve(process.env.QA_ARTIFACT_DIR ?? 'qa-artifacts')
mkdirSync(root, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const syntheticOnly = process.argv.includes('--synthetic-only')
const results = []
function notRun(name, reason) {
  results.push({ name, status: 'NOT_RUN', reason })
  console.log(`NOT_RUN ${name}: ${reason}`)
}
async function run(name, command, args, env = {}) {
  const result = await runQaStep({ name, command, args, root, env })
  results.push(result)
}

let server
try {
  await run('qa-runner-tests', process.execPath, [
    '--test',
    'scripts/qa-step.node-check.mjs',
  ])
  await run('fixtures', process.execPath, ['scripts/make-fixtures.mjs'])
  if (syntheticOnly) {
    notRun(
      'real-fixture-hashes',
      'Real PDFs are excluded from this CI run; check locally with npm run qa.',
    )
  } else {
    await run('real-fixture-hashes', process.execPath, [
      'scripts/fetch-real-fixtures.mjs',
      '--verify-only',
    ])
  }
  for (const name of ['test', 'lint', 'build'])
    await run(name, npm, ['run', name])
  if (results.some((x) => x.status === 'FAIL'))
    throw new Error('Preflight failed; inspect logs.')
  if (!process.env.SMOKE_URL) {
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        '--host',
        '127.0.0.1',
        '--port',
        '5234',
        '--strictPort',
      ],
      { stdio: 'ignore' },
    )
    server.on('error', (error) => console.error(error))
  }
  const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:5234'
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server && server.exitCode !== null)
      throw new Error('QA dev server exited (port in use?).')
    try {
      if ((await fetch(url)).ok) {
        ready = true
        break
      }
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!ready) throw new Error('QA server did not become ready')
  const browser = chromiumPath()
  const textboxSuites = {
    'textbox-export-standard-smoke': 'standard',
    'textbox-export-noto-smoke': 'noto',
    'textbox-export-additional-smoke': 'additional',
  }
  const scripts = [
    'smoke',
    'textbox-focus-smoke',
    'source-text-smoke',
    'source-text-mixed-smoke',
    'source-text-selection-smoke',
    'source-text-blocks-smoke',
    'drawing-smoke',
    'toolbar-smoke',
    'editor-layout-smoke',
    'images-smoke',
    'image-rotation-smoke',
    'shapes-smoke',
    'shapes-repeat-smoke',
    ...Object.keys(textboxSuites),
    'manual-save-smoke',
    'a4-smoke',
    'page-import-forms-smoke',
    'pages-edges-smoke',
    'bugs-smoke',
    'pages-selection-smoke',
    'pages-smoke',
    'thumbnails-smoke',
    'acroform-smoke',
    'redaction-smoke',
    'redaction-geometry-smoke',
    'search-import-smoke',
    'large-document-smoke',
    'text-selection-smoke',
    'preflight-smoke',
    'compression-smoke',
    ...(syntheticOnly ? [] : ['mvp-real-smoke']),
  ]
  for (const name of scripts) {
    const out = join(root, name)
    mkdirSync(out, { recursive: true })
    const fontGroup = textboxSuites[name]
    const script = fontGroup ? 'textbox-export-position-smoke' : name
    await run(name, process.execPath, [`scripts/${script}.mjs`], {
      TEXTBOX_FONT_GROUP: fontGroup ?? 'all',
      SMOKE_URL: url,
      CHROMIUM_PATH: browser,
      SMOKE_ARTIFACT_DIR: out,
    })
  }
  if (syntheticOnly) {
    notRun(
      'mvp-real-smoke',
      'Real PDFs are checked manually/locally, not in CI.',
    )
    notRun(
      'mvp-production',
      'The real-PDF production suite is excluded from CI; build remains checked.',
    )
  }
  // The real-fixture suite uses a Node PDF.js parser, so it also runs against dist.
  if (!syntheticOnly && !process.env.SMOKE_URL) {
    server.kill()
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        '5235',
        '--strictPort',
      ],
      { stdio: 'ignore' },
    )
    let previewReady = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Production preview exited')
      try {
        if ((await fetch('http://127.0.0.1:5235')).ok) {
          previewReady = true
          break
        }
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!previewReady) throw new Error('Production preview not ready')
    const out = join(root, 'mvp-production')
    mkdirSync(out, { recursive: true })
    await run(
      'mvp-production',
      process.execPath,
      ['scripts/mvp-real-smoke.mjs'],
      {
        SMOKE_URL: 'http://127.0.0.1:5235',
        CHROMIUM_PATH: browser,
        SMOKE_ARTIFACT_DIR: out,
      },
    )
  } else if (!syntheticOnly) {
    results.push({
      name: 'mvp-production',
      status: 'NOT_RUN',
      reason:
        'SMOKE_URL points to an external server; run without SMOKE_URL to verify the built bundle.',
    })
  }
} catch (error) {
  results.push({ name: 'runner', status: 'FAIL', error: String(error) })
  console.error(error)
} finally {
  server?.kill()
  writeFileSync(
    join(root, 'results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: syntheticOnly
          ? 'Synthetic CI only; real PDFs and Acrobat/macOS Preview require manual/local validation.'
          : 'Automated only; Acrobat/macOS Preview require manual validation.',
        results,
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(root, 'results.md'),
    '# Automated MVP QA\n\nAcrobat and macOS Preview are NOT covered.\n\n' +
      (syntheticOnly
        ? 'Real PDFs are excluded: manual/local validation required.\n\n'
        : '') +
      results
        .map(
          (x) =>
            `- ${x.status}: ${x.name}${x.error ? ` — ${x.error}` : x.reason ? ` — ${x.reason}` : ''}`,
        )
        .join('\n') +
      '\n',
  )
  process.exitCode = results.some((x) => x.status === 'FAIL') ? 1 : 0
}
