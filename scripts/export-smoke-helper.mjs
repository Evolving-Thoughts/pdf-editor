// The approved T12 dialog adds one explicit confirmation to normal exports.
export async function confirmDefaultExport(page) {
  const dialog = page.getByRole('dialog', { name: 'PDF exportieren', exact: true })
  await confirmExportRisks(page)
  await dialog.getByRole('button', { name: 'Ohne Optimierung exportieren', exact: true }).click()
}
// The check (T17) asks for a decision on real risks, such as lost tags after a page rebuild.
export async function confirmExportRisks(page) {
  await page.locator('.export-check .export-detail').first().waitFor()
  for (const box of await page.locator('.export-check .export-confirm input').all()) await box.check()
}
export async function openProtectedExport(page) {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await page.getByRole('checkbox', { name: /Mit Passwort schützen/ }).check()
}
