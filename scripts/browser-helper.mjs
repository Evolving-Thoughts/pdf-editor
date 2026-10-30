// Shared by smoke tests: supports Windows and Playwright-installed browsers.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

/** Pages mount near the view only (T20): scroll until an overlay on a later page exists. */
export async function revealInPages(page, selector) {
  await page.waitForSelector('.pages .page-slot')
  const height = await page.locator('.pages').evaluate(el => el.scrollHeight)
  const step = await page.locator('.pages').evaluate(el => el.clientHeight)
  for (let top = 0; top <= height; top += step) {
    await page.locator('.pages').evaluate((el, value) => { el.scrollTop = value }, top)
    await page.waitForTimeout(120)
    if (await page.locator(selector).count()) break
  }
  await page.locator(selector).first().waitFor()
}

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
