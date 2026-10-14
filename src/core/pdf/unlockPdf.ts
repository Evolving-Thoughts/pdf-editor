import { PDFDocument } from 'pdf-lib'

export class PasswordRequiredError extends Error {
  constructor() {
    super('Dieses PDF benötigt ein Passwort.')
    this.name = 'PasswordRequiredError'
  }
}
export class IncorrectPasswordError extends Error {
  constructor() {
    super('Das Passwort ist falsch. Erneut versuchen oder abbrechen.')
    this.name = 'IncorrectPasswordError'
  }
}
/** Ordinary files retain their exact bytes. Never ignore encryption in the editor. */
export async function preparePdf(bytes: Uint8Array): Promise<Uint8Array> {
  const probe = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  if (probe.isEncrypted) throw new PasswordRequiredError()
  return bytes
}
/** Decrypt only a local working copy. The caller must disclose that draft/export
 * are unencrypted. No credential is stored in the model or persistence layer.
 * The fork is isolated here; the rest of the editor still uses upstream pdf-lib. */
export async function unlockPdf(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  try {
    const { PDFDocument: DecryptDocument } = await import('@cantoo/pdf-lib')
    const doc = await DecryptDocument.load(bytes.slice(), {
      password,
      updateMetadata: false,
      preserveXFA: true,
    })
    // Parsing decrypts strings, streams and object streams. Remove only the
    // encryption dictionary from the output trailer, not forms or appearances.
    doc.context.trailerInfo.Encrypt = undefined
    return await doc.save({ updateFieldAppearances: false })
  } catch (error) {
    if (error instanceof Error && /password incorrect/i.test(error.message))
      throw new IncorrectPasswordError()
    throw new Error(
      'Dieses PDF konnte nicht entschlüsselt werden. Die Datei ist beschädigt oder verwendet ein nicht unterstütztes Schutzverfahren.',
      { cause: error },
    )
  }
}

/** Optional protected export. No password is added to any editor/draft data. */
export async function encryptPdf(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (!password.length)
    throw new Error('Bitte ein nicht leeres Export-Passwort eingeben.')
  try {
    const { PDFDocument: EncryptDocument } = await import('@cantoo/pdf-lib')
    const doc = await EncryptDocument.load(bytes.slice(), {
      updateMetadata: false,
      preserveXFA: true,
    })
    doc.encrypt({
      userPassword: password,
      ownerPassword: password,
      algorithm: 'AES-256',
      permissions: {
        printing: 'highResolution',
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      },
    })
    return await doc.save({ updateFieldAppearances: false })
  } catch (error) {
    throw new Error(
      'Der passwortgeschützte Export ist fehlgeschlagen. Es wurde keine Datei heruntergeladen. PDF/A-Dateien erlauben keine Verschlüsselung.',
      { cause: error },
    )
  }
}
