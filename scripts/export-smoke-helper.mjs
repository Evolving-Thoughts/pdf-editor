// The approved T12 dialog adds one explicit confirmation to normal exports.
export async function confirmDefaultExport(page) {
  await page.getByRole('dialog', { name: 'PDF exportieren', exact: true })
    .getByRole('button', { name: 'Ohne Optimierung exportieren', exact: true }).click()
}
export async function openProtectedExport(page) {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await page.getByRole('checkbox', { name: /Mit Passwort schützen/ }).check()
}
