// Keeps full per-step logs and prints a bounded failure excerpt in CI output.
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runQaStep({
  name,
  command,
  args,
  root,
  env = {},
  timeoutMs = 240000,
  print = console.log,
}) {
  const start = Date.now(),
    path = join(root, `${name}.log`)
  const log = createWriteStream(path)
  let timedOut = false
  print(`RUN ${name}`)
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      shell: process.platform === 'win32' && command === 'npm.cmd',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('error', (error) => log.write(String(error) + '\n'))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      // Reading before finish can lose the last assertion/stack trace.
      log.end(() =>
        resolve({
          name,
          status: code === 0 && !timedOut ? 'PASS' : 'FAIL',
          code,
          signal,
          timedOut,
          seconds: Math.round((Date.now() - start) / 1000),
        }),
      )
    })
  })
  print(`${result.status} ${name} (${result.seconds}s)`)
  if (result.status === 'FAIL') {
    print(
      `--- ${name}: ${timedOut ? 'TIMEOUT; ' : ''}last 60 log lines; full output in ${path} ---`,
    )
    print(
      readFileSync(path, 'utf8').trimEnd().split(/\r?\n/).slice(-60).join('\n'),
    )
    print(`--- end ${name} ---`)
  }
  return result
}
