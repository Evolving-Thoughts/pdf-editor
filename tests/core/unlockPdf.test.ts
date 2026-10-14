import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  preparePdf,
  unlockPdf,
  PasswordRequiredError,
} from '../../src/core/pdf/unlockPdf'
const fixtures = JSON.parse(
  readFileSync(
    new URL('../pdfEncryptionFixtures.json', import.meta.url),
    'utf8',
  ),
).pdfs as Record<string, string>
for (const algorithm of ['aes256', 'aes128', 'rc4', 'objects']) {
  const input = new Uint8Array(Buffer.from(fixtures[algorithm], 'base64'))
  it(`${algorithm}: requires a password and rejects wrong credentials`, async () => {
    await expect(preparePdf(input)).rejects.toBeInstanceOf(
      PasswordRequiredError,
    )
    await expect(unlockPdf(input, 'wrong')).rejects.toThrow('Passwort')
  })
  it(`${algorithm}: produces a plaintext working copy with editable fields, without changing the input`, async () => {
    const before = input.slice(),
      result = await unlockPdf(input, 'demo')
    const doc = await PDFDocument.load(result)
    expect(doc.isEncrypted).toBe(false)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getForm().getTextField('Name').getText()).toBe('Ada')
    doc.getForm().getTextField('Name').setText('Grace')
    expect(
      (await PDFDocument.load(await doc.save()))
        .getForm()
        .getTextField('Name')
        .getText(),
    ).toBe('Grace')
    expect(input).toEqual(before)
  })
}
it('keeps unencrypted files intact, rejects malformed inputs separately', async () => {
  const doc = await PDFDocument.create()
  doc.addPage()
  const bytes = await doc.save()
  expect(await preparePdf(bytes)).toEqual(bytes)
  await expect(
    preparePdf(new Uint8Array([1, 2, 3])),
  ).rejects.not.toBeInstanceOf(PasswordRequiredError)
})

import { encryptPdf } from '../../src/core/pdf/unlockPdf'
it('encrypts export with AES-256, retains editable forms, and does not mutate plaintext', async () => {
  const plain = await unlockPdf(
    new Uint8Array(Buffer.from(fixtures.aes256, 'base64')),
    'demo',
  )
  const before = plain.slice(),
    encrypted = await encryptPdf(plain, 'export-demo')
  await expect(preparePdf(encrypted)).rejects.toBeInstanceOf(
    PasswordRequiredError,
  )
  await expect(unlockPdf(encrypted, 'wrong')).rejects.toThrow('Passwort')
  const reopened = await PDFDocument.load(
    await unlockPdf(encrypted, 'export-demo'),
  )
  expect(reopened.getForm().getTextField('Name').getText()).toBe('Ada')
  expect(plain).toEqual(before)
  await expect(encryptPdf(plain, '')).rejects.toThrow('Passwort')
})

it('accepts an explicit empty opening password and an owner password', async () => {
  const empty = new Uint8Array(Buffer.from(fixtures.empty, 'base64'))
  expect(
    (await PDFDocument.load(await unlockPdf(empty, '')))
      .getForm()
      .getTextField('Name')
      .getText(),
  ).toBe('Ada')
  const owner = new Uint8Array(Buffer.from(fixtures.aes256, 'base64'))
  expect(
    (
      await PDFDocument.load(await unlockPdf(owner, 'owner-demo'))
    ).getPageCount(),
  ).toBe(1)
})
it('does not retain the original encryption dictionary or password verifier in the plaintext copy', async () => {
  const input = new Uint8Array(Buffer.from(fixtures.aes256, 'base64'))
  const doc = await PDFDocument.load(await unlockPdf(input, 'demo'))
  expect(
    doc.context
      .enumerateIndirectObjects()
      .some(([, object]) => object.toString().includes('/Filter /Standard')),
  ).toBe(false)
})
