// Shared steps for the inline paragraph editor (T16) in browser smokes.
export const inlineInput = (page) => page.getByLabel(/^Absatz bearbeiten/)
/** Click a proved block (by index or by text it contains) at a relative point. */
export async function openInline(page, which = 0, at = { x: 0.5, line: 0 }) {
  const block = typeof which === 'number'
    ? page.locator('.source-block').nth(which)
    : page.locator('.source-block').filter({ has: page.locator('.source-run-hit', { hasText: which }) }).first()
  const box = await block.locator('.source-block-outline').boundingBox()
  const lines = await block.locator('.source-run-hit').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))].length)
  const lineHeight = box.height / Math.max(1, lines)
  await page.mouse.click(box.x + box.width * at.x, box.y + lineHeight * (at.line + 0.55))
  await page.locator('.source-inline').waitFor()
  await inlineInput(page).waitFor({ state: 'attached' })
}
export async function caret(page) {
  return inlineInput(page).evaluate((a) => [a.selectionStart, a.selectionEnd])
}
/** Replace the whole paragraph text through the hidden input (like typing). */
export async function setInlineText(page, text) {
  await inlineInput(page).focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}
export const fit = (page) => page.locator('#source-fit').innerText()
export async function checkInPdf(page) {
  await page.getByRole('button', { name: 'In PDF prüfen', exact: true }).click()
  await page.getByText(/^Ergebnis( mit \d+ geänderten Absätzen( auf \d+ Seiten)?)? in der echten PDF bereit\./).waitFor()
  await page.locator('.source-pdf-preview canvas[data-render-state="ready"]').waitFor()
}
export const applyButton = (page) => page.getByRole('button', { name: 'Übernehmen', exact: true })
