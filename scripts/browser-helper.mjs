// Shared by smoke tests: supports Windows and Playwright-installed browsers.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) {
    if (!existsSync(process.env.CHROMIUM_PATH))
      throw new Error(
        `CHROMIUM_PATH does not exist: ${process.env.CHROMIUM_PATH}`,
      )
    return process.env.CHROMIUM_PATH
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath()
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    try {
      const command = process.platform === 'win32' ? 'where' : 'which'
      const path = execFileSync(command, [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\r?\n/)[0]
      if (existsSync(path)) return path
    } catch {
      /* Try the next installed browser. */
    }
  }
  throw new Error(
    'Chromium missing. Run npx playwright install chromium or set CHROMIUM_PATH.',
  )
}
